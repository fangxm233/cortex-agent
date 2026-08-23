# input:  trial/retry policy, requests, provider adapter, fixed upstream
# output: proxy handle with usage, delivery outcomes and proven revocation evidence
# pos:    Proxy admission and lifecycle core
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hmac
import json
import secrets
import socket
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Mapping, cast
from urllib.parse import urlsplit

from .adapters.base import AuthInjectionUnavailable, ProviderAdapter
from .export import build_proxy_export
from .lease import LEASE_ECHO_TARGET, LeaseRefused, LeaseTerms, TrialLease
from .models import ProxyLimits, ProxyMetadata, ProxyUsage, utc_text
from .network_trace import RequestTrace, append_json_line
from .request_limit import SharedRequestLimit
from .upstream import (
    HOP_HEADERS,
    FixedUpstream,
    UpstreamAttemptError,
    UpstreamResult,
    validate_upstream,
)


def host_now_ms() -> int:
    """The host wall clock, as the single injectable read of it."""
    return time.time_ns() // 1_000_000


class ProxyState:
    def __init__(
        self, source_ip: str, dummy_token: str, deadline_ms: int,
        limits: ProxyLimits, log_path: Path, now_ms: Callable[[], int],
        *, allow_retry: bool = True,
        shared_request_limit: SharedRequestLimit | None = None,
    ) -> None:
        self.source_ip = source_ip
        self.dummy_token = dummy_token
        self.deadline_ms = deadline_ms
        self.now_ms = now_ms
        self.limits = limits
        self.log_path = log_path
        self.request_lock = threading.Lock()
        self.active = True
        self.expired = False
        self.request_count = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cached_tokens = 0
        # In-flight reservations count against the cap, replacing the old dollar-derived floor.
        self.reserved_requests = 0
        self.allow_retry = allow_retry
        self.shared_request_limit = shared_request_limit

    def admission_error(self, source_ip: str, authorization: str | None):
        lifecycle_error = self.lifecycle_error()
        if lifecycle_error is not None:
            return lifecycle_error
        caller_error = self.caller_error(source_ip, authorization)
        if caller_error is not None:
            return caller_error
        attempts = self.request_count + self.reserved_requests
        if self.reserved_requests >= self.limits.max_requests:
            return 429, "requests_exhausted"
        if not self.allow_retry and attempts >= 1:
            return 429, "requests_exhausted"
        return None

    def lifecycle_error(self):
        if not self.active:
            return 410, "route_revoked"
        if self.deadline_expired():
            return 410, "deadline_expired"
        return None

    def deadline_expired(self) -> bool:
        return self.expired or self.now_ms() >= self.deadline_ms

    def remaining_seconds(self) -> float:
        return max((self.deadline_ms - self.now_ms()) / 1000, 0.001)

    def set_deadline_ms(self, epoch_ms: int) -> None:
        self.deadline_ms = epoch_ms

    def record_lease(self, entry: Mapping[str, object]) -> bool:
        return self._persist(entry)

    def record_delivery(self, outcome: str) -> bool:
        """Record delivery without changing metered totals or route lifecycle.

        A client may abandon one response and still ask for another, so this never revokes.
        """
        return self._persist({
            "event": "delivery", "outcome": outcome,
            "request_count_at": self.request_count,
        })

    def reserve(self) -> bool:
        if self.shared_request_limit is not None and not self.shared_request_limit.reserve():
            return False
        self.reserved_requests += 1
        return True

    def expire(self) -> None:
        self.expired = True

    def deactivate(self) -> None:
        self.active = False

    def caller_error(self, source_ip: str, authorization: str | None):
        if source_ip != self.source_ip:
            return 403, "source_rejected"
        expected = f"Bearer {self.dummy_token}"
        if authorization is None or not hmac.compare_digest(authorization, expected):
            return 401, "dummy_token_rejected"
        return None

    def record(self, usage: ProxyUsage) -> str | None:
        """Meter one answered request. Unaccounted usage still ends the route.

        There is no longer a per-request outcome to derive here. The check this replaces refused a
        request whose PRICED cost exceeded one reservation, which is a judgement about a number the
        proxy computed rather than one it observed - and the pricing that produced it was wrong by
        12.7x on cached traffic. What physically bounds one request is declared elsewhere and
        enforced by things that can actually see it: the request and response body limits, and the
        provider's own `max_output_tokens`.
        """
        if not usage.accounted:
            error = self.record_attempt(
                "usage_accounting_unavailable", True, usage.upstream_model,
                usage.diagnostic_code,
            )
            self.active = False
            return error or "usage_accounting_unavailable"
        if not self._persist(self._usage_record(usage)):
            return "audit_log_unavailable"
        self._commit_usage(usage)
        return None

    def record_attempt(
        self, outcome: str, retain_reservation: bool,
        upstream_model: str | None = None, diagnostic_code: str | None = None,
    ) -> str | None:
        error = self._record_outcome(outcome, upstream_model, diagnostic_code)
        if error is not None:
            return error
        if not retain_reservation:
            self.reserved_requests -= 1
            if self.shared_request_limit is not None:
                self.shared_request_limit.release()
        return None

    def record_rejection(self, outcome: str) -> str | None:
        # A route or body refusal never reserved, so it must not touch the reservation
        # count: releasing an absent reservation would drive it negative.
        return self._record_outcome(outcome, None)

    def _record_outcome(
        self, outcome: str, upstream_model: str | None,
        diagnostic_code: str | None = None,
    ) -> str | None:
        record = self._attempt_record(outcome, upstream_model, diagnostic_code)
        if not self._persist(record):
            return "audit_log_unavailable"
        self.request_count += 1
        return None

    def _usage_record(self, usage: ProxyUsage) -> dict[str, object]:
        return self._record(
            self.request_count + 1, self.input_tokens + usage.input_tokens,
            self.output_tokens + usage.output_tokens,
            _add_cached(self.cached_tokens, usage.cached_tokens),
            usage.upstream_model,
        )

    def _attempt_record(
        self, outcome: str, upstream_model: str | None,
        diagnostic_code: str | None = None,
    ) -> dict[str, object]:
        record = self._record(
            self.request_count + 1, self.input_tokens, self.output_tokens,
            self.cached_tokens, upstream_model,
        )
        record["outcome"] = outcome
        if diagnostic_code is not None:
            record["diagnostic_code"] = diagnostic_code
        return record

    def _record(
        self, count: int, input_tokens: int, output_tokens: int,
        cached_tokens: int | None, upstream_model: str | None,
    ) -> dict[str, object]:
        return {
            "request_count": count,
            "tokens": {"input": input_tokens, "output": output_tokens,
                       "total": input_tokens + output_tokens,
                       "cached": cached_tokens},
            "upstream_model": upstream_model,
        }

    def _persist(self, record: Mapping[str, object]) -> bool:
        try:
            append_json_line(self.log_path, record, durable=True)
            return True
        except OSError:
            self.active = False
            return False

    def _commit_usage(self, usage: ProxyUsage) -> None:
        self.request_count += 1
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens
        self.cached_tokens = _add_cached(self.cached_tokens, usage.cached_tokens)


class TrialHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    # Assigned by `start_trial_proxy` before the serve thread starts; the lease needs this server
    # to revoke the route, so it cannot be built inside the constructor.
    lease: TrialLease

    def __init__(
        self, address: tuple[str, int], state: ProxyState, upstream: FixedUpstream,
        adapter: ProviderAdapter, request_body_limit_bytes: int | None,
    ) -> None:
        self.state = state
        self.upstream = upstream
        self.adapter = adapter
        self.request_body_limit_bytes = request_body_limit_bytes
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


class RelaySink:
    """Streams upstream chunks before completion without weakening accounting refusal.

    The zero chunk is written only after accounting accepts the response. A later refusal
    withholds it, so the client observes a truncated stream rather than a complete answer.
    """

    def __init__(
        self, handler: "TrialProxyHandler", trace: RequestTrace | None,
    ) -> None:
        self._handler = handler
        self._trace = trace
        self.started = False
        # A write that fails because the client vanished is a client fact. It must not be
        # raised through the upstream read, where it would be audited as an upstream failure
        # and make the proxy's own record disagree with what the provider billed.
        self.client_failed = False

    @property
    def trace(self) -> RequestTrace | None: return self._trace

    def begin(
        self, status: int, reason: str, headers: tuple[tuple[str, str], ...],
    ) -> None:
        self.started = True
        try:
            self._handler.send_response(status, reason)
            for key, value in headers:
                if key.lower() not in HOP_HEADERS:
                    self._handler.send_header(key, value)
            self._handler.send_header("transfer-encoding", "chunked")
            self._handler.send_header("connection", "close")
            self._handler.end_headers()
        except OSError:
            self.client_failed = True
            if self._trace is not None:
                self._trace.downstream_failed()

    def relay(self, chunk: bytes) -> None:
        self._write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")

    def finish(self) -> None:
        self._write(b"0\r\n\r\n")
        if self._trace is not None and not self.client_failed:
            self._trace.downstream_returned()

    def _write(self, payload: bytes) -> None:
        if self.client_failed:
            return
        try:
            self._handler.wfile.write(payload)
            self._handler.wfile.flush()
        except OSError:
            self.client_failed = True
            if self._trace is not None:
                self._trace.downstream_failed()


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
        # The lease-echo control route is matched before the adapter's route allow-list and is
        # answered here; it is never forwarded upstream.
        if _is_lease_echo_target(self.path):
            self._handle_lease_echo(server)
            return
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

    def _handle_lease_echo(self, server: TrialHttpServer) -> None:
        # Authenticated exactly as a model call is. Budget and lifecycle are not authentication:
        # a route that already expired or stopped refuses the echo as `lease_echo_after_terminal`,
        # and is never re-armed.
        error = self._caller_admission(server.state)
        if error is not None:
            self._send_error(*error)
            return
        body = self._read_body(server)
        if body is None:
            return
        try:
            self._send_json(200, server.lease.apply_echo(body))
        except LeaseRefused as refusal:
            self._send_error(refusal.status, refusal.reason)

    def _caller_admission(self, state: ProxyState):
        with state.request_lock:
            return state.caller_error(
                self.client_address[0], self.headers.get("authorization"))

    def _refuse(
        self, state: ProxyState, status: int, wire_reason: str, audit_outcome: str,
    ) -> None:
        with state.request_lock:
            audit_error = state.record_rejection(audit_outcome)
        if audit_error is not None:
            self._send_error(500, audit_error)
            return
        self._send_error(status, wire_reason, retryable=False)

    def _forward_reserved(
        self, server: TrialHttpServer, body: bytes, route_id: str,
    ) -> None:
        with server.state.request_lock:
            error = server.state.admission_error(
                self.client_address[0], self.headers.get("authorization"))
            if error is not None:
                self._send_error(*error)
                return
            if not server.state.reserve():
                self._send_error(429, "suite_requests_exhausted")
                return
            self._forward(server, body, route_id)

    def _admission_error(self, state: ProxyState):
        with state.request_lock:
            return state.admission_error(
                self.client_address[0], self.headers.get("authorization"))

    def _forward(self, server: TrialHttpServer, body: bytes, route_id: str) -> None:
        trace = server.upstream.start_request_trace()
        sink = RelaySink(self, trace)
        try:
            response = server.upstream.request(
                self.path, dict(self.headers.items()), body,
                server.state.remaining_seconds(), route_id, sink, trace,
            )
        except AuthInjectionUnavailable:
            self._handle_auth_failure(server.state, sink)
            return
        except UpstreamAttemptError as error:
            self._handle_upstream_failure(server.state, error, sink)
            return
        except ValueError:
            self._handle_upstream_failure(
                server.state, UpstreamAttemptError(False), sink)
            return
        self._finish_response(server, response, sink)

    def _handle_auth_failure(self, state: ProxyState, sink: RelaySink) -> None:
        audit_error = state.record_attempt("auth_injection_unavailable", False)
        outcome = audit_error or "auth_injection_unavailable"
        if sink.trace is not None:
            sink.trace.terminal(outcome)
        self._refuse_response(sink, 500 if audit_error else 502, outcome)

    def _handle_upstream_failure(
        self, state: ProxyState, failure: UpstreamAttemptError, sink: RelaySink,
    ) -> None:
        lifecycle_error = state.lifecycle_error()
        outcome = lifecycle_error[1] if lifecycle_error else failure.reason
        audit_error = state.record_attempt(
            outcome, failure.may_have_reached_upstream)
        if sink.trace is not None:
            sink.trace.terminal(audit_error or outcome)
        if failure.reason == "upstream_response_too_large":
            state.deactivate()
        if audit_error is not None:
            self._refuse_response(sink, 500, audit_error)
            return
        self._refuse_response(sink, *(lifecycle_error or (502, "upstream_unavailable")))

    def _finish_response(
        self, server: TrialHttpServer, response: UpstreamResult, sink: RelaySink,
    ) -> None:
        state = server.state
        accounting_error = state.record(response.usage)
        if accounting_error is not None:
            if sink.trace is not None:
                sink.trace.terminal(accounting_error)
            status = 500 if accounting_error == "audit_log_unavailable" else 502
            self._refuse_response(sink, status, accounting_error)
            return
        lifecycle_error = state.lifecycle_error()
        if lifecycle_error is not None:
            if sink.trace is not None:
                sink.trace.terminal(lifecycle_error[1])
            self._refuse_response(sink, *lifecycle_error)
            return
        sink.finish()
        if sink.trace is not None:
            sink.trace.terminal("ok")
        self._record_delivery(state, sink)
        self.close_connection = True

    def _record_delivery(self, state: ProxyState, sink: RelaySink) -> None:
        """A response can be generated, billed, and still never reach the client.

        The 2026-08-13 paid run lost 7 of 16 responses that way — $0.011662 of $0.02744182, 42.5%
        of the spend — because the proxy withheld each body until the upstream finished and the
        client's own read deadline fired first. Streaming removed the cause; this removes the
        blindness. Without it the proxy's record and the provider's bill agree perfectly while
        saying nothing about whether the trial ever got what it paid for.
        """
        # `_forward_reserved` holds `request_lock` across the whole forward, and the lock is not
        # reentrant, so this records under the caller's lock exactly as `state.record` does.
        if sink.client_failed:
            state.record_delivery("client_gone_after_accounting")

    def _refuse_response(self, sink: RelaySink, status: int, reason: str) -> None:
        """Refuse a request whose response may already be on the wire.

        A refusal that arrives before the first byte keeps its exact status and reason. One
        that arrives after keeps only its effect: the audit row, any route deactivation, and
        an unterminated stream the client cannot read as a complete answer.
        """
        if sink.started:
            self.close_connection = True
            return
        self._send_error(status, reason)

    def _read_body(self, server: TrialHttpServer) -> bytes | None:
        length = self._content_length()
        if length is None:
            return None
        limit = server.request_body_limit_bytes
        if limit is not None and length > limit:
            self._send_error(413, "request_body_too_large")
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

    def _send_error(self, status: int, reason: str, *, retryable: bool | None = None) -> None:
        self._send_json(status, {"error": reason}, retryable=retryable)

    def _send_json(self, status: int, document: Mapping[str, object], *, retryable: bool | None = None) -> None:
        payload = json.dumps(document, separators=(",", ":")).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.send_header("connection", "close")
            if retryable is not None:
                self.send_header("x-should-retry", str(retryable).lower())
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
        server: TrialHttpServer, thread: threading.Thread, lease: TrialLease,
    ) -> None:
        self.base_url = base_url
        self.dummy_token = dummy_token
        self.trial_id = metadata.trial_id
        self._metadata = metadata
        self._server = server
        self._thread = thread
        self._lease = lease
        # The lease owns the lock, so a re-arm and a stop cannot interleave.
        self._stop_lock = lease.lock
        self._stopped = False
        self._revocation_evidence: dict[str, object] | None = None

    @property
    def manifest_block(self) -> dict[str, object]:
        return self._metadata.manifest_block(self.base_url)

    @property
    def lease_echo_record(self) -> dict[str, object]:
        return self._lease.record

    @property
    def network_trace_complete(self) -> bool:
        return self._server.upstream.network_trace_complete

    @property
    def accounting_export(self) -> dict[str, object]:
        """The A1 side of the accounting record, after handler freeze."""
        return build_proxy_export(
            trial_id=self._metadata.trial_id, adapter_id=self._metadata.adapter_id,
            counters=self._server.state, log_path=self._server.state.log_path,
            lease_echo=self.lease_echo_record,
        )

    @property
    def final_accounting_export(self) -> dict[str, object]:
        with self._stop_lock:
            if self._stopped:
                raise RuntimeError("proxy was stopped before final accounting")
            self._lease.stop()
            self._server.state.deactivate()
            self._server.shutdown()
            self._thread.join(timeout=2)
            self._server.close_active_clients()
            if self._thread.is_alive() or not self._server.wait_for_no_clients(2):
                raise RuntimeError("proxy handlers did not quiesce for final accounting")
            if self._server.body_client_count != 0:
                raise RuntimeError("proxy body handlers did not quiesce for final accounting")
            return self.accounting_export

    @property
    def revocation_evidence(self) -> dict[str, object]:
        if self._revocation_evidence is None:
            raise RuntimeError("proxy revocation has not been proven")
        return dict(self._revocation_evidence)

    def stop(self) -> None:
        with self._stop_lock:
            if self._stopped:
                return
            self._stop_route()
            evidence = self._revocation_record()
            if not self._revocation_proven(evidence):
                raise RuntimeError("proxy revocation could not prove every handler absent")
            self._revocation_evidence = evidence
            self._stopped = True

    def _stop_route(self) -> None:
        self._lease.stop()
        self._server.state.deactivate()
        self._server.close_active_clients()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
        if not self._server.wait_for_no_clients(2):
            raise RuntimeError("proxy client handlers did not stop")
        self._server.upstream.clear_credential()
        self._server.upstream.finalize_trace()

    def _revocation_record(self) -> dict[str, object]:
        return {
            "schema_version": "cortex-bench-proxy-revocation/1",
            "trial_id": self.trial_id,
            "route_active": self._server.state.active,
            "listener_present": self._server.socket.fileno() >= 0,
            "serving_thread_alive": self._thread.is_alive(),
            "active_handlers": self._server.active_client_count,
            "body_handlers": self._server.body_client_count,
        }

    @staticmethod
    def _revocation_proven(evidence: Mapping[str, object]) -> bool:
        return (
            evidence.get("route_active") is False
            and evidence.get("listener_present") is False
            and evidence.get("serving_thread_alive") is False
            and evidence.get("active_handlers") == 0
            and evidence.get("body_handlers") == 0
        )


