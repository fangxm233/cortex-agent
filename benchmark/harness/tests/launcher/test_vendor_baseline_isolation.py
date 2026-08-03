# input:  vendor-baseline arm, Harbor factory, fake environment
# output: built-in class routing and skipped Cortex install assertion
# pos:    Isolation proof for vendor baseline construction
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

from harbor.agents.factory import AgentFactory
from harbor.environments.base import ExecResult

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.arms import build_agent_config


class InstalledClaudeEnvironment:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def exec(self, command: str, **_kwargs: object) -> ExecResult:
        self.calls.append(command)
        if command.endswith("claude --version"):
            return ExecResult(stdout="1.2.3 (Claude Code)\n", return_code=0)
        return ExecResult(return_code=0)


def claude_baseline_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "vendor-baseline",
        "name": "pure-claude-code",
        "vendor_agent": "claude-code",
        "provider": None,
        "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
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


def test_baseline_setup_never_invokes_cortex_install(tmp_path: Path) -> None:
    config = build_agent_config(claude_baseline_arm(), cli_version="1.2.3")
    environment = InstalledClaudeEnvironment()

    with patch.object(CortexBenchAgent, "install", new_callable=AsyncMock) as cortex_install:
        agent = AgentFactory.create_agent_from_config(config, logs_dir=tmp_path / "logs")
        asyncio.run(agent.setup(environment))

    assert agent.name() == "claude-code"
    cortex_install.assert_not_awaited()
    assert any(command.endswith("claude --version") for command in environment.calls)
