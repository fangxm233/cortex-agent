# input:  Harbor lifecycle, npm bundle, manifest, trial seed
# output: identity-bound admission, container facts, phase-A input
# pos:    Harbor BaseInstalledAgent wrapper for Cortex
# >>> If I am updated, update my header and folder CORTEX.md <<<

import shlex
import shutil
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from .cwd import ResolvedCwd, resolve_task_workdir
from .launcher.arm_resolution import (
    ARM_RESOLUTION_CONTAINER_PATH,
    ContainerFacts,
    TrialSeed,
    compose_arm_resolution,
    parse_trial_seed,
    write_arm_resolution,
)
from .launcher.arms import backend_cli_binary, require_composable_arm
from .launcher.trial_proxy import (
    TrialProxySession,
    arm_trial_proxy,
    capture_trial_inventory,
    parse_trial_proxy_spec,
    revoke_trial_proxy,
)
from .manifest import (
    MANIFEST_FILENAME,
    HarnessManifestSeed,
    build_harness_manifest,
    parse_manifest_seed,
    write_harness_manifest,
)
from .proxy.manifest import fill_proxy_manifest
from .scan.models import ArtifactInventory

PACKAGE_VERSION = "0.1.0"
PROFILE_NAME = "benchmark"
NPM_INSTALL_PREFIX = PurePosixPath("/installed-agent/npm")
BUNDLE_PACKAGE = "@cortex-agent/server"
SUPERVISOR_PATH = PurePosixPath("native/cortex-supervisor/dist/cortex-supervisor")
VERSION_COMMAND = "cortex daemon --version"


