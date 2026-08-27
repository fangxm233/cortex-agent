# input:  stdlib HTTP requests and fixed synthetic responses
# output: loopback captures, injected failures, and proxy request helpers
# pos:    Synthetic model endpoint fixture
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import socket
import struct
import threading
import time
from dataclasses import dataclass
from http.client import HTTPConnection, IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Mapping
from urllib.parse import urlsplit

from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey
from cortex_bench_harness.launcher.lease_bound import TEARDOWN_GRACE_MS
from cortex_bench_harness.proxy.adapters import ProviderAdapter, select_adapter
from cortex_bench_harness.proxy.lease import LeaseTerms

SYNTHETIC_MODEL = "claude-synthetic-1"
MESSAGES_TARGET = "/v1/messages?beta=true"
LEASE_TERMS = LeaseTerms(budget_ms=1_800_000, teardown_grace_ms=TEARDOWN_GRACE_MS)
ROW_ONE_KEY = CredentialCapabilityKey(
    "claude", "anthropic", "anthropic-messages", "api-key-bearer",
)


def row_one_adapter(
    upstream_base_url: str, credential: str | None,
    frozen_model: str | None = SYNTHETIC_MODEL,
) -> ProviderAdapter:
    return select_adapter(
        ROW_ONE_KEY, upstream_base_url=upstream_base_url,
        credential=credential, frozen_model=frozen_model,
    )


@dataclass(frozen=True)
class CapturedRequest:
    headers: dict[str, str]
    body: bytes
    method: str = "POST"
    path: str = ""


class SyntheticServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, bind_host: str, bind_port: int) -> None:
        super().__init__((bind_host, bind_port), SyntheticHandler)
        self.requests: list[CapturedRequest] = []
        self.response_delay_seconds = 0.0
        self.response_chunk_delay_seconds = 0.0
        self.status = 200
        # Statuses handed out one per request before `status` takes over again, so a test can
        # stage a provider that fails a few times and then answers.
        self.status_sequence: list[int] = []
        self.content_type = "application/json"
        self.extra_headers: dict[str, str] = {}
        self.raw_body: bytes | None = None
        self.truncate_after_bytes: int | None = None
        self.response = {
            "id": "msg_synthetic",
            "type": "message",
            "model": SYNTHETIC_MODEL,
            "usage": {"input_tokens": 2, "output_tokens": 3},
            "content": [],
        }

    def payload(self) -> bytes:
        if self.raw_body is not None:
            return self.raw_body
        return json.dumps(self.response).encode()


class SyntheticHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        server: SyntheticServer = self.server  # type: ignore[assignment]
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        server.requests.append(CapturedRequest(
            dict(self.headers.items()), body, self.command, self.path))
        time.sleep(server.response_delay_seconds)
        payload = server.payload()
        status = server.status_sequence.pop(0) if server.status_sequence else server.status
        self.send_response(status)
        self.send_header("content-type", server.content_type)
        for key, value in server.extra_headers.items():
            self.send_header(key, value)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self._write_payload(server, payload)

    def _write_payload(self, server: SyntheticServer, payload: bytes) -> None:
        try:
            if server.truncate_after_bytes is not None:
                self.wfile.write(payload[:server.truncate_after_bytes])
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            if server.response_chunk_delay_seconds == 0:
                self.wfile.write(payload)
                return
            for byte in payload:
                self.wfile.write(bytes([byte]))
                self.wfile.flush()
                time.sleep(server.response_chunk_delay_seconds)
        except OSError:
            return

    def log_message(self, _format: str, *_args: object) -> None:
        return


class SyntheticUpstream:
    def __init__(self, bind_host: str = "127.0.0.1", bind_port: int = 0) -> None:
        self.server = SyntheticServer(bind_host, bind_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    @property
    def requests(self) -> list[CapturedRequest]:
        return self.server.requests

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def __enter__(self) -> "SyntheticUpstream":
        return self

    def __exit__(self, *_args: object) -> None:
        self.stop()


@dataclass(frozen=True)
class StreamedResponse:
    """What a client observes now that the proxy relays a response while it arrives.

    `complete` is the only way a refused response differs from an answer once bytes are on the
    wire: the proxy withholds the chunked terminator, so the client's read raises instead of
    returning a body it would otherwise treat as a whole answer.
    """

    status: int
    body: bytes
    complete: bool
    first_byte_seconds: float
    total_seconds: float
    headers: tuple[tuple[str, str], ...] = ()


def proxy_request(
    base_url: str, token: str, prompt: str, *, target: str = MESSAGES_TARGET,
    model: str | None = SYNTHETIC_MODEL, body: bytes | None = None,
    extra_headers: Mapping[str, str] | None = None,
) -> tuple[int, bytes]:
    result = streamed_proxy_request(
        base_url, token, prompt, target=target, model=model, body=body,
        extra_headers=extra_headers,
    )
    return result.status, result.body


def streamed_proxy_request(
    base_url: str, token: str, prompt: str, *, target: str = MESSAGES_TARGET,
    model: str | None = SYNTHETIC_MODEL, body: bytes | None = None,
    extra_headers: Mapping[str, str] | None = None, timeout: float = 3,
) -> StreamedResponse:
    payload = body if body is not None else json.dumps(
        {"model": model, "prompt": prompt}).encode()
    listener = urlsplit(base_url)
    connection = HTTPConnection(listener.hostname, listener.port, timeout=timeout)
    headers = {"authorization": f"Bearer {token}", "content-type": "application/json"}
    headers.update(extra_headers or {})
    started = time.monotonic()
    connection.request("POST", target, body=payload, headers=headers)
    response = connection.getresponse()
    result = _drain(response, started)
    connection.close()
    return result


def abandoned_proxy_request(
    base_url: str, token: str, prompt: str, *, target: str = MESSAGES_TARGET,
    model: str | None = SYNTHETIC_MODEL, timeout: float = 3,
) -> int:
    """Ask, read the status line, then vanish — what a client with its own deadline does.

    The connection is reset rather than closed politely, so the proxy's next relay write fails
    exactly as it does when a real client gives up mid-generation.
    """
    payload = json.dumps({"model": model, "prompt": prompt}).encode()
    listener = urlsplit(base_url)
    # A raw socket, because `HTTPConnection` closes its own socket the moment it reads a
    # `connection: close` response header, which is too early to choose how the close happens.
    sock = socket.create_connection((listener.hostname, listener.port), timeout=timeout)
    request = (
        f"POST {target} HTTP/1.1\r\nhost: {listener.netloc}\r\n"
        f"authorization: Bearer {token}\r\ncontent-type: application/json\r\n"
        f"content-length: {len(payload)}\r\n\r\n"
    ).encode() + payload
    try:
        sock.sendall(request)
        status_line = b""
        while not status_line.endswith(b"\r\n"):
            byte = sock.recv(1)
            if not byte:
                break
            status_line += byte
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    finally:
        sock.close()
    return int(status_line.split()[1])


def _drain(response: object, started: float) -> StreamedResponse:
    chunks: list[bytes] = []
    first_byte = None
    complete = True
    try:
        while chunk := response.read1(65536):  # type: ignore[attr-defined]
            if first_byte is None:
                first_byte = time.monotonic() - started
            chunks.append(chunk)
    except IncompleteRead as truncated:
        complete = False
        chunks.append(truncated.partial)
    total = time.monotonic() - started
    return StreamedResponse(
        response.status, b"".join(chunks), complete,  # type: ignore[attr-defined]
        first_byte if first_byte is not None else total, total,
        tuple(response.getheaders()),
    )
