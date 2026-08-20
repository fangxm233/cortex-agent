# input:  pinned vendor CLIs, campaign arms, trial proxy, loopback upstream
# output: exact upstream model observations and mismatch refusals
# pos:    Real-process proof for vendor campaign model freezes
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
import shutil
import subprocess
import sys
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

from cortex_bench_harness.proxy import ProxyLimits, start_trial_proxy
from cortex_bench_harness.proxy.adapters import (
    AnthropicMessagesSubscriptionOAuthAdapter,
    DeepSeekChatCompletionsApiKeyAdapter,
    OpenAICodexResponsesOAuthAdapter,
)
from cortex_bench_harness.proxy.adapters.openai_codex_responses import (
    mint_dummy_codex_token,
)
from cortex_bench_harness.proxy.lease import LeaseTerms
from vendor_wire_capture import text_events, tool_events

HARNESS_DIR = Path(__file__).resolve().parents[2]
CAMPAIGN_DIR = HARNESS_DIR.parent / "campaigns"
ISOLATED_ENV = "CORTEX_VENDOR_MODEL_FREEZE_ISOLATED"
COMMANDS = {"pi": "pi", "claude-code": "claude", "codex": "codex"}
FROZEN_MODELS = {
    "claude-code": "claude-sonnet-5",
    "codex": "gpt-5.6-sol",
}
CLAUDE_MODEL_ENVIRONMENT = {
    "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
}
MISMATCH_MODELS = {
    "pi": "deepseek-model-not-declared",
    "claude-code": "claude-haiku-4-5-20251001",
    "codex": "gpt-model-not-declared",
}


def campaign(vendor: str) -> tuple[Path, dict[str, object]]:
    path = CAMPAIGN_DIR / f"terminal-bench-2.1-vendor-{vendor}.yaml"
    return path, yaml.safe_load(path.read_text(encoding="utf-8"))


def arm(vendor: str) -> dict[str, object]:
    return campaign(vendor)[1]["arms"][0]  # type: ignore[index,return-value]


def rerun_isolated(node_id: str) -> None:
    unshare = shutil.which("unshare")
    assert unshare, "unshare is required for zero-egress vendor model tests"
    target = f"{Path(__file__).resolve()}::{node_id.split('::', 1)[1]}"
    env = {**os.environ, ISOLATED_ENV: "1"}
    result = subprocess.run(
        [unshare, "--user", "--map-root-user", "--net", sys.executable,
         "-m", "pytest", "-q", target],
        cwd=HARNESS_DIR, env=env, capture_output=True, text=True, timeout=180,
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"


def require_isolated_network() -> None:
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    routes = Path("/proc/net/route").read_text(encoding="utf-8").splitlines()[1:]
    assert not any(row.split()[1] == "00000000" for row in routes if row.split())


def real_cli(vendor: str) -> Path:
    command = shutil.which(COMMANDS[vendor])
    assert command, f"{COMMANDS[vendor]} is not installed"
    binary = Path(command).resolve()
    completed = subprocess.run(
        [str(binary), "--version"], capture_output=True, text=True, timeout=10,
    )
    expected = str(arm(vendor)["vendor_cli_version"])
    if vendor == "claude-code":
        expected = f"{expected} (Claude Code)"
    elif vendor == "codex":
        expected = f"codex-cli {expected}"
    assert completed.returncode == 0 and completed.stdout.strip() == expected
    return binary


def test_subscription_campaigns_freeze_the_declared_models() -> None:
    claude = arm("claude-code")
    codex = arm("codex")
    codex_wire = json.loads(
        (HARNESS_DIR / "tests/fixtures/vendor-wire/codex/contract.json")
        .read_text(encoding="utf-8")
    )
    claude_wire = json.loads(
        (HARNESS_DIR / "tests/fixtures/vendor-wire/claude-code/wire-capture.json")
        .read_text(encoding="utf-8")
    )

    assert claude["vendor_cli_version"] == "2.1.232"
    assert codex["vendor_cli_version"] == "0.148.0"
    assert claude["model"] == FROZEN_MODELS["claude-code"]
    assert codex["model"] == FROZEN_MODELS["codex"]
    assert claude_wire["observed_model_identifiers"]["sonnet"] == claude["model"]
    assert codex_wire["request"]["model"] == "gpt-5.3-codex"


def test_real_cli_version_check_uses_the_campaign_pin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    binary = tmp_path / "pi"
    binary.touch()
    completed = subprocess.CompletedProcess([str(binary), "--version"], 0, "0.82.1\n", "")
    monkeypatch.setattr(shutil, "which", lambda _command: str(binary))
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: completed)
    monkeypatch.setattr(
        sys.modules[__name__], "arm", lambda _vendor: {"vendor_cli_version": "9.9.9"},
    )

    with pytest.raises(AssertionError):
        real_cli("pi")


