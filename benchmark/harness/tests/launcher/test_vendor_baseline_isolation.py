# input:  vendor-baseline arms, Harbor factory, fake environment
# output: native routing and absence of Cortex runtime/config/artifacts
# pos:    Isolation proof for all vendor baseline paths
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from harbor.agents.factory import AgentFactory
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from cortex_bench_harness.launcher.arms import build_agent_config


VENDORS = (
    ("claude-code", None, "claude-sonnet", "harbor.agents.installed.claude_code"),
    ("pi", "openai", "gpt-5", "harbor.agents.installed.pi"),
    ("codex", None, "gpt-5", "harbor.agents.installed.codex"),
)


class NativeEnvironment:
    default_user = "agent"

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def exec(self, command: str, **_kwargs: object) -> ExecResult:
        self.calls.append(command)
        if "claude --version" in command:
            return ExecResult(stdout="1.2.3 (Claude Code)\n", return_code=0)
        if "codex --version" in command:
            return ExecResult(stdout="codex-cli 1.2.3\n", return_code=0)
        if "pi --version" in command:
            return ExecResult(stdout="1.2.3\n", return_code=0)
        return ExecResult(return_code=0)


def baseline_arm(
    vendor_agent: str, provider: str | None, model: str,
) -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "vendor-baseline",
        "name": f"pure-{vendor_agent}",
        "vendor_agent": vendor_agent,
        "provider": provider,
        "model": model,
        "credential_capability": f"{vendor_agent}-credential",
        "limits": {
            "max_thread_starts": 0,
            "max_parent_questions": 0,
            "max_task_depth": 0,
            "max_tasks": 0,
            "max_provider_requests": 8,
            "max_resident_agent_processes": 1,
            "max_cost_usd": "2.50",
            "deadline_seconds": 90,
        },
    }


def _run_native_path(agent: object, environment: NativeEnvironment) -> None:
    async def exercise() -> None:
        await agent.setup(environment)  # type: ignore[attr-defined]
        await agent.run(  # type: ignore[attr-defined]
            "solve the task", environment, AgentContext(),
        )

    asyncio.run(exercise())


@pytest.mark.parametrize(("vendor", "provider", "model", "module"), VENDORS)
def test_baseline_uses_only_the_native_harbor_path(
    tmp_path: Path, vendor: str, provider: str | None, model: str, module: str,
) -> None:
    config = build_agent_config(
        baseline_arm(vendor, provider, model), cli_version="1.2.3",
        env={"ANTHROPIC_API_KEY": "dummy", "OPENAI_API_KEY": "dummy"},
    )
    logs_dir = tmp_path / vendor
    agent = AgentFactory.create_agent_from_config(config, logs_dir=logs_dir)
    environment = NativeEnvironment()

    _run_native_path(agent, environment)

    assert type(agent).__module__ == module
    assert config.import_path is None
    assert config.kwargs == {"version": "1.2.3"}
    assert config.skills == []
    assert config.mcp_servers == []
    assert all("cortex" not in command.casefold() for command in environment.calls)
    assert all("cortex" not in path.name.casefold() for path in logs_dir.rglob("*"))


@pytest.mark.parametrize("field", [
    "backend", "orchestration", "plugin_dirs", "task_store", "coordinator",
    "artifact_inventory_spec",
])
def test_baseline_rejects_cortex_composition_fields(field: str) -> None:
    arm = baseline_arm("claude-code", None, "claude-sonnet")
    arm[field] = {"configured": True}

    with pytest.raises(ValueError, match="Cortex composition"):
        build_agent_config(arm, cli_version="1.2.3")


def test_baseline_launcher_import_does_not_import_cortex_agent() -> None:
    source_root = Path(__file__).parents[2] / "src"
    script = """
import json
import sys
from cortex_bench_harness.launcher.arms import build_agent_config
arm = json.loads(sys.argv[1])
build_agent_config(arm, cli_version='1.2.3')
assert 'cortex_bench_harness.harbor_agent' not in sys.modules
"""
    arm = baseline_arm("claude-code", None, "claude-sonnet")
    environment = {**os.environ, "PYTHONPATH": str(source_root)}

    result = subprocess.run(
        [sys.executable, "-c", script, json.dumps(arm)],
        check=False, capture_output=True, text=True, env=environment,
    )

    assert result.returncode == 0, result.stderr
