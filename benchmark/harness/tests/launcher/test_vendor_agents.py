# input:  admitted vendor arms, fake proxy, recording environment
# output: dummy runtime, completion-cap, and setup proofs
# pos:    Contract tests for preinstalled vendor lifecycle agents
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from harbor.agents.factory import AgentFactory
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.pi import Pi
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from cortex_bench_harness.launcher.arms import build_agent_config
from cortex_bench_harness.vendor_agents import (
    PreinstalledClaudeCode,
    PreinstalledCodex,
    PreinstalledPi,
    VendorPreflightError,
)


VENDORS = (
    ("pi", "deepseek", "deepseek-chat", PreinstalledPi, Pi, "1.2.3\n"),
    (
        "claude-code", None, "claude-sonnet", PreinstalledClaudeCode,
        ClaudeCode, "1.2.3 (Claude Code)\n",
    ),
    ("codex", None, "gpt-5.3-codex", PreinstalledCodex, Codex, "codex-cli 1.2.3\n"),
)


class RecordingEnvironment:
    default_user = "agent"

    def __init__(self, version_stdout: str, version_return_code: int = 0) -> None:
        self.calls: list[dict[str, object]] = []
        self.version_stdout = version_stdout
        self.version_return_code = version_return_code

    async def exec(self, command: str, **kwargs: object) -> ExecResult:
        self.calls.append({"command": command, **kwargs})
        if len(self.calls) == 1:
            return ExecResult(return_code=0)
        return ExecResult(
            stdout=self.version_stdout, return_code=self.version_return_code,
        )

    async def upload_file(self, source: Path, destination: str) -> None:
        self.calls.append({"upload": source, "destination": destination})


def vendor_arm(vendor: str, provider: str | None, model: str) -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "vendor-baseline",
        "name": f"pure-{vendor}",
        "vendor_agent": vendor,
        "vendor_cli_version": "1.2.3",
        "provider": provider,
        "model": model,
        "credential_capability": f"{vendor}-credential",
        "limits": {
            "max_provider_requests": 1,
            "max_cost_usd": "1.00",
            "deadline_seconds": 30,
            "max_output_tokens": 65_536,
        },
    }


def vendor_trial_seed(arm: dict[str, object]) -> dict[str, object]:
    digest = f"sha256:{'a' * 64}"
    return {
        "arm": arm, "arm_path": f"arm://{arm['name']}",
        "trial_id": "vendor-unit-trial", "root_run_id": "vendor-unit-root",
        "task": {
            "task_id": "synthetic-task", "image_ref": f"image.invalid/task@{digest}",
            "image_digest": digest,
        },
        "profile_name": "benchmark", "paid_run": False,
        "credential": {
            "upstream_base_url": "http://127.0.0.1:1",
            "route_identity_host": "api.deepseek.com",
            "proxy_base_url": "http://trial-proxy.invalid",
            "dummy_token_ref": "dummy-only",
        },
        "model_alias_policy": {"kind": "exact"},
    }


def create_agent(
    tmp_path: Path, vendor: str, provider: str | None, model: str,
    *, admitted: bool = False,
) -> object:
    arm = vendor_arm(vendor, provider, model)
    lifecycle: dict[str, object] = {}
    if admitted:
        lifecycle = {
            "artifact_dir": tmp_path / "artifacts", "manifest": {},
            "trial_seed": vendor_trial_seed(arm), "trial_proxy": {},
            "defer_proxy_arm": True,
        }
    config = build_agent_config(
        arm, cli_version="ignored", **lifecycle,  # type: ignore[arg-type]
    )
    agent = AgentFactory.create_agent_from_config(config, logs_dir=tmp_path / vendor)
    agent._proxy_session = SimpleNamespace(  # type: ignore[attr-defined]
        handle=SimpleNamespace(
            base_url="http://trial-proxy.invalid:4312",
            dummy_token="dummy.jwt.token",
        )
    )
    return agent


