# input:  admitted HTTP request, fixed upstream URL, provider adapter
# output: relayed upstream response bytes and adapter-extracted model usage
# pos:    Fixed-route upstream adapter
# >>> If I am updated, update my header and folder CORTEX.md <<<

import threading
import time
from dataclasses import dataclass
from http.client import HTTPConnection, HTTPException, HTTPSConnection, HTTPResponse
from pathlib import Path
from typing import Mapping, Protocol
from urllib.parse import SplitResult, urlsplit

from .adapters.base import ProviderAdapter
from .models import ProxyUsage
from .network_trace import NetworkTrace, RequestTrace

HOP_HEADERS = {
    "accept-encoding", "authorization", "connection", "content-length", "host", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "x-api-key",
}


class ResponseSink(Protocol):
    """Receives an upstream response while it is still arriving.

    Every admitted trial route is a streaming route, so holding the body until the upstream
    finished made the caller wait out the whole generation with no bytes on the wire. A sink
    relays each chunk the moment it is read; accounting still runs on the complete body.
    """

    def begin(
        self, status: int, reason: str, headers: tuple[tuple[str, str], ...],
    ) -> None: ...

    def relay(self, chunk: bytes) -> None: ...


@dataclass(frozen=True)
class UpstreamResult:
    status: int
    reason: str
    headers: tuple[tuple[str, str], ...]
    body: bytes
    usage: ProxyUsage


class UpstreamAttemptError(OSError):
    def __init__(
        self, may_have_reached_upstream: bool, reason: str = "upstream_unavailable",
    ) -> None:
        super().__init__("fixed upstream request failed")
        self.may_have_reached_upstream = may_have_reached_upstream
        self.reason = reason


class FixedUpstream:
    def __init__(
        self, base_url: str, adapter: ProviderAdapter,
        response_body_limit_bytes: int | None = None,
        network_trace_path: Path | None = None, trial_id: str | None = None,
        trace_progress_seconds: float = 10,
    ) -> None:
        self._target = validate_upstream(base_url)
        self._adapter = adapter
        self._response_body_limit_bytes = response_body_limit_bytes
        self._network_trace = _network_trace(
            network_trace_path, trial_id, trace_progress_seconds)
        self._lock = threading.Lock()
        self._active: HTTPConnection | None = None
        self._revoked = False

    @property
    def network_trace_complete(self) -> bool:
        return self._network_trace is None or self._network_trace.complete

    def start_request_trace(self) -> RequestTrace | None:
        return self._network_trace.start_request() if self._network_trace is not None else None

    def finalize_trace(self) -> None:
        if self._network_trace is not None:
            self._network_trace.finalize()

    def request(
        self, path: str, headers: Mapping[str, str], body: bytes,
        timeout_seconds: float, route_id: str, sink: "ResponseSink | None" = None,
        trace: RequestTrace | None = None,
    ) -> UpstreamResult:
        outbound = self._headers(headers, body, route_id)
        expires_at = time.monotonic() + timeout_seconds
        connection = self._connection(timeout_seconds)
        self._activate(connection)
        try:
            return self._request_once(
                connection, path, outbound, body, expires_at, sink, trace)
        except UpstreamAttemptError as error:
            _trace_failure(trace, error.reason)
            raise
        except (HTTPException, OSError) as error:
            _trace_failure(trace, "upstream_unavailable")
            raise UpstreamAttemptError(True) from error
        finally:
            self._release(connection)

    def _request_once(
        self, connection: HTTPConnection, path: str, headers: Mapping[str, str],
        body: bytes, expires_at: float, sink: "ResponseSink | None",
        trace: RequestTrace | None,
    ) -> UpstreamResult:
        _trace_event(trace, "upstream_connect_started", durable=True)
        self._connect(connection)
        _trace_event(trace, "upstream_connect_returned")
        _trace_event(trace, "request_socket_write_started", durable=True)
        connection.request("POST", self._path(path), body, headers)
        _trace_event(trace, "request_socket_write_returned")
        _trace_event(trace, "response_headers_wait_started", durable=True)
        response = connection.getresponse()
        _trace_event(trace, "response_headers_received", status=response.status)
        return read_response(
            response, expires_at, self._adapter,
            self._response_body_limit_bytes, sink, trace,
        )

    def _connect(self, connection: HTTPConnection) -> None:
        try:
            connection.connect()
            connection.auto_open = False
        except OSError as error:
            raise UpstreamAttemptError(False) from error

    def deactivate(self) -> None:
        with self._lock:
            self._revoked = True
            if self._active is not None:
                self._active.close()

    def clear_credential(self) -> None:
        self._adapter.clear_credential()

    def _activate(self, connection: HTTPConnection) -> None:
        with self._lock:
            if self._revoked:
                connection.close()
                raise UpstreamAttemptError(False)
            self._active = connection

    def _release(self, connection: HTTPConnection) -> None:
        with self._lock:
            if self._active is connection:
                self._active = None
        connection.close()

    def _connection(self, timeout_seconds: float) -> HTTPConnection:
        host = self._target.hostname or ""
        port = self._target.port
        timeout = max(timeout_seconds, 0.001)
        if self._target.scheme == "https":
            return HTTPSConnection(host, port, timeout=timeout)
        return HTTPConnection(host, port, timeout=timeout)

    def _path(self, incoming: str) -> str:
        parsed = urlsplit(incoming)
        base = self._target.path.rstrip("/")
        path = f"{base}/{parsed.path.lstrip('/')}"
        return f"{path}?{parsed.query}" if parsed.query else path

    def _headers(
        self, incoming: Mapping[str, str], body: bytes, route_id: str,
    ) -> dict[str, str]:
        stripped = {
            key: value for key, value in incoming.items()
            if key.lower() not in HOP_HEADERS
        }
        headers = self._adapter.inject_auth(stripped, route_id)
        headers["content-length"] = str(len(body))
        headers["accept-encoding"] = "identity"
        return headers


