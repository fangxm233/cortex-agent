# input:  stdlib HTTP requests and fixed synthetic responses
# output: loopback upstream captures and proxy request helper
# pos:    Synthetic model endpoint fixture
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import threading
import time
from dataclasses import dataclass
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


@dataclass(frozen=True)
class CapturedRequest:
    headers: dict[str, str]
    body: bytes


class SyntheticServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, bind_host: str, bind_port: int) -> None:
        super().__init__((bind_host, bind_port), SyntheticHandler)
        self.requests: list[CapturedRequest] = []
        self.response_delay_seconds = 0.0
        self.response_chunk_delay_seconds = 0.0
        self.response = {
            "id": "msg_synthetic",
            "type": "message",
            "model": "claude-synthetic-1",
            "usage": {"input_tokens": 2, "output_tokens": 3},
            "content": [],
        }


class SyntheticHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        server: SyntheticServer = self.server  # type: ignore[assignment]
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        server.requests.append(CapturedRequest(dict(self.headers.items()), body))
        time.sleep(server.response_delay_seconds)
        payload = json.dumps(server.response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
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


def proxy_request(base_url: str, token: str, prompt: str) -> tuple[int, bytes]:
    target = urlsplit(base_url)
    body = json.dumps({"model": "claude-synthetic-1", "prompt": prompt}).encode()
    connection = HTTPConnection(target.hostname, target.port, timeout=3)
    headers = {"authorization": f"Bearer {token}", "content-type": "application/json"}
    connection.request("POST", "/v1/messages", body=body, headers=headers)
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, payload
