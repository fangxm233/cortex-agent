# input:  Harbor base class, fake exec results, adapter metadata
# output: setup lifecycle, manifest, and argv assertions
# pos:    Contract tests for the Harbor agent wrapper
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
from collections.abc import Sequence
from pathlib import Path

import pytest
from harbor.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult

from cortex_bench_harness.harbor_agent import CortexBenchAgent


class FakeEnvironment:
    def __init__(self, results: Sequence[ExecResult]) -> None:
        self._results = iter(results)
        self.commands: list[str] = []

    async def exec(self, command: str, **_kwargs: object) -> ExecResult:
        self.commands.append(command)
        return next(self._results)


def ok(stdout: str | None = None) -> ExecResult:
    return ExecResult(stdout=stdout, return_code=0)


def make_agent(tmp_path: Path) -> CortexBenchAgent:
    wheel_path = tmp_path / "cortex_bench_harness-0.1.0-py3-none-any.whl"
    lockfile_path = tmp_path / "uv.lock"
    wheel_path.write_bytes(b"wheel")
    lockfile_path.write_bytes(b"lock")
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent",
        artifact_dir=tmp_path / "artifacts",
        manifest={
            "root_run_id": "root-install-only",
            "trial_id": "trial-install-only",
            "arm": "cortex-direct",
            "wheel_path": str(wheel_path),
            "lockfile_path": str(lockfile_path),
            "lockfile_manifest_path": "benchmark/harness/uv.lock",
            "image_ref": "debian@sha256:abc",
            "image_digest": None,
            "image_size_bytes": None,
        },
    )


def test_wrapper_is_real_harbor_installed_agent() -> None:
    assert issubclass(CortexBenchAgent, BaseInstalledAgent)
    assert CortexBenchAgent.import_path().endswith(":CortexBenchAgent")


def test_setup_resolves_cwd_runs_base_install_and_writes_manifest(tmp_path: Path) -> None:
    environment = FakeEnvironment([ok("/app\n"), ok("/app\n"), ok(), ok(), ok()])
    agent = make_agent(tmp_path)

    asyncio.run(agent.setup(environment))

    assert environment.commands == [
        "pwd",
        "realpath -- /app",
        "test -d /app",
        "[ -d /installed-agent ] || mkdir -p /installed-agent",
        "set -o pipefail; command -v cortex >/dev/null 2>&1",
    ]
    assert (tmp_path / "artifacts" / "cortex-bench-harness-manifest.json").is_file()


def test_failed_install_does_not_publish_manifest(tmp_path: Path) -> None:
    failed = ExecResult(stderr="missing", return_code=127)
    environment = FakeEnvironment([ok("/app\n"), ok("/app\n"), ok(), ok(), failed])

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path).setup(environment))

    assert not (tmp_path / "artifacts" / "cortex-bench-harness-manifest.json").exists()


def test_preview_argv_contains_resolved_cwd(tmp_path: Path) -> None:
    environment = FakeEnvironment([ok("/app\n"), ok("/app\n"), ok(), ok(), ok()])
    agent = make_agent(tmp_path)
    asyncio.run(agent.setup(environment))

    assert agent.preview_run_argv() == [
        "cortex",
        "agent-run",
        "--prompt-file",
        "/logs/agent/instruction.md",
        "--agent-slot",
        "parent",
        "--profile",
        "benchmark",
        "--cwd",
        "/app",
        "--output-format",
        "jsonl",
        "--events-file",
        "/logs/agent/trajectory/events.jsonl",
        "--trajectory-root",
        "/logs/agent/trajectory",
        "--root-run-id",
        "root-install-only",
    ]
