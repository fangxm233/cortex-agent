# input:  current host Claude CLI, bwrap/strace, loopback namespace
# output: redacted wire capture with executed CLI version and hash
# pos:    Isolated capture support for current Claude compatibility
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import ipaddress
import json
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from cortex_bench_harness.launcher.lease_bound import TEARDOWN_GRACE_MS
from cortex_bench_harness.proxy import ProxyLimits, TrialProxyHandle, start_trial_proxy
from cortex_bench_harness.proxy.adapters import AuthInjectionUnavailable
from cortex_bench_harness.proxy.adapters.anthropic import (
    MESSAGES_BETA_ROUTE,
    AnthropicMessagesApiKeyAdapter,
)
from cortex_bench_harness.proxy.lease import LeaseTerms

from current_vendor_cli import CliIdentity, inspect_binary, require_isolated_network

DUMMY_CREDENTIAL = "dummy-claude-code-vendor-wire-bearer"
HOST_BEARER = "host-held-dummy-subscription-oauth"
ALIASES = ("sonnet", "opus", "haiku")
UUID_PATTERN = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I,
)
DEVICE_PATTERN = re.compile(r"(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])", re.I)
DATE_PATTERN = re.compile(r"Today's date is \d{4}-\d{2}-\d{2}")
AUTHORITY_PATTERN = re.compile(r"127\.0\.0\.1:\d+")
TASK_PATTERN = re.compile(r"(?<![0-9a-f])[0-9a-f]{17}(?![0-9a-f])")
DYNAMIC_KEYS = {
    "duration_api_ms", "duration_ms", "end_time", "time_to_request_ms",
    "timestamp", "totalDurationMs", "ttft_ms", "ttft_stream_ms",
}


def _message_start(message_id: str) -> dict[str, object]:
    return {
        "type": "message_start",
        "message": {
            "id": message_id, "type": "message", "role": "assistant", "content": [],
            "model": "claude-fixture-response", "stop_reason": None,
            "stop_sequence": None, "usage": {
                "input_tokens": 7, "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0, "output_tokens": 1,
            },
        },
    }


def text_events() -> list[dict[str, object]]:
    return [
        _message_start("msg_fixture"),
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "text", "text": ""}},
        {"type": "ping"},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "text_delta", "text": "fixture-ok"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {
            "stop_reason": "end_turn", "stop_sequence": None,
        }, "usage": {"output_tokens": 3}},
        {"type": "message_stop"},
    ]


def tool_events() -> list[dict[str, object]]:
    tool_input = {
        "description": "fixture agent", "prompt": "return fixture-subagent",
        "subagent_type": "Explore", "model": "haiku", "run_in_background": False,
    }
    return [
        _message_start("msg_tool"),
        {"type": "content_block_start", "index": 0, "content_block": {
            "type": "tool_use", "id": "toolu_fixture", "name": "Agent", "input": {},
        }},
        {"type": "content_block_delta", "index": 0, "delta": {
            "type": "input_json_delta",
            "partial_json": json.dumps(tool_input, separators=(",", ":")),
        }},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {
            "stop_reason": "tool_use", "stop_sequence": None,
        }, "usage": {"output_tokens": 12}},
        {"type": "message_stop"},
    ]


@dataclass(frozen=True)
class RunSpec:
    name: str
    model: str
    response: str = "success"
    credential_env: str = "ANTHROPIC_AUTH_TOKEN"
    subagent: bool = False


RUN_SPECS = (
    RunSpec("sonnet_success", "sonnet"),
    RunSpec("opus_success", "opus"),
    RunSpec("haiku_success", "haiku"),
    RunSpec("sonnet_error", "sonnet", response="error"),
    RunSpec("oauth_env_local_error", "sonnet", credential_env="CLAUDE_CODE_OAUTH_TOKEN"),
    RunSpec("subagent_haiku_success", "sonnet", subagent=True),
)


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, spec: RunSpec) -> None:
        super().__init__(("127.0.0.1", 0), CaptureHandler)
        self.spec = spec
        self.requests: list[dict[str, object]] = []
        self.responses: list[dict[str, object]] = []