def sse(events: list[dict[str, object]]) -> bytes:
    chunks = [
        f"event: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"
        for event in events
    ]
    return "".join(chunks).encode()


def pi_response(model: str) -> bytes:
    documents = [
        {"id": "chatcmpl-freeze", "object": "chat.completion.chunk", "created": 0,
         "model": model, "choices": [{"index": 0, "delta": {"role": "assistant",
         "content": "MODEL_FREEZE_OK"}, "finish_reason": None}]},
        {"id": "chatcmpl-freeze", "object": "chat.completion.chunk", "created": 0,
         "model": model, "choices": [{"index": 0, "delta": {},
         "finish_reason": "stop"}], "usage": {"prompt_tokens": 1,
         "completion_tokens": 1, "total_tokens": 2}},
    ]
    lines = [f"data: {json.dumps(item, separators=(',', ':'))}\n\n" for item in documents]
    return ("".join(lines) + "data: [DONE]\n\n").encode()


def replace_models(value: object, model: str) -> object:
    if isinstance(value, list):
        return [replace_models(item, model) for item in value]
    if isinstance(value, dict):
        return {
            key: model if key == "model" else replace_models(item, model)
            for key, item in value.items()
        }
    return value


def codex_response(model: str) -> bytes:
    fixture = json.loads(
        (HARNESS_DIR / "tests/fixtures/vendor-wire/codex/success-sse.json")
        .read_text(encoding="utf-8")
    )
    events = replace_models(fixture["events"], model)
    return sse(events) + b"data: [DONE]\n\n"  # type: ignore[arg-type]


class SyntheticUpstream(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, vendor: str, model: str, subagent: bool) -> None:
        super().__init__(("127.0.0.1", 0), SyntheticHandler)
        self.vendor = vendor
        self.model = model
        self.subagent = subagent
        self.requests: list[dict[str, object]] = []

    def response(self) -> tuple[str, bytes]:
        if self.vendor == "pi":
            return "text/event-stream", pi_response(self.model)
        if self.vendor == "codex":
            return "text/event-stream", codex_response(self.model)
        events = tool_events() if self.subagent and len(self.requests) == 1 else text_events()
        return "text/event-stream", sse(events)


class SyntheticHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        server: SyntheticUpstream = self.server  # type: ignore[assignment]
        payload = self.rfile.read(int(self.headers.get("content-length", "0")))
        server.requests.append({
            "path": self.path, "headers": dict(self.headers.items()),
            "body": json.loads(payload),
        })
        content_type, body = server.response()
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def adapter_for(vendor: str, upstream: str, model: str):
    if vendor == "pi":
        return DeepSeekChatCompletionsApiKeyAdapter(
            upstream, "host-only-dummy-pi", model, frozen_completion_cap=8192,
        )
    if vendor == "claude-code":
        return AnthropicMessagesSubscriptionOAuthAdapter(
            upstream, "host-only-dummy-claude", model,
        )
    return OpenAICodexResponsesOAuthAdapter(
        upstream, mint_dummy_codex_token(), model,
    )


def clean_environment(root: Path) -> dict[str, str]:
    node = Path(shutil.which("node") or "/usr/bin/node")
    path = os.pathsep.join(dict.fromkeys((
        str(node.parent), str(node.resolve().parent), "/usr/bin", "/bin",
    )))
    return {
        "HOME": str(root), "PATH": path, "LANG": "C.UTF-8",
        "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
    }