@pytest.mark.parametrize(
    ("vendor", "provider", "model", "_expected_class", "_harbor_class", "stdout"),
    VENDORS,
)
def test_setup_writes_and_records_dummy_files_before_exact_version_preflight(
    tmp_path: Path, vendor: str, provider: str | None, model: str,
    _expected_class: type, _harbor_class: type, stdout: str,
) -> None:
    agent = create_agent(
        tmp_path, vendor, provider, model, admitted=vendor == "pi",
    )
    environment = RecordingEnvironment(stdout)

    asyncio.run(agent.setup(environment))  # type: ignore[attr-defined]

    assert len(environment.calls) == 2
    setup_command = str(environment.calls[0]["command"])
    version_command = str(environment.calls[1]["command"])
    assert "vendor-runtime-files.json" in setup_command
    assert vendor.split("-")[0] in version_command
    assert not any(
        forbidden in setup_command
        for forbidden in ("apt-get", "apk add", "curl ", "wget ", "npm install")
    )


@pytest.mark.parametrize(
    ("vendor", "provider", "model", "_expected_class", "harbor_class", "_stdout"),
    VENDORS,
)
@pytest.mark.parametrize("version_stdout", ["", "9.9.9\n"])
def test_version_preflight_fails_closed_without_entering_install_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version_stdout: str,
    vendor: str, provider: str | None, model: str, _expected_class: type,
    harbor_class: type, _stdout: str,
) -> None:
    agent = create_agent(
        tmp_path, vendor, provider, model, admitted=vendor == "pi",
    )
    environment = RecordingEnvironment(version_stdout, 127 if not version_stdout else 0)
    installs: list[object] = []
    revocations: list[object] = []
    monkeypatch.setattr(harbor_class, "install", lambda *args: installs.append(args))
    monkeypatch.setattr(agent, "revoke_admitted_proxy", lambda: revocations.append(object()))

    with pytest.raises(VendorPreflightError):
        asyncio.run(agent.setup(environment))  # type: ignore[attr-defined]

    assert installs == []
    assert len(revocations) == 1
    assert len(environment.calls) == 2
    assert all(
        forbidden not in str(call["command"])
        for call in environment.calls
        for forbidden in ("apt-get", "curl ", "wget ", "npm install")
    )


def test_pi_dummy_auth_and_models_bind_only_the_trial_proxy(tmp_path: Path) -> None:
    agent = create_agent(
        tmp_path, "pi", "deepseek", "deepseek-chat", admitted=True,
    )
    files = {item.path.name: item for item in agent._runtime_files()}  # type: ignore[attr-defined]
    auth = json.loads(files["auth.json"].content)
    models = json.loads(files["models.json"].content)
    provider = models["providers"]["deepseek"]

    assert files["auth.json"].mode == 0o600
    assert auth == {"deepseek": {"type": "api_key", "key": "dummy.jwt.token"}}
    assert provider["baseUrl"] == "http://trial-proxy.invalid:4312/v1"
    assert provider["models"][0]["maxTokens"] == 65_536
    assert "dummy.jwt.token" not in files["models.json"].content


def test_codex_uses_p0_proven_provider_config_and_dummy_jwt(tmp_path: Path) -> None:
    agent = create_agent(tmp_path, "codex", None, "gpt-5.3-codex")
    files = {item.path.name: item for item in agent._runtime_files()}  # type: ignore[attr-defined]
    auth = json.loads(files["auth.json"].content)
    config = files["config.toml"].content

    assert files["auth.json"].mode == 0o600
    assert auth["tokens"] == {
        "id_token": "dummy.jwt.token",
        "access_token": "dummy.jwt.token",
        "refresh_token": "dummy-refresh-never-forward",
    }
    assert 'model_provider = "cortex_trial_proxy"' in config
    assert 'base_url = "http://trial-proxy.invalid:4312/codex"' in config
    assert "OPENAI_BASE_URL" not in config


def test_claude_uses_native_default_while_proxy_freezes_observed_model(
    tmp_path: Path,
) -> None:
    agent = create_agent(tmp_path, "claude-code", None, "claude-opus-5")

    environment = agent._claude_process_environment({})  # type: ignore[attr-defined]

    assert not {
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    }.intersection(environment)
    assert agent.model_name == "claude-opus-5"  # type: ignore[attr-defined]