class CaptureBearerAdapter(AnthropicMessagesApiKeyAdapter):
    adapter_id = "fixture-anthropic-messages/subscription-oauth"

    def __init__(self, upstream_base_url: str) -> None:
        super().__init__(upstream_base_url, None, "claude-sonnet-5")
        self.inbound_headers: list[dict[str, str]] = []
        self._host_bearer: str | None = HOST_BEARER

    def inject_auth(self, headers, route_id: str) -> dict[str, str]:
        if route_id != MESSAGES_BETA_ROUTE or self._host_bearer is None:
            raise AuthInjectionUnavailable("fixture bearer is unavailable")
        self.inbound_headers.append(dict(headers))
        outbound = {
            key: value for key, value in headers.items()
            if key.lower() not in {"authorization", "x-api-key"}
        }
        outbound["Authorization"] = f"Bearer {self._host_bearer}"
        return outbound

    def clear_credential(self) -> None:
        self._host_bearer = None


class CaptureHandler(BaseHTTPRequestHandler):
    def do_CONNECT(self) -> None:
        self._capture_server().requests.append({
            "method": "CONNECT", "path": self.path, "query": "",
            "headers": dict(self.headers.items()), "body": None,
        })
        self.send_response(502)
        self.end_headers()

    def do_POST(self) -> None:
        server = self._capture_server()
        payload = self.rfile.read(int(self.headers.get("content-length", "0")))
        target = urlsplit(self.path)
        server.requests.append({
            "method": "POST", "path": target.path, "query": target.query,
            "headers": dict(self.headers.items()), "body": json.loads(payload),
        })
        self._send_error(server) if server.spec.response == "error" else self._send_stream(server)

    def _send_error(self, server: CaptureServer) -> None:
        document = {
            "type": "error", "error": {
                "type": "invalid_request_error", "message": "synthetic fixture error",
            },
        }
        payload = json.dumps(document, separators=(",", ":")).encode()
        server.responses.append({"status": 400, "content_type": "application/json",
                                 "document": document})
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("x-should-retry", "false")
        self._finish(payload)

    def _send_stream(self, server: CaptureServer) -> None:
        events = tool_events() if server.spec.subagent and len(server.requests) == 1 else text_events()
        payload = b"".join(
            f"event: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n".encode()
            for event in events
        )
        server.responses.append({"status": 200, "content_type": "text/event-stream",
                                 "events": events})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self._finish(payload)

    def _finish(self, payload: bytes) -> None:
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _capture_server(self) -> CaptureServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, _format: str, *_args: object) -> None:
        return


def capture_claude_code_wire(tmp_path: Path) -> dict[str, object]:
    require_isolated_network()
    binary = _claude_binary()
    identity = _check_prerequisites(binary)
    runs = {spec.name: _capture_run(binary, tmp_path / spec.name, spec) for spec in RUN_SPECS}
    runs["trial_proxy_bearer_substitution"] = _capture_proxy_run(
        binary, tmp_path / "trial_proxy_bearer_substitution",
    )
    return {
        "schema_version": "cortex-bench-vendor-wire/1",
        "claude_code_version": identity.version_output.removesuffix(" (Claude Code)"),
        "artifact_sha256": identity.artifact_sha256,
        "capture_method": "real Claude process in bwrap with hidden home; strace connect audit",
        "containment": _containment(runs),
        "observed_model_identifiers": _observed_models(runs),
        "runs": runs,
    }


def _claude_binary() -> Path:
    command = shutil.which("claude")
    if command is None:
        raise RuntimeError("claude is not on PATH")
    return Path(command).resolve()


def _check_prerequisites(binary: Path) -> CliIdentity:
    for command in ("bwrap", "strace"):
        if shutil.which(command) is None:
            raise RuntimeError(f"{command} is required for isolated capture")
    return inspect_binary(binary)


