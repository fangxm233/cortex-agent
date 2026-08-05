# input:  trial policy, HTTP requests, one provider adapter, one fixed upstream
# output: per-trial proxy handle with revocable route
# pos:    Proxy admission and lifecycle core
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hmac
import json
import os
import secrets
import socket
import threading
from datetime import UTC, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Mapping, cast
from urllib.parse import urlsplit

from .adapters.base import AuthInjectionUnavailable, Billable, ProviderAdapter
from .models import ProxyBudget, ProxyMetadata, ProxyUsage, decimal_text, utc_text
from .upstream import (
    HOP_HEADERS,
    FixedUpstream,
    UpstreamAttemptError,
    UpstreamResult,
    validate_upstream,
)


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
        self.expired = False
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
        return self.expired or datetime.now(UTC) >= self.deadline.astimezone(UTC)

    def remaining_seconds(self) -> float:
        remaining = self.deadline.astimezone(UTC) - datetime.now(UTC)
        return max(remaining.total_seconds(), 0.001)

    def reserve(self) -> None:
        self.budget_consumed_usd += self.budget.max_request_cost_usd

    def expire(self) -> None:
        self.expired = True

    def deactivate(self) -> None:
        self.active = False

    def _caller_error(self, source_ip: str, authorization: str | None):
        if source_ip != self.source_ip:
            return 403, "source_rejected"
        expected = f"Bearer {self.dummy_token}"
        if authorization is None or not hmac.compare_digest(authorization, expected):
            return 401, "dummy_token_rejected"
        return None

    def record(self, usage: ProxyUsage, billable: Billable | None) -> str | None:
        if not usage.accounted or billable is None:
            error = self.record_attempt(
                "budget_accounting_unavailable", True, usage.upstream_model)
            self.active = False
            return error or "budget_accounting_unavailable"
        request_cost = self.budget.cost(billable.input_tokens, billable.output_tokens)
        outcome = self._usage_outcome(request_cost)
        record = self._usage_record(usage, request_cost, outcome)
        if not self._persist(record):
            return "audit_log_unavailable"
        self._commit_usage(usage, request_cost)
        if outcome is not None:
            self.active = False
        return outcome

    def record_attempt(
        self, outcome: str, retain_reservation: bool,
        upstream_model: str | None = None,
    ) -> str | None:
        error = self._record_outcome(outcome, upstream_model)
        if error is not None:
            return error
        if not retain_reservation:
            self.budget_consumed_usd -= self.budget.max_request_cost_usd
        return None

    def record_rejection(self, outcome: str) -> str | None:
        # A route or body refusal never reserved, so it must not touch budget
        # arithmetic: releasing an absent reservation would drive the consumed
        # total negative.
        return self._record_outcome(outcome, None)

    def _record_outcome(self, outcome: str, upstream_model: str | None) -> str | None:
        record = self._attempt_record(outcome, upstream_model)
        if not self._persist(record):
            return "audit_log_unavailable"
        self.request_count += 1
        return None

    def _usage_outcome(self, request_cost: Decimal) -> str | None:
        if request_cost > self.budget.max_request_cost_usd:
            return "budget_accounting_exceeded"
        return None

    def _usage_record(
        self, usage: ProxyUsage, request_cost: Decimal, outcome: str | None,
    ) -> dict[str, object]:
        record = self._record(
            self.request_count + 1, self.input_tokens + usage.input_tokens,
            self.output_tokens + usage.output_tokens, self.cost_usd + request_cost,
            usage.upstream_model,
        )
        if outcome is not None:
            record["outcome"] = outcome
        return record

    def _attempt_record(
        self, outcome: str, upstream_model: str | None,
    ) -> dict[str, object]:
        record = self._record(
            self.request_count + 1, self.input_tokens, self.output_tokens,
            self.cost_usd, upstream_model,
        )
        record["outcome"] = outcome
        return record

    def _record(
        self, count: int, input_tokens: int, output_tokens: int,
        cost_usd: Decimal, upstream_model: str | None,
    ) -> dict[str, object]:
        return {
            "request_count": count,
            "tokens": {"input": input_tokens, "output": output_tokens,
                       "total": input_tokens + output_tokens},
            "cost_usd": decimal_text(cost_usd),
            "upstream_model": upstream_model,
        }

    def _persist(self, record: Mapping[str, object]) -> bool:
        try:
            _append_log(self.log_path, record)
            return True
        except OSError:
            self.active = False
            return False

    def _commit_usage(self, usage: ProxyUsage, request_cost: Decimal) -> None:
        self.request_count += 1
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens
        self.cost_usd += request_cost


class TrialHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self, address: tuple[str, int], state: ProxyState, upstream: FixedUpstream,
        adapter: ProviderAdapter,
    ) -> None:
        self.state = state
        self.upstream = upstream
        self.adapter = adapter
        self._client_condition = threading.Condition()
        self._clients: set[socket.socket] = set()
        self._body_clients: set[socket.socket] = set()
        super().__init__(address, TrialProxyHandler)

    @property
    def active_client_count(self) -> int:
        with self._client_condition:
            return len(self._clients)

    @property
    def body_client_count(self) -> int:
        with self._client_condition:
            return len(self._body_clients)

    def register_client(self, client: socket.socket) -> None:
        with self._client_condition:
            self._clients.add(client)

    def unregister_client(self, client: socket.socket) -> None:
        with self._client_condition:
            self._clients.discard(client)
            self._body_clients.discard(client)
            self._client_condition.notify_all()

    def mark_body_read(self, client: socket.socket, active: bool) -> None:
        with self._client_condition:
            target = self._body_clients.add if active else self._body_clients.discard
            target(client)

    def expire_route(self) -> None:
        self.state.expire()
        self.upstream.deactivate()
        self._shutdown_clients(self._body_clients, socket.SHUT_RD, close=False)

    def close_active_clients(self) -> None:
        self.upstream.deactivate()
        self._shutdown_clients(self._clients, socket.SHUT_RDWR, close=True)

    def wait_for_no_clients(self, timeout: float) -> bool:
        with self._client_condition:
            return self._client_condition.wait_for(lambda: not self._clients, timeout)

    def _shutdown_clients(
        self, selected: set[socket.socket], how: int, *, close: bool,
    ) -> None:
        with self._client_condition:
            clients = tuple(selected)
        for client in clients:
            try:
                client.shutdown(how)
                if close:
                    client.close()
            except OSError:
                continue

    def handle_error(self, _request: object, _client_address: object) -> None:
        return


class TrialProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self) -> None:
        server = cast(TrialHttpServer, self.server)
        server.register_client(self.request)
        try:
            super().handle()
        finally:
            server.unregister_client(self.request)

    def do_POST(self) -> None:
        server = cast(TrialHttpServer, self.server)
        error = self._admission_error(server.state)
        if error is not None:
            self._send_error(*error)
            return
        if not _valid_request_target(self.path):
            self._send_error(400, "invalid_request_target")
            return
        route = server.adapter.validate_route("POST", self.path)
        if not route.allow or route.route_id is None:
            self._refuse(server.state, 403, "route_not_allowed",
                         route.reason or "route_not_allowed")
            return
        body = self._read_body(server)
        if body is None:
            return
        decision = server.adapter.validate_body(route.route_id, body)
        if not decision.allow:
            self._refuse(server.state, 400, "request_model_rejected",
                         decision.reason or "request_model_rejected")
            return
        self._forward_reserved(server, body, route.route_id)

    def _refuse(
        self, state: ProxyState, status: int, wire_reason: str, audit_outcome: str,
    ) -> None:
        with state.request_lock:
            audit_error = state.record_rejection(audit_outcome)
        if audit_error is not None:
            self._send_error(500, audit_error)
            return
        self._send_error(status, wire_reason)

    def _forward_reserved(
        self, server: TrialHttpServer, body: bytes, route_id: str,
    ) -> None:
        with server.state.request_lock:
            error = server.state.admission_error(
                self.client_address[0], self.headers.get("authorization"))
            if error is not None:
                self._send_error(*error)
                return
            server.state.reserve()
            self._forward(server, body, route_id)

    def _admission_error(self, state: ProxyState):
        with state.request_lock:
            return state.admission_error(
                self.client_address[0], self.headers.get("authorization"))

    def _forward(self, server: TrialHttpServer, body: bytes, route_id: str) -> None:
        try:
            response = server.upstream.request(
                self.path, dict(self.headers.items()), body,
                server.state.remaining_seconds(), route_id,
            )
        except AuthInjectionUnavailable:
            self._handle_auth_failure(server.state)
            return
        except UpstreamAttemptError as error:
            self._handle_upstream_failure(server.state, error)
            return
        except ValueError:
            self._handle_upstream_failure(server.state, UpstreamAttemptError(False))
            return
        self._finish_response(server, response)

    def _handle_auth_failure(self, state: ProxyState) -> None:
        audit_error = state.record_attempt("auth_injection_unavailable", False)
        if audit_error is not None:
            self._send_error(500, audit_error)
            return
        self._send_error(502, "auth_injection_unavailable")

    def _handle_upstream_failure(
        self, state: ProxyState, failure: UpstreamAttemptError,
    ) -> None:
        lifecycle_error = state.lifecycle_error()
        outcome = lifecycle_error[1] if lifecycle_error else "upstream_unavailable"
        audit_error = state.record_attempt(
            outcome, failure.may_have_reached_upstream)
        if audit_error is not None:
            self._send_error(500, audit_error)
            return
        self._send_error(*(lifecycle_error or (502, "upstream_unavailable")))

    def _finish_response(
        self, server: TrialHttpServer, response: UpstreamResult,
    ) -> None:
        state = server.state
        billable = (
            server.adapter.billable(response.usage) if response.usage.accounted else None
        )
        accounting_error = state.record(response.usage, billable)
        if accounting_error is not None:
            status = 500 if accounting_error == "audit_log_unavailable" else 502
            self._send_error(status, accounting_error)
            return
        lifecycle_error = state.lifecycle_error()
        if lifecycle_error is not None:
            self._send_error(*lifecycle_error)
            return
        self._send_upstream(response)

    def _read_body(self, server: TrialHttpServer) -> bytes | None:
        length = self._content_length()
        if length is None:
            return None
        server.mark_body_read(self.connection, True)
        self.connection.settimeout(server.state.remaining_seconds())
        try:
            body = self.rfile.read(length)
        except OSError:
            self._send_error(*(server.state.lifecycle_error() or (408, "request_body_timeout")))
            return None
        finally:
            server.mark_body_read(self.connection, False)
        if len(body) != length:
            self._send_error(*(server.state.lifecycle_error() or (400, "request_body_incomplete")))
            return None
        return body

    def _content_length(self) -> int | None:
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            self._send_error(400, "content_length_required")
            return None
        if length < 0:
            self._send_error(400, "content_length_required")
            return None
        return length

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
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            pass
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
            self._server.close_active_clients()
            self._server.shutdown()
            self._server.server_close()
            self._thread.join(timeout=2)
            if not self._server.wait_for_no_clients(2):
                raise RuntimeError("proxy client handlers did not stop")
            self._stopped = True


