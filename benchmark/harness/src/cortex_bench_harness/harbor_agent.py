# input:  Harbor lifecycle, manifest seed, and task instruction
# output: installed Cortex agent execution and H3 manifest
# pos:    Harbor BaseInstalledAgent wrapper for Cortex
# >>> If I am updated, update my header and folder CORTEX.md <<<

import shlex
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from .cwd import ResolvedCwd, resolve_task_workdir
from .manifest import (
    HarnessManifestSeed,
    build_harness_manifest,
    parse_manifest_seed,
    write_harness_manifest,
)

PACKAGE_VERSION = "0.1.0"
PROFILE_NAME = "benchmark"


class CortexBenchAgent(BaseInstalledAgent):
    def __init__(
        self,
        logs_dir: Path,
        artifact_dir: Path | str,
        manifest: Mapping[str, object],
        *args: object,
        **kwargs: Any,
    ) -> None:
        self._artifact_dir = Path(artifact_dir)
        self._manifest_seed: HarnessManifestSeed = parse_manifest_seed(manifest)
        self._resolved_cwd: ResolvedCwd | None = None
        super().__init__(logs_dir, *args, version=PACKAGE_VERSION, **kwargs)

    @staticmethod
    @override
    def name() -> str:
        return "cortex-bench"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        command = "command -v cortex >/dev/null 2>&1"
        result = await self.exec_as_agent(environment, command=command)
        self.logger.info(
            "container exec command=%r return_code=%s stdout=%r stderr=%r",
            command,
            result.return_code,
            result.stdout,
            result.stderr,
        )

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        resolved_cwd = await resolve_task_workdir(environment)
        await super().setup(environment)
        document = build_harness_manifest(self._manifest_seed.with_cwd(resolved_cwd))
        write_harness_manifest(self._artifact_dir, document)
        self._resolved_cwd = resolved_cwd

    def _agent_paths(self) -> tuple[PurePosixPath, PurePosixPath, PurePosixPath]:
        agent_dir = EnvironmentPaths().agent_dir
        return (
            agent_dir / "instruction.md",
            agent_dir / "trajectory" / "events.jsonl",
            agent_dir / "trajectory",
        )

    def preview_run_argv(self) -> list[str]:
        if self._resolved_cwd is None:
            raise RuntimeError("CortexBenchAgent.setup() must complete before run")
        prompt_path, events_path, trajectory_root = self._agent_paths()
        return self._build_run_argv(prompt_path, events_path, trajectory_root)

    def _build_run_argv(
        self, prompt_path: PurePosixPath, events_path: PurePosixPath,
        trajectory_root: PurePosixPath,
    ) -> list[str]:
        assert self._resolved_cwd is not None
        return [
            "cortex", "agent-run", "--prompt-file", str(prompt_path),
            "--agent-slot", "parent", "--profile", PROFILE_NAME,
            "--cwd", self._resolved_cwd.realpath, "--output-format", "jsonl",
            "--events-file", str(events_path), "--trajectory-root", str(trajectory_root),
            "--root-run-id", self._manifest_seed.root_run_id,
        ]

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        _context: AgentContext,
    ) -> None:
        if self._resolved_cwd is None:
            raise RuntimeError("CortexBenchAgent.setup() must complete before run")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "instruction.md").write_text(instruction)
        _, _, trajectory_root = self._agent_paths()
        await self.exec_as_agent(environment, f"mkdir -p {shlex.quote(str(trajectory_root))}")
        await self.exec_as_agent(
            environment,
            shlex.join(self.preview_run_argv()),
            cwd=self._resolved_cwd.realpath,
        )
