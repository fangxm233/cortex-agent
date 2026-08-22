# input:  loopback OpenAI chat-completion requests
# output: deterministic DeepSeek-shaped SSE tool turns
# pos:    ZERO-PAID synthetic model endpoint
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import json
import os
import re
import signal
import threading
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = "deepseek-v4-flash"
INSTRUCTION_LITERAL = re.compile(
    r"Write the exact text `([^`]*)` into `(/tmp/answer\.txt)`\."
)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    request_count = 0


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        self.server.request_count += 1
        document = self._request_document()
        messages = document.get("messages")
        messages = messages if isinstance(messages, list) else []
        try:
            payload = _sse(_turn(messages))
        except ValueError as error:
            payload = f"{error}\n".encode()
            self.send_response(400)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _request_document(self) -> Mapping[str, object]:
        length = int(self.headers.get("content-length", "0"))
        value = json.loads(self.rfile.read(length))
        return value if isinstance(value, Mapping) else {}

    def log_message(self, _format: str, *_args: object) -> None:
        return


class SyntheticDeepSeekUpstream:
    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._server = _Server((host, port), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    @property
    def request_count(self) -> int:
        return self._server.request_count

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)

    def __enter__(self) -> "SyntheticDeepSeekUpstream":
        return self

    def __exit__(self, *_args: object) -> None:
        self.stop()


def _turn(messages: list[object]) -> dict[str, object]:
    if any(isinstance(item, Mapping) and item.get("role") == "tool" for item in messages):
        return {"delta": {"content": "done"}, "finish_reason": "stop"}
    literal, path = _instruction(messages)
    arguments = json.dumps({"path": path, "content": literal}, separators=(",", ":"))
    return {
        "delta": {"tool_calls": [{
            "index": 0, "id": "call-write", "type": "function",
            "function": {"name": "write", "arguments": arguments},
        }]},
        "finish_reason": "tool_calls",
    }


def _instruction(messages: list[object]) -> tuple[str, str]:
    for item in reversed(messages):
        if not isinstance(item, Mapping) or item.get("role") != "user":
            continue
        content = item.get("content")
        texts = [content] if isinstance(content, str) else [
            block.get("text") for block in content
            if isinstance(block, Mapping) and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        ] if isinstance(content, list) else []
        for text in texts:
            if match := INSTRUCTION_LITERAL.search(text):
                return match.group(1), match.group(2)
    raise ValueError("unrecognized ZERO-PAID instruction")


def _sse(turn: Mapping[str, object]) -> bytes:
    chunks = [
        {"id": "chatcmpl-zero-paid", "model": MODEL,
         "choices": [{"index": 0, **dict(turn)}]},
        {"id": "chatcmpl-zero-paid", "model": MODEL, "choices": [],
         "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]
    lines = [f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n" for chunk in chunks]
    return ("".join(lines) + "data: [DONE]\n\n").encode()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve deterministic loopback DeepSeek SSE")
    parser.add_argument("--state-file", required=True)
    arguments = parser.parse_args(argv)
    state_path = Path(arguments.state_file)
    server = SyntheticDeepSeekUpstream()
    state_path.write_text(json.dumps({
        "base_url": server.base_url, "pid": os.getpid(),
    }, sort_keys=True) + "\n", encoding="utf-8")
    stopping = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping.wait(0.1):
        pass
    requests = server.request_count
    server.stop()
    state_path.with_name(f"{state_path.stem}.final{state_path.suffix}").write_text(
        json.dumps({"pid": os.getpid(), "requests": requests}, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