def start_trial_proxy(
    *, trial_id: str, upstream_base_url: str, adapter: ProviderAdapter,
    bound_source_ip: str, absolute_deadline: datetime, limits: ProxyLimits,
    log_path: Path, lease_terms: LeaseTerms, listen_host: str = "127.0.0.1",
    advertised_host: str | None = None, now_ms: Callable[[], int] = host_now_ms,
    request_body_limit_bytes: int | None = None,
    response_body_limit_bytes: int | None = None, allow_retry: bool = True,
    network_trace_path: Path | None = None,
    network_trace_progress_interval_seconds: float = 10,
    shared_request_limit: SharedRequestLimit | None = None,
) -> TrialProxyHandle:
    """Start one per-trial proxy under its provisional deadline bound."""
    _validate_inputs(trial_id, upstream_base_url, adapter, absolute_deadline)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    base_url, dummy_token, provisional_bound_ms, server, metadata = _proxy_runtime(
        trial_id, upstream_base_url, adapter, bound_source_ip, absolute_deadline,
        limits, log_path, listen_host, advertised_host, now_ms,
        request_body_limit_bytes, response_body_limit_bytes, allow_retry,
        network_trace_path, network_trace_progress_interval_seconds,
        shared_request_limit,
    )
    lease = TrialLease(
        trial_id=trial_id, state=server.state, server=server,
        provisional_bound_ms=provisional_bound_ms, terms=lease_terms, now_ms=now_ms,
    )
    server.lease = lease
    lease.arm_provisional_bound()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return TrialProxyHandle(base_url, dummy_token, metadata, server, thread, lease)


