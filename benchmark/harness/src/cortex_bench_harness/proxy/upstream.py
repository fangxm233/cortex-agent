# input:  admitted HTTP request, fixed upstream URL, host credential
# output: upstream response bytes and aggregate model usage
# pos:    Fixed-route upstream adapter
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import threading
import time
from dataclasses import dataclass
from http.client import HTTPConnection, HTTPException, HTTPSConnection, HTTPResponse
from typing import Mapping
from urllib.parse import SplitResult, urlsplit

from .models import ProxyUsage

HOP_HEADERS = {
    "accept-encoding", "authorization", "connection", "content-length", "host", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "x-api-key",
}


@dataclass(frozen=True)
class UpstreamResult:
    status: int
    reason: str
    headers: tuple[tuple[str, str], ...]
    body: bytes
    usage: ProxyUsage


class UpstreamAttemptError(OSError):
    def __init__(self, may_have_reached_upstream: bool) -> None:
        super().__init__("fixed upstream request failed")
        self.may_have_reached_upstream = may_have_reached_upstream


class FixedUpstream:
    def __init__(self, base_url: str, credential: str) -> None:
        self._target = validate_upstream(base_url)
        self._credential = credential
        self._lock = threading.Lock()
        self._active: HTTPConnection | None = None
        self._revoked = False

    def request(
        self, path: str, headers: Mapping[str, str], body: bytes,
        timeout_seconds: float,
    ) -> UpstreamResult:
        expires_at = time.monotonic() + timeout_seconds
        connection = self._connection(timeout_seconds)
        self._activate(connection)
        try:
            self._connect(connection)
            connection.request("POST", self._path(path), body, self._headers(headers, body))
            return read_response(connection.getresponse(), expires_at)
        except UpstreamAttemptError:
            raise
        except (HTTPException, OSError) as error:
            raise UpstreamAttemptError(True) from error
        finally:
            self._release(connection)

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

    def _headers(self, incoming: Mapping[str, str], body: bytes) -> dict[str, str]:
        headers = {
            key: value for key, value in incoming.items()
            if key.lower() not in HOP_HEADERS
        }
        headers["authorization"] = f"Bearer {self._credential}"
        headers["content-length"] = str(len(body))
        headers["accept-encoding"] = "identity"
        return headers


def validate_upstream(base_url: str) -> SplitResult:
    target = urlsplit(base_url)
    if target.scheme not in {"http", "https"} or not target.hostname:
        raise ValueError("upstream_base_url must be an http or https URL")
    if target.username or target.password or target.query or target.fragment:
        raise ValueError("upstream_base_url must not contain credentials, query, or fragment")
    return target


def read_response(response: HTTPResponse, expires_at: float) -> UpstreamResult:
    body = _read_until_deadline(response, expires_at)
    headers = tuple(response.getheaders())
    content_type = response.getheader("content-type", "")
    usage = parse_usage(body, content_type)
    return UpstreamResult(response.status, response.reason, headers, body, usage)


def _read_until_deadline(response: HTTPResponse, expires_at: float) -> bytes:
    chunks: list[bytes] = []
    while True:
        remaining = expires_at - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("absolute deadline reached")
        _set_response_timeout(response, remaining)
        chunk = response.read1(64 * 1024)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def _set_response_timeout(response: HTTPResponse, timeout: float) -> None:
    stream = response.fp
    raw = getattr(stream, "raw", None)
    active_socket = getattr(raw, "_sock", None)
    if active_socket is not None:
        active_socket.settimeout(max(timeout, 0.001))


def parse_usage(body: bytes, content_type: str) -> ProxyUsage:
    if "text/event-stream" in content_type:
        documents = _sse_documents(body)
    else:
        documents = [_json_object(body)]
    model: str | None = None
    input_tokens = 0
    output_tokens = 0
    seen_input = False
    seen_output = False
    malformed = False
    for document in documents:
        usage = _usage(document)
        malformed = malformed or _invalid_present_token(usage)
        seen_input = seen_input or _valid_token(usage, "input_tokens")
        seen_output = seen_output or _valid_token(usage, "output_tokens")
        model, input_tokens, output_tokens = _merge_usage(
            document, model, input_tokens, output_tokens)
    accounted = seen_input and seen_output and not malformed and bool(model and model.strip())
    return ProxyUsage(model, input_tokens, output_tokens, accounted)


def _sse_documents(body: bytes) -> list[dict[str, object]]:
    documents: list[dict[str, object]] = []
    for line in body.splitlines():
        if line.startswith(b"data:") and line[5:].strip() != b"[DONE]":
            documents.append(_json_object(line[5:].strip()))
    return documents


def _json_object(payload: bytes) -> dict[str, object]:
    try:
        value = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _merge_usage(
    document: dict[str, object], model: str | None,
    input_tokens: int, output_tokens: int,
) -> tuple[str | None, int, int]:
    source = _message_source(document)
    next_model = source.get("model")
    usage = _usage(document)
    model = next_model if isinstance(next_model, str) else model
    if usage is None:
        return model, input_tokens, output_tokens
    return model, _token_value(usage, "input_tokens", input_tokens), _token_value(
        usage, "output_tokens", output_tokens)


def _message_source(document: dict[str, object]) -> dict[str, object]:
    message = document.get("message")
    return message if isinstance(message, dict) else document


def _usage(document: dict[str, object]) -> dict[str, object] | None:
    source_usage = _message_source(document).get("usage")
    if isinstance(source_usage, dict):
        return source_usage
    document_usage = document.get("usage")
    return document_usage if isinstance(document_usage, dict) else None


def _valid_token(usage: dict[str, object] | None, key: str) -> bool:
    if usage is None:
        return False
    value = usage.get(key)
    return type(value) is int and value >= 0


def _invalid_present_token(usage: dict[str, object] | None) -> bool:
    if usage is None:
        return False
    keys = ("input_tokens", "output_tokens")
    return any(key in usage and not _valid_token(usage, key) for key in keys)


def _token_value(usage: dict[str, object], key: str, previous: int) -> int:
    value = usage.get(key, previous)
    return value if type(value) is int and value >= 0 else previous
