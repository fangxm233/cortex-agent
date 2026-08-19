#!/usr/bin/env python3
# input:  pinned PI CLI and a Linux user/network namespace
# output: redacted PI artifact pin and loopback wire fixtures
# pos:    Offline capture command for the real PI vendor contract
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import http.server
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

EXPECTED_PACKAGE = "@earendil-works/pi-coding-agent"
EXPECTED_VERSION = "0.82.1"
SCHEMA_PIN = "cortex-bench-vendor-artifact-pin/1"
SCHEMA_CAPTURE = "cortex-bench-vendor-wire-capture/1"
HARNESS_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = HARNESS_DIR / "tests/fixtures/vendor-wire/pi"
DUMMY_KEY = "dummy-pi-wire-key"
SUCCESS_STREAM = [
    'data: {"id":"chatcmpl-wire","object":"chat.completion.chunk","created":0,"model":"wire-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-wire","object":"chat.completion.chunk","created":0,"model":"wire-model","choices":[{"index":0,"delta":{"content":"synthetic ok"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-wire","object":"chat.completion.chunk","created":0,"model":"wire-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    "data: [DONE]",
]
ERROR_BODY = {"error": {"message": "synthetic rejected", "type": "authentication_error"}}


def parser() -> argparse.ArgumentParser:
    example = (
        "Examples:\n"
        "  python scripts/capture-pi-vendor-wire.py\n"
        "  python scripts/capture-pi-vendor-wire.py --output-dir /tmp/pi-wire --pi-command pi"
    )
    value = argparse.ArgumentParser(
        description="Capture PI 0.82.1 against a loopback-only synthetic upstream.",
        epilog=example,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    value.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    value.add_argument("--pi-command", default="pi")
    value.add_argument("--isolated", action="store_true", help=argparse.SUPPRESS)
    return value


def enter_network_namespace(args: argparse.Namespace) -> int:
    unshare = shutil.which("unshare")
    if not unshare:
        raise RuntimeError("unshare is required; install util-linux or run on the benchmark Linux host")
    command = [
        unshare, "--user", "--map-root-user", "--net", sys.executable,
        str(Path(__file__).resolve()), "--isolated", "--output-dir", str(args.output_dir),
        "--pi-command", args.pi_command,
    ]
    return subprocess.run(command, check=False).returncode


def find_package_json(pi_path: Path) -> Path:
    current = pi_path.resolve().parent
    for _ in range(4):
        candidate = current / "package.json"
        if candidate.exists():
            return candidate
        current = current.parent
    raise RuntimeError(f"cannot locate package.json above PI executable: {pi_path}")


def resolve_pi(command: str) -> tuple[Path, dict[str, Any]]:
    path = shutil.which(command) if "/" not in command else command
    if not path:
        raise RuntimeError(f"PI executable not found: {command}; install {EXPECTED_PACKAGE}@{EXPECTED_VERSION}")
    pi_path = Path(path)
    package = json.loads(find_package_json(pi_path).read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        agent_dir = root / "agent"
        agent_dir.mkdir()
        completed = subprocess.run(
            [str(pi_path), "--version"], check=True, capture_output=True, text=True,
            env=safe_environment(root, agent_dir),
        )
    observed = completed.stdout.strip()
    actual = (package.get("name"), package.get("version"), observed)
    expected = (EXPECTED_PACKAGE, EXPECTED_VERSION, EXPECTED_VERSION)
    if actual != expected:
        raise RuntimeError(f"PI artifact mismatch: observed {actual!r}; required {expected!r}")
    return pi_path, package


def model_config(port: int | str) -> dict[str, Any]:
    return {"providers": {"deepseek": {
        "baseUrl": f"http://127.0.0.1:{port}/v1",
        "api": "openai-completions",
        "models": [{
            "id": "deepseek-chat", "name": "Synthetic DeepSeek", "reasoning": False,
            "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        }],
    }}}


def write_config(root: Path, port: int) -> Path:
    agent_dir = root / "agent"
    agent_dir.mkdir()
    auth_path = agent_dir / "auth.json"
    auth_path.write_text(json.dumps({"deepseek": {"type": "api_key", "key": DUMMY_KEY}}), encoding="utf-8")
    auth_path.chmod(0o600)
    models_path = agent_dir / "models.json"
    models_path.write_text(json.dumps(model_config(port)), encoding="utf-8")
    models_path.chmod(0o644)
    return agent_dir


class CaptureServer(http.server.ThreadingHTTPServer):
    records: list[dict[str, Any]]


class CaptureHandler(http.server.BaseHTTPRequestHandler):
    server: CaptureServer

    def do_POST(self) -> None:
        length = int(self.headers["content-length"])
        parsed = urlsplit(self.path)
        self.server.records.append({
            "method": "POST", "path": parsed.path, "query": parsed.query,
            "headers": dict(self.headers), "body": json.loads(self.rfile.read(length)),
        })
        if len(self.server.records) == 1:
            self.send_success()
        else:
            self.send_error_response()

    def send_success(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event in SUCCESS_STREAM:
            self.wfile.write(f"{event}\n\n".encode())
            self.wfile.flush()

    def send_error_response(self) -> None:
        payload = json.dumps(ERROR_BODY, separators=(",", ":")).encode()
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *args: object) -> None:
        return


def safe_environment(root: Path, agent_dir: Path) -> dict[str, str]:
    home = root / "home"
    home.mkdir()
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found; PI 0.82.1 requires Node 22.19 or newer")
    path_dirs = dict.fromkeys([str(Path(node).parent), str(Path(node).resolve().parent), "/usr/bin", "/bin"])
    return {
        "HOME": str(home), "PATH": os.pathsep.join(path_dirs), "LC_ALL": "C.UTF-8",
        "PI_CODING_AGENT_DIR": str(agent_dir), "PI_OFFLINE": "1",
        "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
        "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
    }


def pi_arguments(pi_path: Path, scenario: str) -> list[str]:
    return [
        str(pi_path), "--print", "--mode", "json", "--no-session", "--no-tools",
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--no-context-files", "--system-prompt", "synthetic system prompt",
        "--provider", "deepseek", "--model", "deepseek-chat", f"wire {scenario}",
    ]


def normalize(value: Any) -> Any:
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: ("<TIMESTAMP>" if key == "timestamp" else normalize(item)) for key, item in value.items()}
    if result.get("type") == "session":
        result["id"] = "<SESSION_ID>"
        result["cwd"] = "<CAPTURE_CWD>"
    return result


def run_pi(pi_path: Path, scenario: str, root: Path, env: dict[str, str]) -> dict[str, Any]:
    completed = subprocess.run(
        pi_arguments(pi_path, scenario), cwd=root, env=env, check=False,
        capture_output=True, text=True, timeout=30,
    )
    events = [normalize(json.loads(line)) for line in completed.stdout.splitlines() if line]
    stop_reasons = [
        event["message"]["stopReason"] for event in events
        if isinstance(event.get("message"), dict) and "stopReason" in event["message"]
    ]
    return {
        "argv": ["pi", *pi_arguments(pi_path, scenario)[1:]], "returncode": completed.returncode,
        "stderr": completed.stderr, "event_types": [event["type"] for event in events],
        "stop_reasons": stop_reasons, "events": events,
    }


def redact_request(request: dict[str, Any], root: Path) -> dict[str, Any]:
    headers = {key.lower(): value for key, value in request["headers"].items()}
    if headers.get("authorization") != f"Bearer {DUMMY_KEY}":
        raise RuntimeError("expected dummy PI authorization bearer")
    headers["authorization"] = "<REDACTED>"
    headers["host"] = "127.0.0.1:<PORT>"
    headers["content-length"] = "<CONTENT_LENGTH>"
    body = json.loads(json.dumps(request["body"]).replace(str(root), "<CAPTURE_CWD>"))
    return {
        "method": request["method"], "path": request["path"], "query": request["query"],
        "headers": dict(sorted(headers.items())), "body": body,
    }


def observations() -> dict[str, Any]:
    return {
        "PI_CODING_AGENT_DIR": {"status": "observed", "value": "<TEMP>/agent", "effect": "PI loaded auth.json and models.json only from this isolated directory."},
        "PI_OFFLINE": {"status": "observed", "value": "1", "effect": "The real capture ran with offline startup mode inside a private network namespace; only loopback provider requests were possible."},
        "PI_SKIP_VERSION_CHECK": {"status": "not-exercised", "value": "1", "effect": "Independent version-check suppression was masked by PI_OFFLINE=1."},
        "PI_TELEMETRY": {"status": "not-exercised", "value": "0", "effect": "Independent telemetry suppression was masked by PI_OFFLINE=1."},
        "auth.json": {"status": "observed", "path": "$PI_CODING_AGENT_DIR/auth.json", "mode": "0600", "shape": {"deepseek": {"type": "api_key", "key": "<DUMMY_API_KEY>"}}, "effect": "The dummy key became the redacted Authorization bearer value."},
        "models.json": {"status": "observed", "path": "$PI_CODING_AGENT_DIR/models.json", "mode": "0644", "shape": model_config("<PORT>"), "effect": "The baseUrl selected loopback /v1/chat/completions and the declared deepseek-chat model."},
    }


def artifact_pin(package: dict[str, Any]) -> dict[str, Any]:
    from harbor.agents.installed.pi import Pi

    return {
        "schema_version": SCHEMA_PIN,
        "artifact": {"ecosystem": "npm", "package": package["name"], "version": package["version"]},
        "cli": {"command": "pi --version", "observed_stdout": EXPECTED_VERSION},
        "harbor": {"package_version": importlib.metadata.version("harbor"), "version_check_command": Pi.get_version_command(Pi.__new__(Pi))},
    }


def capture(pi_path: Path, package: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    server = CaptureServer(("127.0.0.1", 0), CaptureHandler)
    server.records = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agent_dir = write_config(root, server.server_port)
            env = safe_environment(root, agent_dir)
            success = run_pi(pi_path, "success", root, env)
            error = run_pi(pi_path, "error", root, env)
            request = redact_request(server.records[0], root)
            error_request = redact_request(server.records[1], root)
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
    if len(server.records) != 2:
        raise RuntimeError(f"expected two PI provider requests, observed {len(server.records)}")
    document = {
        "schema_version": SCHEMA_CAPTURE, "network_isolation": "linux-user-network-namespace",
        "request": request, "error_request": error_request,
        "upstream_stream": SUCCESS_STREAM,
        "error_response": {"status": 401, "headers": {"content-type": "application/json"}, "body": ERROR_BODY},
        "success_process": success, "error_process": error, "observations": observations(),
    }
    return artifact_pin(package), document


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def isolated_main(args: argparse.Namespace) -> int:
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    pi_path, package = resolve_pi(args.pi_command)
    pin, wire = capture(pi_path, package)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_json(args.output_dir / "artifact-pin.json", pin)
    write_json(args.output_dir / "capture.json", wire)
    print(json.dumps({
        "ok": True, "network_isolation": "linux-user-network-namespace",
        "output_dir": str(args.output_dir), "pi_version": EXPECTED_VERSION,
    }, sort_keys=True))
    return 0


def main() -> int:
    args = parser().parse_args()
    try:
        return isolated_main(args) if args.isolated else enter_network_namespace(args)
    except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