def test_file_evidence_records_verified_mode_and_content_digest(tmp_path: Path) -> None:
    agent = create_agent(
        tmp_path, "pi", "deepseek", "deepseek-chat", admitted=True,
    )
    files = agent._runtime_files()  # type: ignore[attr-defined]
    evidence = agent._runtime_file_evidence(files)  # type: ignore[attr-defined]

    assert evidence["recorded_before_vendor_cli"] is True
    for record, runtime_file in zip(evidence["files"], files, strict=True):
        assert record == {
            "path": runtime_file.path.as_posix(),
            "mode": format(runtime_file.mode, "04o"),
            "sha256": hashlib.sha256(runtime_file.content.encode()).hexdigest(),
        }


def test_route_revocation_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = create_agent(tmp_path, "pi", "deepseek", "deepseek-chat")
    calls: list[object] = []
    marker = object()

    def revoke(session: object, *, capture_inventory: object) -> object:
        calls.append((session, capture_inventory))
        return marker

    monkeypatch.setattr("cortex_bench_harness.vendor_agents.revoke_trial_proxy", revoke)

    agent.revoke_admitted_proxy()  # type: ignore[attr-defined]
    agent.revoke_admitted_proxy()  # type: ignore[attr-defined]

    assert len(calls) == 1
    assert agent.revocation is marker  # type: ignore[attr-defined]


def test_run_failure_delegates_to_harbor_and_revokes_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = create_agent(tmp_path, "pi", "deepseek", "deepseek-chat")
    calls: list[str] = []
    revocations: list[object] = []

    async def harbor_run(*_args: object, **_kwargs: object) -> None:
        calls.append("harbor-run")
        raise RuntimeError("synthetic run failure")

    monkeypatch.setattr(Pi, "run", harbor_run)
    monkeypatch.setattr(agent, "revoke_admitted_proxy", lambda: revocations.append(object()))

    with pytest.raises(RuntimeError, match="synthetic run failure"):
        asyncio.run(agent.run("task", RecordingEnvironment(""), AgentContext()))  # type: ignore[attr-defined]

    assert calls == ["harbor-run"]
    assert len(revocations) == 1


@pytest.mark.parametrize(
    ("vendor", "provider", "model", "ambient"),
    [
        ("pi", "openai", "gpt-5", {"OPENAI_API_KEY": "real-host-pi-secret"}),
        (
            "claude-code", None, "claude-sonnet",
            {
                "ANTHROPIC_API_KEY": "real-host-claude-secret",
                "ANTHROPIC_BASE_URL": "https://host-claude.invalid",
            },
        ),
        (
            "codex", None, "gpt-5.3-codex",
            {"OPENAI_BASE_URL": "https://host-codex.invalid"},
        ),
    ],
)
def test_native_run_cannot_inline_ambient_host_routing_or_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor: str,
    provider: str | None, model: str, ambient: dict[str, str],
) -> None:
    agent = create_agent(tmp_path, vendor, provider, model)
    if vendor == "codex":
        auth_source = agent._resolve_auth_json_path()  # type: ignore[attr-defined]
        auth_source.parent.mkdir(parents=True)
        auth_source.write_text("{}")
    for key, value in ambient.items():
        monkeypatch.setenv(key, value)
    environment = RecordingEnvironment("")

    asyncio.run(agent.run("task instruction", environment, AgentContext()))  # type: ignore[attr-defined]

    commands = "\n".join(
        str(call["command"]) for call in environment.calls if "command" in call
    )
    assert all(value not in commands for value in ambient.values())
    if vendor == "codex":
        assert "OPENAI_BASE_URL" not in commands


def test_per_process_environment_is_inlined_without_weakening_the_seal(
    tmp_path: Path,
) -> None:
    agent = create_agent(tmp_path, "claude-code", None, "claude-sonnet")
    environment = RecordingEnvironment("")

    asyncio.run(
        agent._exec(  # type: ignore[attr-defined]
            environment, "claude --version",
            env={"HARBOR_CLAUDE_CODE_INSTRUCTION_ABC": "value with spaces"},
        )
    )

    assert environment.calls[0].get("env") is None
    assert (
        "export HARBOR_CLAUDE_CODE_INSTRUCTION_ABC='value with spaces'"
        in str(environment.calls[0]["command"])
    )