def _proxy_runtime(
    trial_id: str, upstream_base_url: str, adapter: ProviderAdapter,
    bound_source_ip: str, absolute_deadline: datetime, limits: ProxyLimits,
    log_path: Path, listen_host: str, advertised_host: str | None,
    now_ms: Callable[[], int], request_body_limit_bytes: int | None,
    response_body_limit_bytes: int | None, allow_retry: bool, network_trace_path: Path | None,
    trace_progress_seconds: float, shared_request_limit: SharedRequestLimit | None,
) -> tuple[str, str, int, TrialHttpServer, ProxyMetadata]:
    dummy_token = _dummy_token(adapter)
    provisional_bound_ms = int(absolute_deadline.timestamp() * 1000)
    state = ProxyState(
        bound_source_ip, dummy_token, provisional_bound_ms, limits, log_path, now_ms,
        allow_retry=allow_retry, shared_request_limit=shared_request_limit,
    )
    upstream = FixedUpstream(
        upstream_base_url, adapter, response_body_limit_bytes=response_body_limit_bytes,
        network_trace_path=network_trace_path, trial_id=trial_id,
        trace_progress_seconds=trace_progress_seconds,
    )
    server = TrialHttpServer(
        (listen_host, 0), state, upstream, adapter, request_body_limit_bytes,
    )
    host = advertised_host or cast(tuple[str, int], server.server_address)[0]
    port = cast(tuple[str, int], server.server_address)[1]
    metadata = ProxyMetadata(
        trial_id, upstream_base_url, bound_source_ip, absolute_deadline,
        limits, log_path.name, adapter.adapter_id,
        request_body_limit_bytes, response_body_limit_bytes,
    )
    return f"http://{host}:{port}", dummy_token, provisional_bound_ms, server, metadata


def _dummy_token(adapter: ProviderAdapter) -> str:
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


def _valid_request_target(target: str) -> bool:
    parsed = urlsplit(target)
    return not parsed.scheme and not parsed.netloc and parsed.path.startswith("/")


def _is_lease_echo_target(target: str) -> bool:
    parsed = urlsplit(target)
    return not parsed.scheme and not parsed.netloc and parsed.path == LEASE_ECHO_TARGET


def _add_cached(total: int | None, observed: int | None) -> int | None:
    if total is None or observed is None:
        return None
    return total + observed