def _capture_run(binary: Path, root: Path, spec: RunSpec) -> dict[str, object]:
    root.mkdir(parents=True)
    server = CaptureServer(spec)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        trace_path = root / "connect.trace"
        argv = _sandbox_argv(binary, spec)
        completed = subprocess.run(
            ["strace", "-f", "-qq", "-e", "trace=connect", "-o", str(trace_path), *argv],
            env=_environment(base_url, spec), capture_output=True, text=True, timeout=30,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return _run_document(spec, argv, completed, server, trace_path)


def _capture_proxy_run(binary: Path, root: Path) -> dict[str, object]:
    root.mkdir(parents=True)
    spec = RunSpec("trial_proxy_bearer_substitution", "sonnet")
    server = CaptureServer(spec)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    upstream_url = f"http://127.0.0.1:{server.server_address[1]}"
    adapter = CaptureBearerAdapter(upstream_url)
    trace_path = root / "connect.trace"
    argv = _sandbox_argv(binary, spec)
    handle: TrialProxyHandle | None = None
    try:
        handle = _start_proxy(root, upstream_url, adapter)
        completed = subprocess.run(
            ["strace", "-f", "-qq", "-e", "trace=connect", "-o", str(trace_path), *argv],
            env=_environment(handle.base_url, spec, handle.dummy_token),
            capture_output=True, text=True, timeout=30,
        )
    finally:
        try:
            if handle is not None:
                handle.stop()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
    document = _run_document(spec, argv, completed, server, trace_path)
    document["proxy_inbound_headers"] = _normalize(adapter.inbound_headers)
    document["proxy_observation"] = _proxy_observation(adapter, server, handle.dummy_token)
    return document


def _start_proxy(
    root: Path, upstream_url: str, adapter: CaptureBearerAdapter,
) -> TrialProxyHandle:
    return start_trial_proxy(
        trial_id="claude-vendor-wire", upstream_base_url=upstream_url, adapter=adapter,
        bound_source_ip="127.0.0.1", absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        limits=ProxyLimits(max_requests=1), log_path=root / "proxy.jsonl",
        lease_terms=LeaseTerms(budget_ms=300_000, teardown_grace_ms=TEARDOWN_GRACE_MS),
    )


def _proxy_observation(
    adapter: CaptureBearerAdapter, server: CaptureServer, trial_dummy: str,
) -> dict[str, bool]:
    inbound = {key.lower(): value for key, value in adapter.inbound_headers[0].items()}
    upstream = {key.lower(): value for key, value in server.requests[0]["headers"].items()}
    return {
        "proxy_admitted_trial_dummy": bool(adapter.inbound_headers),
        "adapter_received_no_container_auth": "authorization" not in inbound,
        "upstream_received_host_bearer": upstream.get("authorization") == f"Bearer {HOST_BEARER}",
        "upstream_received_trial_dummy": upstream.get("authorization") == f"Bearer {trial_dummy}",
    }


def _sandbox_argv(binary: Path, spec: RunSpec) -> list[str]:
    argv = [
        "bwrap", "--die-with-parent", "--unshare-all", "--share-net", "--new-session",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/home", "--dir", "/home/fixture", "--tmpfs", "/tmp",
        "--dir", "/work", "--chdir", "/work", "--ro-bind", str(binary), "/claude",
        "/claude",
    ]
    if not spec.subagent:
        argv.append("--bare")
    return argv + _claude_argv(spec)


def _claude_argv(spec: RunSpec) -> list[str]:
    tools = "Agent" if spec.subagent else ""
    return [
        "--print", "--verbose", "--output-format", "stream-json",
        "--include-partial-messages", "--no-session-persistence", "--tools", tools,
        "--model", spec.model, "--system-prompt", "fixture-system", "fixture-user",
    ]


def _environment(
    base_url: str, spec: RunSpec, credential: str = DUMMY_CREDENTIAL,
) -> dict[str, str]:
    env = {
        "PATH": "/usr/bin:/bin", "HOME": "/home/fixture", "LANG": "C.UTF-8",
        "CLAUDE_CONFIG_DIR": "/home/fixture/.claude", "ANTHROPIC_BASE_URL": base_url,
        "HTTP_PROXY": base_url, "HTTPS_PROXY": base_url, "ALL_PROXY": base_url,
        "NO_PROXY": "127.0.0.1,localhost", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
        "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
    }
    env[spec.credential_env] = credential
    return env


def _run_document(
    spec: RunSpec, argv: list[str], completed: subprocess.CompletedProcess[str],
    server: CaptureServer, trace_path: Path,
) -> dict[str, object]:
    environment = {
        "ANTHROPIC_BASE_URL": "<LOOPBACK_BASE_URL>", spec.credential_env: "<REDACTED>",
    }
    return _normalize({
        "model_argument": spec.model, "credential_environment": environment,
        "argv": ["/claude", *_claude_argv(spec)], "returncode": completed.returncode,
        "requests": server.requests, "synthetic_responses": server.responses,
        "cli_events": [json.loads(line) for line in completed.stdout.splitlines()],
        "stderr": completed.stderr.splitlines(), "connect_trace": _connects(trace_path),
    })


def _connects(trace_path: Path) -> list[str]:
    destinations = []
    for line in trace_path.read_text(encoding="utf-8").splitlines():
        if "sa_family=AF_INET" in line:
            destinations.append(_internet_destination(line))
    return sorted(set(destinations))


def _internet_destination(line: str) -> str:
    if "sa_family=AF_INET6" in line:
        pattern = r'sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^\"]+)"'
    else:
        pattern = r'sin_port=htons\((\d+)\).*?sin_addr=inet_addr\("([^\"]+)"\)'
    match = re.search(pattern, line)
    if match is None:
        raise AssertionError(f"unparsed internet connect trace: {line}")
    port, host = match.groups()
    return f"{host}:{port}"


def _containment(runs: dict[str, dict[str, object]]) -> dict[str, object]:
    connects = sorted({item for run in runs.values() for item in run["connect_trace"]})
    return {
        "real_home_mounted": False,
        "credential_source": "dummy environment only",
        "connect_destinations": connects,
        "non_loopback_connects": [item for item in connects if not _is_loopback(item)],
    }


def _is_loopback(destination: str) -> bool:
    host, _port = destination.rsplit(":", 1)
    return ipaddress.ip_address(host).is_loopback


def _observed_models(runs: dict[str, dict[str, object]]) -> dict[str, str]:
    subagent_requests = runs["subagent_haiku_success"]["requests"]
    return {
        "haiku": _request_model(runs["haiku_success"], 0),
        "opus": _request_model(runs["opus_success"], 0),
        "sonnet": _request_model(runs["sonnet_success"], 0),
        "subagent-haiku": subagent_requests[1]["body"]["model"],
    }


def _request_model(run: dict[str, object], index: int) -> str:
    return run["requests"][index]["body"]["model"]  # type: ignore[index,return-value]


def _normalize(value: Any, key: str | None = None) -> Any:
    if key is not None and key.lower() in {"authorization", "x-api-key"}:
        return "<REDACTED>"
    if key in DYNAMIC_KEYS:
        return f"<{key.upper()}>"
    if key in {"session_id", "uuid"}:
        return "<UUID>"
    if key in {"task_id", "agentId"}:
        return "<TASK_ID>"
    if key in {"total_cost_usd", "costUSD"}:
        return "<SYNTHETIC_COST>"
    if isinstance(value, dict):
        return {name: _normalize(member, name) for name, member in value.items()}
    if isinstance(value, list):
        return [_normalize(member) for member in value]
    if isinstance(value, str):
        return _normalize_text(value)
    return value


def _normalize_text(value: str) -> str:
    value = UUID_PATTERN.sub("<UUID>", value)
    value = DEVICE_PATTERN.sub("<DEVICE_ID>", value)
    value = DATE_PATTERN.sub("Today's date is <CURRENT_DATE>", value)
    value = AUTHORITY_PATTERN.sub("127.0.0.1:<LOOPBACK_PORT>", value)
    value = TASK_PATTERN.sub("<TASK_ID>", value)
    value = re.sub(r"/tmp/claude-\d+", "/tmp/claude-<RUN>", value)
    return value
