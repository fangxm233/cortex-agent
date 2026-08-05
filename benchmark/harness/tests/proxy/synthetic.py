# input:  stdlib HTTP requests and fixed synthetic responses
# output: loopback upstream captures, adapter binding, and proxy request helper
# pos:    Synthetic model endpoint fixture
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import threading
import time
from dataclasses import dataclass
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Mapping
from urllib.parse import urlsplit

from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey
from cortex_bench_harness.proxy.adapters import ProviderAdapter, select_adapter

SYNTHETIC_MODEL = "claude-synthetic-1"
MESSAGES_TARGET = "/v1/messages?beta=true"
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
        self.content_type = "application/json"
        self.extra_headers: dict[str, str] = {}
        self.raw_body: bytes | None = None
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
        self.send_response(server.status)
        self.send_header("content-type", server.content_type)
        for key, value in server.extra_headers.items():
            self.send_header(key, value)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self._write_payload(server, payload)

    def _write_payload(self, server: SyntheticServer, payload: bytes) -> None:
        try:
            if server.response_chunk_delay_seconds == 0:
                self.wfile.write(payload)
                return
            for byte in payload:
                self.wfile.write(bytes([byte]))
                self.wfile.flush()
                time.sleep(server.response_chunk_delay_seconds)
        except (BrokenPipeError, ConnectionResetError):
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


def proxy_request(
    base_url: str, token: str, prompt: str, *, target: str = MESSAGES_TARGET,
    model: str | None = SYNTHETIC_MODEL, body: bytes | None = None,
    extra_headers: Mapping[str, str] | None = None,
) -> tuple[int, bytes]:
    payload = body if body is not None else json.dumps(
        {"model": model, "prompt": prompt}).encode()
    listener = urlsplit(base_url)
    connection = HTTPConnection(listener.hostname, listener.port, timeout=3)
    headers = {"authorization": f"Bearer {token}", "content-type": "application/json"}
    headers.update(extra_headers or {})
    connection.request("POST", target, body=payload, headers=headers)
    response = connection.getresponse()
    document = response.read()
    connection.close()
    return response.status, document
