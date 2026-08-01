# input:  trial policy, HTTP requests, and one fixed upstream
# output: per-trial proxy handle with revocable route
# pos:    Proxy admission and lifecycle core
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hmac
import json
import os
import secrets
import threading
from datetime import UTC, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Mapping, cast
from urllib.parse import urlsplit

from .models import ProxyBudget, ProxyMetadata, ProxyUsage, decimal_text, utc_text
from .upstream import HOP_HEADERS, FixedUpstream, UpstreamResult


class ProxyState:
    def __init__(
        self, source_ip: str, dummy_token: str, deadline: datetime,
        budget: ProxyBudget, log_path: Path,
    ) -> None:
        self.source_ip = source_ip
        self.dummy_token = dummy_token
        self.deadline = deadline
        self.budget = budget
        self.log_path = log_path
        self.request_lock = threading.Lock()
        self.active = True
        self.request_count = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = Decimal("0")
        self.budget_consumed_usd = Decimal("0")

    def admission_error(self, source_ip: str, authorization: str | None):
        lifecycle_error = self.lifecycle_error()
        if lifecycle_error is not None:
            return lifecycle_error
        caller_error = self._caller_error(source_ip, authorization)
        if caller_error is not None:
            return caller_error
        remaining = self.budget.max_cost_usd - self.budget_consumed_usd
        if remaining < self.budget.max_request_cost_usd:
            return 429, "budget_exhausted"
        return None

    def lifecycle_error(self):
        if not self.active:
            return 410, "route_revoked"
        if self.deadline_expired():
            return 410, "deadline_expired"
        return None

    def deadline_expired(self) -> bool:
        return datetime.now(UTC) >= self.deadline.astimezone(UTC)

    def remaining_seconds(self) -> float:
        remaining = self.deadline.astimezone(UTC) - datetime.now(UTC)
        return max(remaining.total_seconds(), 0.001)

    def reserve(self) -> None:
        self.budget_consumed_usd += self.budget.max_request_cost_usd

    def deactivate(self) -> None:
        self.active = False

    def _caller_error(self, source_ip: str, authorization: str | None):
        if source_ip != self.source_ip:
            return 403, "source_rejected"
        expected = f"Bearer {self.dummy_token}"
        if authorization is None or not hmac.compare_digest(authorization, expected):
            return 401, "dummy_token_rejected"
        return None

    def record(self, usage: ProxyUsage) -> str | None:
        if not usage.accounted:
            self.active = False
            return "budget_accounting_unavailable"
        request_cost = self.budget.cost(usage.input_tokens, usage.output_tokens)
        self._add_usage(usage, request_cost)
        if request_cost > self.budget.max_request_cost_usd:
            self.active = False
            return "budget_accounting_exceeded"
        return None

    def _add_usage(self, usage: ProxyUsage, request_cost: Decimal) -> None:
        self.request_count += 1
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens
        self.cost_usd += request_cost
        record = {
            "request_count": self.request_count,
            "tokens": {"input": self.input_tokens, "output": self.output_tokens,
                       "total": self.input_tokens + self.output_tokens},
            "cost_usd": decimal_text(self.cost_usd),
            "upstream_model": usage.upstream_model,
        }
        _append_log(self.log_path, record)


class TrialHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self, address: tuple[str, int], state: ProxyState, upstream: FixedUpstream,
    ) -> None:
        self.state = state
        self.upstream = upstream
        super().__init__(address, TrialProxyHandler)


class TrialProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        server = cast(TrialHttpServer, self.server)
        with server.state.request_lock:
            error = server.state.admission_error(
                self.client_address[0], self.headers.get("authorization"))
            if error is not None:
                self._send_error(*error)
                return
            if not _valid_request_target(self.path):
                self._send_error(400, "invalid_request_target")
                return
            self._forward(server)

    def _forward(self, server: TrialHttpServer) -> None:
        body = self._read_body()
        if body is None or not self._reserve_if_live(server.state):
            return
        try:
            response = server.upstream.request(
                self.path, dict(self.headers.items()), body,
                server.state.remaining_seconds(),
            )
        except (OSError, ValueError):
            self._send_lifecycle_or_upstream_error(server.state)
            return
        self._finish_response(server.state, response)

    def _reserve_if_live(self, state: ProxyState) -> bool:
        error = state.lifecycle_error()
        if error is not None:
            self._send_error(*error)
            return False
        state.reserve()
        return True

    def _finish_response(self, state: ProxyState, response: UpstreamResult) -> None:
        accounting_error = state.record(response.usage)
        if accounting_error is not None:
            self._send_error(502, accounting_error)
            return
        lifecycle_error = state.lifecycle_error()
        if lifecycle_error is not None:
            self._send_error(*lifecycle_error)
            return
        self._send_upstream(response)

    def _send_lifecycle_or_upstream_error(self, state: ProxyState) -> None:
        error = state.lifecycle_error()
        self._send_error(*(error or (502, "upstream_unavailable")))

    def _read_body(self) -> bytes | None:
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            self._send_error(400, "content_length_required")
            return None
        if length < 0:
            self._send_error(400, "content_length_required")
            return None
        return self.rfile.read(length)

    def _send_upstream(self, response: UpstreamResult) -> None:
        self.send_response(response.status, response.reason)
        for key, value in response.headers:
            if key.lower() not in HOP_HEADERS:
                self.send_header(key, value)
        self.send_header("content-length", str(len(response.body)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(response.body)
        self.close_connection = True

    def _send_error(self, status: int, reason: str) -> None:
        payload = json.dumps({"error": reason}, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def do_GET(self) -> None:
        self._send_error(405, "method_not_allowed")

    def do_CONNECT(self) -> None:
        self._send_error(405, "method_not_allowed")

    def log_message(self, _format: str, *_args: object) -> None:
        return


class TrialProxyHandle:
    def __init__(
        self, base_url: str, dummy_token: str, metadata: ProxyMetadata,
        server: TrialHttpServer, thread: threading.Thread,
        deadline_timer: threading.Timer,
    ) -> None:
        self.base_url = base_url
        self.dummy_token = dummy_token
        self.trial_id = metadata.trial_id
        self._metadata = metadata
        self._server = server
        self._thread = thread
        self._deadline_timer = deadline_timer
        self._stop_lock = threading.Lock()
        self._stopped = False

    @property
    def manifest_block(self) -> dict[str, object]:
        return self._metadata.manifest_block(self.base_url)

    def stop(self) -> None:
        with self._stop_lock:
            if self._stopped:
                return
            self._deadline_timer.cancel()
            self._server.state.deactivate()
            self._server.upstream.deactivate()
            self._server.shutdown()
            self._server.server_close()
            self._thread.join(timeout=2)
            self._stopped = True


def start_trial_proxy(
    *, trial_id: str, upstream_base_url: str, real_credential: str,
    bound_source_ip: str, absolute_deadline: datetime, budget: ProxyBudget,
    log_path: Path, listen_host: str = "127.0.0.1",
    advertised_host: str | None = None,
) -> TrialProxyHandle:
    _validate_inputs(trial_id, real_credential, absolute_deadline)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    dummy_token = f"dummy-{secrets.token_urlsafe(24)}"
    state = ProxyState(bound_source_ip, dummy_token, absolute_deadline, budget, log_path)
    upstream = FixedUpstream(upstream_base_url, real_credential)
    server = TrialHttpServer((listen_host, 0), state, upstream)
    host = advertised_host or cast(tuple[str, int], server.server_address)[0]
    port = cast(tuple[str, int], server.server_address)[1]
    metadata = ProxyMetadata(
        trial_id, upstream_base_url, bound_source_ip, absolute_deadline,
        budget, log_path.name,
    )
    deadline_timer = threading.Timer(
        _deadline_delay(absolute_deadline), upstream.deactivate,
    )
    deadline_timer.daemon = True
    deadline_timer.start()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return TrialProxyHandle(
        f"http://{host}:{port}", dummy_token, metadata, server, thread,
        deadline_timer,
    )


def _validate_inputs(trial_id: str, credential: str, deadline: datetime) -> None:
    if not trial_id:
        raise ValueError("trial_id must be a non-empty string")
    if not credential or "\r" in credential or "\n" in credential:
        raise ValueError("real_credential must be a non-empty single line")
    utc_text(deadline)


def _deadline_delay(deadline: datetime) -> float:
    remaining = deadline.astimezone(UTC) - datetime.now(UTC)
    return max(remaining.total_seconds(), 0)


def _valid_request_target(target: str) -> bool:
    parsed = urlsplit(target)
    return not parsed.scheme and not parsed.netloc and parsed.path.startswith("/")


def _append_log(path: Path, record: Mapping[str, object]) -> None:
    line = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())
