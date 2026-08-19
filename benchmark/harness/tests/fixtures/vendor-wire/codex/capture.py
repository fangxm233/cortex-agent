# input:  pinned Codex binary, synthetic SSE fixture, isolated loopback
# output: redacted JSON observation of native request and CLI result
# pos:    Zero-paid native Codex vendor-wire capture probe
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "gpt-5.3-codex"
ACCOUNT_ID = "dummy-account-wire-capture"
FIXTURE_DIR = Path(__file__).parent
EVENT_MODES = ("completed", "done", "incomplete", "failed", "error")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture Codex 0.117.0 against a loopback-only synthetic server.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  unshare --user --map-root-user --net sh -c 'ip link set lo up && python capture.py --codex-binary /path/to/codex --event-mode completed --exp-offset-seconds none'
  unshare --user --map-root-user --net sh -c 'ip link set lo up && python capture.py --codex-binary /path/to/codex --event-mode failed --exp-offset-seconds -1'
""",
    )
    parser.add_argument("--codex-binary", required=True, type=Path)
    parser.add_argument("--event-mode", choices=EVENT_MODES, default="completed")
    parser.add_argument(
        "--exp-offset-seconds", default="none",
        help="JWT exp offset from capture time, or 'none' (default: none)",
    )
    return parser.parse_args()


def jwt_segment(value: dict[str, object]) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def dummy_token(offset: int | None) -> str:
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    payload: dict[str, object] = {
        "https://api.openai.com/auth": {"chatgpt_account_id": ACCOUNT_ID},
    }
    if offset is not None:
        payload.update({"iat": now, "exp": now + offset})
    return ".".join((
        jwt_segment({"alg": "none", "typ": "JWT"}),
        jwt_segment(payload),
        jwt_segment({"dummy": True}),
    ))


def parse_offset(value: str) -> int | None:
    if value == "none":
        return None
    try:
        return int(value)
    except ValueError as error:
        raise ValueError(
            f"invalid --exp-offset-seconds {value!r}; use an integer or 'none'",
        ) from error


def assert_isolated_network() -> None:
    routes = Path("/proc/net/route").read_text(encoding="utf-8").splitlines()[1:]
    if any(line.split()[1] == "00000000" for line in routes if line.split()):
        raise RuntimeError(
            "default network route present; rerun with unshare --user --map-root-user --net",
        )


def load_events(mode: str) -> list[dict[str, object]]:
    completed = json.loads(
        (FIXTURE_DIR / "success-sse.json").read_text(encoding="utf-8"),
    )["events"]
    if mode == "completed":
        return completed
    if mode == "done":
        completed[-1]["type"] = "response.done"
        return completed
    return _failure_events(mode, completed[0]["response"])


def _failure_events(mode: str, response: dict[str, object]) -> list[dict[str, object]]:
    started = {**response, "status": "in_progress", "output": [], "usage": None}
    if mode == "incomplete":
        terminal = {
            "type": "response.incomplete",
            "response": {**response, "status": "incomplete", "output": [],
                         "incomplete_details": {"reason": "max_output_tokens"}},
        }
    elif mode == "failed":
        terminal = {
            "type": "response.failed",
            "response": {**response, "status": "failed", "output": [],
                         "error": {"code": "server_error", "message": "synthetic failure"}},
        }
    else:
        return [{"type": "error", "code": "server_error",
                 "message": "synthetic failure", "param": None}]
    return [{"type": "response.created", "response": started}, terminal]


def sse_bytes(events: list[dict[str, object]]) -> bytes:
    chunks = [
        f"event: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"
        for event in events
    ]
    chunks.append("data: [DONE]\n\n")
    return "".join(chunks).encode()


def handler_type(records: list[dict[str, object]], response_body: bytes):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_CONNECT(self) -> None:
            records.append({"connect": self.path})
            self.send_response(502)
            self.send_header("content-length", "0")
            self.end_headers()

        def do_POST(self) -> None:
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length)
            records.append(observe_request(self.path, dict(self.headers), body))
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)

        def log_message(self, *_args: object) -> None:
            return

    return Handler


def observe_request(
    target: str, headers: dict[str, str], body: bytes,
) -> dict[str, object]:
    redacted = {
        key.lower(): redact_header(key, value) for key, value in headers.items()
    }
    document = json.loads(body)
    return {
        "target": target,
        "headers": redacted,
        "body_bytes": len(body),
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "body_keys": list(document),
        "body": document,
        "model": document.get("model"),
        "stream": document.get("stream"),
        "zstd_magic_present": body.startswith(b"\x28\xb5\x2f\xfd"),
    }


def redact_header(key: str, value: str) -> str:
    name = key.lower()
    if name == "authorization":
        return "Bearer <REDACTED_DUMMY_JWT>"
    if name in {"session_id", "x-client-request-id", "x-codex-turn-metadata"}:
        return "<REDACTED_DYNAMIC>"
    if name == "host":
        return "127.0.0.1:<EPHEMERAL_PORT>"
    return value


def write_codex_home(root: Path, port: int, token: str) -> Path:
    codex_home = root / ".codex"
    codex_home.mkdir()
    auth = {
        "tokens": {"id_token": token, "access_token": token,
                   "refresh_token": "dummy-refresh-never-forward"},
        "last_refresh": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    (codex_home / "auth.json").write_text(json.dumps(auth), encoding="utf-8")
    (codex_home / "config.toml").write_text(config_toml(port), encoding="utf-8")
    return codex_home


def config_toml(port: int) -> str:
    return f'''model = "{MODEL}"
model_provider = "synthetic"
model_reasoning_effort = "high"
web_search = "disabled"
[model_providers.synthetic]
name = "synthetic"
base_url = "http://127.0.0.1:{port}/codex"
wire_api = "responses"
requires_openai_auth = true
'''


def run_codex(binary: Path, root: Path, codex_home: Path, port: int):
    proxy = f"http://127.0.0.1:{port}"
    env = {
        **os.environ, "HOME": str(root), "CODEX_HOME": str(codex_home),
        "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy,
        "NO_PROXY": "127.0.0.1,localhost",
    }
    argv = [str(binary), "exec", "--skip-git-repo-check", "--ephemeral", "--json",
            "Reply with exactly WIRE_CAPTURE_OK"]
    return subprocess.run(
        argv, cwd=root, env=env, capture_output=True, text=True,
        timeout=45, check=False,
    )


def capture(args: argparse.Namespace) -> dict[str, object]:
    assert_isolated_network()
    version = subprocess.run(
        [str(args.codex_binary), "--version"], capture_output=True,
        text=True, timeout=5, check=False,
    )
    if version.stdout.strip() != "codex-cli 0.117.0":
        raise RuntimeError("--codex-binary must report codex-cli 0.117.0")
    records: list[dict[str, object]] = []
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), handler_type(records, sse_bytes(load_events(args.event_mode))),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        return _capture_with_server(args, server.server_port, records)
    finally:
        server.shutdown()


def _capture_with_server(
    args: argparse.Namespace, port: int, records: list[dict[str, object]],
) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="codex-wire-") as temp:
        root = Path(temp)
        token = dummy_token(parse_offset(args.exp_offset_seconds))
        result = run_codex(args.codex_binary, root, write_codex_home(root, port, token), port)
    return {
        "ok": result.returncode == 0,
        "cli_version": "codex-cli 0.117.0",
        "event_mode": args.event_mode,
        "exp_offset_seconds": args.exp_offset_seconds,
        "returncode": result.returncode,
        "stdout_jsonl": result.stdout.splitlines(),
        "stderr_redacted": result.stderr.replace(temp, "<TEMP_DIR>"),
        "observations": records,
    }


def main() -> int:
    try:
        document = capture(parse_args())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    print(json.dumps(document, indent=2))
    return 0 if document["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