class CortexBenchAgent(BaseInstalledAgent):
    _allow_unsupported_fixture_seed = False

    def __init__(
        self,
        logs_dir: Path,
        artifact_dir: Path | str,
        manifest: Mapping[str, object],
        trial_seed: Mapping[str, object],
        *args: object,
        trial_proxy: Mapping[str, object] | None = None,
        version: str = PACKAGE_VERSION,
        **kwargs: Any,
    ) -> None:
        self._artifact_dir = Path(artifact_dir)
        self._manifest_seed: HarnessManifestSeed = parse_manifest_seed(manifest)
        self._trial_seed: TrialSeed = parse_trial_seed(trial_seed)
        self._validate_trial_seed_binding()
        if not self._allow_unsupported_fixture_seed:
            require_composable_arm(self._trial_seed.arm)
        self._resolved_cwd: ResolvedCwd | None = None
        self._staged_npm_artifact: Path | None = None
        self._cortex_cli_version: str | None = None
        self._container_facts: ContainerFacts | None = None
        self._captured_inventory: ArtifactInventory | None = None
        super().__init__(logs_dir, *args, version=version, **kwargs)
        # Harbor builds the agent inside `Trial.__init__` and creates the container much later,
        # from `Trial.run()`. This is therefore the last instant before the container exists, and
        # the one place the route can be armed with a bound the container has not influenced.
        self._proxy_session = self._arm_proxy(trial_proxy)

    @staticmethod
    @override
    def name() -> str:
        return "cortex-bench"

    @property
    def proxy_session(self) -> TrialProxySession | None:
        """The armed credential route, or None for a trial that declared no proxy."""
        return self._proxy_session

    @property
    def captured_inventory(self) -> ArtifactInventory | None:
        """The artifact-dir inventory captured at revocation. A trial runner extends it with the
        log-dir sources it owns; the proxy's four sources are already declared expected here."""
        return self._captured_inventory

    def _arm_proxy(
        self, trial_proxy: Mapping[str, object] | None,
    ) -> TrialProxySession | None:
        if trial_proxy is None:
            # A paid trial exchanges a real credential, so it may not run without the host route
            # that keeps that credential out of the container.
            if self._trial_seed.paid_run:
                raise ValueError(
                    "a paid trial requires trial_proxy: the real credential is exchanged on the "
                    "host and never enters the container")
            return None
        return arm_trial_proxy(
            arm=self._trial_seed.arm, trial_id=self._trial_seed.trial_id,
            upstream_base_url=str(self._trial_seed.credential["upstream_base_url"]),
            spec=parse_trial_proxy_spec(trial_proxy),
            proxy_dir=self._artifact_dir / "proxy",
            trial_roots=(self._artifact_dir,),
        )

    def _capture_inventory(self) -> ArtifactInventory:
        self._captured_inventory = capture_trial_inventory(
            sources={"manifest": self._artifact_dir / MANIFEST_FILENAME},
            session=self._proxy_session, trial_roots=(self._artifact_dir,),
        )
        return self._captured_inventory

    def _validate_trial_seed_binding(self) -> None:
        actual = {
            "root_run_id": self._trial_seed.root_run_id,
            "trial_id": self._trial_seed.trial_id,
            "profile_name": self._trial_seed.profile_name,
            "arm": self._trial_seed.arm.get("name"),
            "image_ref": self._trial_seed.task.get("image_ref"),
            "image_digest": self._trial_seed.task.get("image_digest"),
        }
        expected = {
            "root_run_id": self._manifest_seed.root_run_id,
            "trial_id": self._manifest_seed.trial_id,
            "profile_name": PROFILE_NAME,
            "arm": self._manifest_seed.arm,
            "image_ref": self._manifest_seed.container.image_ref,
            "image_digest": self._manifest_seed.container.image_digest,
        }
        for field, value in expected.items():
            if actual[field] != value:
                raise ValueError(f"TrialSeed {field} must equal {value}")

    def _stage_npm_artifact(self) -> tuple[Path, PurePosixPath]:
        source = self._manifest_seed.npm_artifact_path
        setup_dir = self.logs_dir / "setup"
        setup_dir.mkdir(parents=True, exist_ok=True)
        staged = setup_dir / source.name
        shutil.copy2(source, staged)
        self._staged_npm_artifact = staged
        return staged, PurePosixPath("/installed-agent") / source.name

    def _install_command(self, artifact: PurePosixPath) -> str:
        prefix = shlex.quote(str(NPM_INSTALL_PREFIX))
        package = shlex.quote(str(artifact))
        binary = shlex.quote(str(NPM_INSTALL_PREFIX / "bin" / "cortex"))
        return (
            f"npm install --global --prefix {prefix} --no-audit --no-fund {package}"
            f" && ln -sfn {binary} /usr/local/bin/cortex"
        )

    def _verification_commands(self) -> tuple[str, str]:
        return (
            "command -v cortex >/dev/null 2>&1",
            "cortex agent-run --help >/dev/null",
        )

    def _bundle_root_command(self) -> str:
        prefix = shlex.quote(str(NPM_INSTALL_PREFIX))
        return (
            f"npm ls --global --parseable --depth=0 --prefix {prefix} {BUNDLE_PACKAGE}"
        )

    async def _probe(
        self, environment: BaseEnvironment, command: str, failure: str,
    ) -> str:
        result = await self.exec_as_agent(environment, command=command)
        value = (result.stdout or "").strip()
        if not value:
            raise RuntimeError(failure)
        return value

    async def _discover_container_facts(
        self, environment: BaseEnvironment,
    ) -> ContainerFacts:
        bundle_root = await self._probe(
            environment, self._bundle_root_command(),
            f"Installed {BUNDLE_PACKAGE} bundle root probe returned no path",
        )
        supervisor = PurePosixPath(bundle_root) / SUPERVISOR_PATH
        await self.exec_as_agent(
            environment, command=f"test -x {shlex.quote(str(supervisor))}",
        )
        binary = backend_cli_binary(self._trial_seed.arm)
        cli_path = await self._probe(
            environment, f'realpath -- "$(command -v {shlex.quote(binary)})"',
            f"Installed {binary} CLI path probe returned no path",
        )
        cli_version = await self._probe(
            environment, f"{shlex.quote(binary)} --version",
            f"Installed {binary} CLI version probe returned no version",
        )
        return ContainerFacts(bundle_root, cli_path, cli_version)

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        staged, artifact = self._stage_npm_artifact()
        await environment.upload_file(staged, str(artifact))
        await self.exec_as_root(environment, command=self._install_command(artifact))
        for command in self._verification_commands():
            await self.exec_as_agent(environment, command=command)
        self._container_facts = await self._discover_container_facts(environment)
        self._cortex_cli_version = await self._probe(
            environment, VERSION_COMMAND,
            "Installed Cortex CLI version probe returned no version",
        )

    def _compose_arm_resolution(self, facts: ContainerFacts) -> dict[str, object]:
        credential = (
            None if self._proxy_session is None
            else self._proxy_session.credential_block(self._trial_seed.credential)
        )
        return compose_arm_resolution(self._trial_seed, facts, credential=credential)

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        resolved_cwd = await resolve_task_workdir(environment)
        await super().setup(environment)
        assert self._staged_npm_artifact is not None
        assert self._cortex_cli_version is not None
        assert self._container_facts is not None
        inputs = self._manifest_seed.with_cwd(
            resolved_cwd, self._staged_npm_artifact, self._cortex_cli_version,
        )
        manifest_path = write_harness_manifest(
            self._artifact_dir, build_harness_manifest(inputs),
        )
        if self._proxy_session is not None:
            fill_proxy_manifest(manifest_path, self._proxy_session.handle)
        write_arm_resolution(
            self.logs_dir, self._compose_arm_resolution(self._container_facts),
        )
        self._resolved_cwd = resolved_cwd

    def _agent_paths(
        self,
    ) -> tuple[PurePosixPath, PurePosixPath, PurePosixPath, PurePosixPath]:
        agent_dir = EnvironmentPaths().agent_dir
        return (
            agent_dir / "instruction.md",
            agent_dir / "trajectory" / "events.jsonl",
            agent_dir / "trajectory",
            ARM_RESOLUTION_CONTAINER_PATH,
        )

    def preview_run_argv(self) -> list[str]:
        if self._resolved_cwd is None:
            raise RuntimeError("CortexBenchAgent.setup() must complete before run")
        prompt_path, events_path, trajectory_root, run_config_path = self._agent_paths()
        return self._build_run_argv(
            prompt_path, events_path, trajectory_root, run_config_path,
        )

    def _build_run_argv(
        self, prompt_path: PurePosixPath, events_path: PurePosixPath,
        trajectory_root: PurePosixPath, run_config_path: PurePosixPath,
    ) -> list[str]:
        assert self._resolved_cwd is not None
        return [
            "cortex", "agent-run", "--prompt-file", str(prompt_path),
            "--agent-slot", "parent", "--profile", PROFILE_NAME,
            "--cwd", self._resolved_cwd.realpath, "--output-format", "jsonl",
            "--events-file", str(events_path), "--trajectory-root", str(trajectory_root),
            "--root-run-id", self._manifest_seed.root_run_id,
            "--run-config", str(run_config_path),
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
        _, _, trajectory_root, _ = self._agent_paths()
        try:
            await self.exec_as_agent(
                environment, f"mkdir -p {shlex.quote(str(trajectory_root))}")
            await self.exec_as_agent(
                environment,
                shlex.join(self.preview_run_argv()),
                cwd=self._resolved_cwd.realpath,
            )
        finally:
            # Inventory capture, then the proxy export, then the stop. A stop that cannot prove
            # its handlers are gone raises out of here: it is a trial failure, not a cleanup note.
            if self._proxy_session is not None:
                revoke_trial_proxy(
                    self._proxy_session, capture_inventory=self._capture_inventory,
                )