def _network_trace(
    path: Path | None, trial_id: str | None, progress_seconds: float,
) -> NetworkTrace | None:
    if path is None:
        return None
    if trial_id is None:
        raise ValueError("network trace requires a trial id")
    return NetworkTrace(path, trial_id, progress_interval_seconds=progress_seconds)


def validate_upstream(base_url: str) -> SplitResult:
    target = urlsplit(base_url)
    if target.scheme not in {"http", "https"} or not target.hostname:
        raise ValueError("upstream_base_url must be an http or https URL")
    if target.username or target.password or target.query or target.fragment:
        raise ValueError("upstream_base_url must not contain credentials, query, or fragment")
    return target


def read_response(
    response: HTTPResponse, expires_at: float, adapter: ProviderAdapter,
    response_body_limit_bytes: int | None = None,
    sink: ResponseSink | None = None, trace: RequestTrace | None = None,
) -> UpstreamResult:
    headers = tuple(response.getheaders())
    content_type = response.getheader("content-type", "")
    # The status line and headers are relayed before the first chunk is read, so the caller
    # learns the response has started at the upstream's time-to-first-byte rather than at
    # its completion.
    if sink is not None:
        sink.begin(response.status, response.reason, headers)
    _trace_event(trace, "response_stream_wait_started", durable=True)
    body = _read_until_deadline(
        response, expires_at, response_body_limit_bytes, sink, trace)
    usage = adapter.extract_usage(body, content_type)
    return UpstreamResult(response.status, response.reason, headers, body, usage)


def _read_until_deadline(
    response: HTTPResponse, expires_at: float, limit: int | None,
    sink: ResponseSink | None = None, trace: RequestTrace | None = None,
) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        remaining = expires_at - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("absolute deadline reached")
        _set_response_timeout(response, remaining)
        chunk = response.read1(64 * 1024)
        if not chunk:
            if response.length not in (None, 0):
                raise UpstreamAttemptError(True)
            if trace is not None:
                trace.stream_eof()
            return b"".join(chunks)
        total += len(chunk)
        if trace is not None:
            trace.stream_chunk(len(chunk))
        # The declared response cap is applied before the chunk is relayed, so no byte past
        # the cap ever reaches the caller.
        if limit is not None and total > limit:
            raise UpstreamAttemptError(True, "upstream_response_too_large")
        if sink is not None:
            sink.relay(chunk)
        chunks.append(chunk)


def _trace_event(
    trace: RequestTrace | None, phase: str, *, durable: bool = False,
    **metrics: object,
) -> None:
    if trace is not None:
        trace.event(phase, durable=durable, **metrics)


def _trace_failure(trace: RequestTrace | None, outcome: str) -> None:
    _trace_event(trace, "upstream_attempt_failed", durable=True, outcome=outcome)


def _set_response_timeout(response: HTTPResponse, timeout: float) -> None:
    stream = response.fp
    raw = getattr(stream, "raw", None)
    active_socket = getattr(raw, "_sock", None)
    if active_socket is not None:
        active_socket.settimeout(max(timeout, 0.001))