def run_pi(binary: Path, root: Path, proxy_url: str, token: str, model: str):
    agent_dir = root / "pi-agent"
    agent_dir.mkdir()
    auth = {"deepseek": {"type": "api_key", "key": token}}
    provider = {"baseUrl": f"{proxy_url}/v1", "api": "openai-completions",
                "models": [{"id": model, "name": model, "reasoning": False,
                "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}
    (agent_dir / "auth.json").write_text(json.dumps(auth), encoding="utf-8")
    (agent_dir / "models.json").write_text(
        json.dumps({"providers": {"deepseek": provider}}), encoding="utf-8",
    )
    env = {**clean_environment(root), "PI_CODING_AGENT_DIR": str(agent_dir),
           "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}
    argv = [str(binary), "--print", "--mode", "json", "--no-session", "--no-tools",
            "--no-extensions", "--no-skills", "--no-context-files", "--provider",
            "deepseek", "--model", model, "Reply MODEL_FREEZE_OK"]
    return subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True, timeout=45)


def claude_environment(root: Path, proxy_url: str, token: str, model: str) -> dict[str, str]:
    return {
        **clean_environment(root), "CLAUDE_CONFIG_DIR": str(root / ".claude"),
        "ANTHROPIC_BASE_URL": proxy_url, "ANTHROPIC_AUTH_TOKEN": token,
        "ANTHROPIC_MODEL": model, "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": model, "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
        "CLAUDE_CODE_SUBAGENT_MODEL": model,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
    }


def test_claude_environment_collapses_aliases_and_subagents_to_one_model(
    tmp_path: Path,
) -> None:
    model = FROZEN_MODELS["claude-code"]
    environment = claude_environment(tmp_path, "http://127.0.0.1:1", "dummy", model)

    assert {environment[name] for name in CLAUDE_MODEL_ENVIRONMENT} == {model}


def run_claude(
    binary: Path, root: Path, proxy_url: str, token: str, model: str,
    selection: str, *, subagent: bool,
):
    argv = [str(binary), "--print", "--verbose", "--output-format", "stream-json",
            "--include-partial-messages", "--no-session-persistence", "--tools",
            "Agent" if subagent else "", "--model", selection,
            "--system-prompt", "model freeze system", "Reply MODEL_FREEZE_OK"]
    if not subagent:
        argv.insert(1, "--bare")
    return subprocess.run(
        argv, cwd=root, env=claude_environment(root, proxy_url, token, model),
        capture_output=True, text=True, timeout=60,
    )


def codex_token_json(token: str) -> dict[str, object]:
    return {"tokens": {"id_token": token, "access_token": token,
                       "refresh_token": "dummy-refresh-never-forward"},
            "last_refresh": datetime.now(UTC).isoformat()}


def run_codex(binary: Path, root: Path, proxy_url: str, token: str, model: str):
    home = root / ".codex"
    home.mkdir()
    (home / "auth.json").write_text(json.dumps(codex_token_json(token)), encoding="utf-8")
    config = (
        f"model = {json.dumps(model)}\nmodel_provider = \"synthetic\"\n"
        "model_reasoning_effort = \"high\"\nweb_search = \"disabled\"\n"
        "[model_providers.synthetic]\nname = \"synthetic\"\n"
        f"base_url = {json.dumps(proxy_url + '/codex')}\n"
        "wire_api = \"responses\"\nrequires_openai_auth = true\n"
    )
    (home / "config.toml").write_text(config, encoding="utf-8")
    env = {**clean_environment(root), "CODEX_HOME": str(home)}
    argv = [str(binary), "exec", "--skip-git-repo-check", "--ephemeral", "--json",
            "Reply MODEL_FREEZE_OK"]
    return subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True, timeout=60)


def run_vendor(
    vendor: str, binary: Path, root: Path, proxy_url: str, token: str,
    declared: str, selected: str, *, subagent: bool,
):
    if vendor == "pi":
        return run_pi(binary, root, proxy_url, token, selected)
    if vendor == "claude-code":
        return run_claude(
            binary, root, proxy_url, token, declared, selected, subagent=subagent,
        )
    return run_codex(binary, root, proxy_url, token, selected)


def audit_outcomes(path: Path) -> list[str]:
    return [
        item["outcome"] for item in (
            json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
        ) if "outcome" in item
    ]


def exercise(
    tmp_path: Path, vendor: str, declared: str, selected: str, *, subagent: bool = False,
) -> tuple[subprocess.CompletedProcess[str], list[dict[str, object]], list[str]]:
    upstream = SyntheticUpstream(vendor, declared, subagent)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    upstream_url = f"http://127.0.0.1:{upstream.server_port}"
    log_path = tmp_path / "proxy.jsonl"
    handle = start_trial_proxy(
        trial_id=f"model-freeze-{vendor}", upstream_base_url=upstream_url,
        adapter=adapter_for(vendor, upstream_url, declared), bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=2),
        limits=ProxyLimits(max_requests=20), log_path=log_path,
        lease_terms=LeaseTerms(budget_ms=120_000, teardown_grace_ms=1_000),
    )
    try:
        result = run_vendor(
            vendor, real_cli(vendor), tmp_path, handle.base_url, handle.dummy_token,
            declared, selected, subagent=subagent,
        )
    finally:
        handle.stop()
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=2)
    return result, upstream.requests, audit_outcomes(log_path)