def start_trial_proxy(
    *, trial_id: str, upstream_base_url: str, adapter: ProviderAdapter,
    bound_source_ip: str, absolute_deadline: datetime, budget: ProxyBudget,
    log_path: Path, listen_host: str = "127.0.0.1",
    advertised_host: str | None = None,
) -> TrialProxyHandle:
    _validate_inputs(trial_id, upstream_base_url, adapter, absolute_deadline)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    dummy_token = _dummy_token(adapter)
    state = ProxyState(bound_source_ip, dummy_token, absolute_deadline, budget, log_path)
    upstream = FixedUpstream(upstream_base_url, adapter)
    server = TrialHttpServer((listen_host, 0), state, upstream, adapter)
    host = advertised_host or cast(tuple[str, int], server.server_address)[0]
    port = cast(tuple[str, int], server.server_address)[1]
    metadata = ProxyMetadata(
        trial_id, upstream_base_url, bound_source_ip, absolute_deadline,
        budget, log_path.name, adapter.adapter_id,
    )
    deadline_timer = threading.Timer(
        _deadline_delay(absolute_deadline), server.expire_route,
    )
    deadline_timer.daemon = True
    deadline_timer.start()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return TrialProxyHandle(
        f"http://{host}:{port}", dummy_token, metadata, server, thread,
        deadline_timer,
    )


def _dummy_token(adapter: ProviderAdapter) -> str:
    # Some clients decode the credential locally before building a request, so an
    # opaque dummy makes them fail without emitting anything — a silence a proxy
    # cannot tell apart from containment. Such an adapter mints the dummy in the
    # shape its own client requires.
    mint = getattr(adapter, "mint_dummy_credential", None)
    return mint() if callable(mint) else f"dummy-{secrets.token_urlsafe(24)}"


def _validate_inputs(
    trial_id: str, upstream_base_url: str, adapter: ProviderAdapter,
    deadline: datetime,
) -> None:
    if not trial_id:
        raise ValueError("trial_id must be a non-empty string")
    host = validate_upstream(upstream_base_url).hostname
    if host not in adapter.upstream_hosts:
        raise ValueError(
            f"upstream host {host!r} is not declared by adapter {adapter.adapter_id}; "
            f"declared hosts: {list(adapter.upstream_hosts)}")
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