def isolated_or_rerun(request: pytest.FixtureRequest) -> bool:
    if os.environ.get(ISOLATED_ENV) == "1":
        require_isolated_network()
        return True
    rerun_isolated(request.node.nodeid)
    return False


@pytest.mark.parametrize("vendor", ("pi", "claude-code", "codex"))
def test_pinned_vendor_cli_transmits_campaign_model_unchanged(
    vendor: str, tmp_path: Path, request: pytest.FixtureRequest,
) -> None:
    if not isolated_or_rerun(request):
        return
    declared = str(arm(vendor)["model"])
    result, requests, outcomes = exercise(tmp_path, vendor, declared, declared)

    assert result.returncode == 0, result.stderr
    assert [item["body"]["model"] for item in requests] == [declared]  # type: ignore[index]
    assert "request_model_mismatch" not in outcomes


@pytest.mark.parametrize("vendor", ("pi", "claude-code", "codex"))
def test_proxy_refuses_real_cli_model_mismatch_before_upstream(
    vendor: str, tmp_path: Path, request: pytest.FixtureRequest,
) -> None:
    if not isolated_or_rerun(request):
        return
    declared = str(arm(vendor)["model"])
    _result, requests, outcomes = exercise(
        tmp_path, vendor, declared, MISMATCH_MODELS[vendor],
    )

    assert requests == []
    assert "request_model_mismatch" in outcomes


def test_claude_aliases_resolve_to_the_frozen_campaign_model(
    tmp_path: Path, request: pytest.FixtureRequest,
) -> None:
    if not isolated_or_rerun(request):
        return
    declared = str(arm("claude-code")["model"])
    for alias in ("sonnet", "opus", "haiku"):
        root = tmp_path / alias
        root.mkdir()
        result, requests, outcomes = exercise(root, "claude-code", declared, alias)
        assert result.returncode == 0, result.stderr
        assert [item["body"]["model"] for item in requests] == [declared]  # type: ignore[index]
        assert "request_model_mismatch" not in outcomes


def test_claude_subagent_requests_use_the_frozen_campaign_model(
    tmp_path: Path, request: pytest.FixtureRequest,
) -> None:
    if not isolated_or_rerun(request):
        return
    declared = str(arm("claude-code")["model"])
    result, requests, outcomes = exercise(
        tmp_path, "claude-code", declared, "sonnet", subagent=True,
    )
    observed = [item["body"]["model"] for item in requests]  # type: ignore[index]

    assert result.returncode == 0, result.stderr
    assert len(observed) >= 2
    assert set(observed) == {declared}
    assert "request_model_mismatch" not in outcomes


@pytest.mark.parametrize("vendor", ("pi", "claude-code", "codex"))
def test_campaign_marks_provider_acceptance_unverified_until_live(vendor: str) -> None:
    path, document = campaign(vendor)
    text = path.read_text(encoding="utf-8").lower()

    assert document["arms"][0]["model"]  # type: ignore[index]
    assert "provider acceptance: unverified-until-live" in text
