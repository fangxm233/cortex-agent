# input:  Harbor lifecycle, bundle, manifest, admission seed
# output: identity/env admission, container facts, phase-A input
# pos:    Harbor BaseInstalledAgent wrapper for Cortex
# >>> If I am updated, update my header and folder CORTEX.md <<<

import shlex
import shutil
import time
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from .cwd import ResolvedCwd, resolve_task_workdir
from .launcher.arm_resolution import (
    ARM_RESOLUTION_CONTAINER_PATH,
    TRAJECTORY_CONTAINER_PATH,
    ContainerFacts,
    TrialSeed,
    build_benchmark_thread_policy,
    compose_arm_resolution,
    parse_trial_seed,
    write_arm_resolution,
    write_benchmark_thread_mcp_config,
    write_benchmark_thread_policy,
)
from .launcher.arms import (
    CODER_REVIEW_MODE,
    arm_orchestration_mode,
    backend_cli_binary,
    require_composable_arm,
)
from .launcher.trial_admission import (
    HarborTrialAdmissionError,
    environment_digest,
)
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
        admission_environment_digest: str | None = None,
        defer_proxy_arm: bool = False,
        extra_env: dict[str, str] | None = None,
        version: str = PACKAGE_VERSION,
        **kwargs: Any,
    ) -> None:
        self._initialize_trial_state(
            artifact_dir, manifest, trial_seed, trial_proxy,
            admission_environment_digest, defer_proxy_arm, extra_env,
        )
        super().__init__(logs_dir, *args, version=version, extra_env=extra_env, **kwargs)
        # The sealed path defers arming until EnvironmentFactory admits Harbor's final inputs.
        self._proxy_session = None if defer_proxy_arm else self._arm_proxy(trial_proxy)

    def _initialize_trial_state(
        self, artifact_dir: Path | str, manifest: Mapping[str, object],
        trial_seed: Mapping[str, object], trial_proxy: Mapping[str, object] | None,
        environment_hash: str | None, defer_proxy_arm: bool,
        extra_env: Mapping[str, str] | None,
    ) -> None:
        self._artifact_dir = Path(artifact_dir)
        self._manifest_seed = parse_manifest_seed(manifest)
        self._trial_seed = parse_trial_seed(trial_seed)
        self._validate_trial_seed_binding()
        if not self._allow_unsupported_fixture_seed:
            require_composable_arm(self._trial_seed.arm)
        self._validate_admission_environment(extra_env, environment_hash)
        self._resolved_cwd: ResolvedCwd | None = None
        self._staged_npm_artifact: Path | None = None
        self._cortex_cli_version: str | None = None
        self._container_facts: ContainerFacts | None = None
        self._captured_inventory: ArtifactInventory | None = None
        self._revoked = False
        self._requires_admitted_proxy = environment_hash is not None
        self._proxy_arm_deferred = defer_proxy_arm
        self._deferred_proxy = dict(trial_proxy) if trial_proxy is not None else None

    @staticmethod
    def _validate_admission_environment(
        extra_env: Mapping[str, str] | None, expected_digest: str | None,
    ) -> None:
        if expected_digest is None:
            return
        if environment_digest(dict(extra_env or {})) != expected_digest:
            raise HarborTrialAdmissionError(
                "agent environment differs from the sealed trial environment"
            )

    @staticmethod
    @override
    def name() -> str:
        return "cortex-bench"

    @property
    def proxy_session(self) -> TrialProxySession | None:
        """The armed credential route, or None for a trial that declared no proxy."""
        return self._proxy_session

    def arm_admitted_proxy(self) -> TrialProxySession:
        if not self._proxy_arm_deferred or self._deferred_proxy is None:
            raise HarborTrialAdmissionError("current trial proxy is not awaiting admission")
        session = self._arm_proxy(self._deferred_proxy)
        if session is None:
            raise HarborTrialAdmissionError("current trial proxy could not be armed")
        self._proxy_session = session
        self._proxy_arm_deferred = False
        self._deferred_proxy = None
        return session

    def _require_admitted_proxy(self) -> None:
        if self._proxy_arm_deferred or (
            self._requires_admitted_proxy and self._proxy_session is None
        ):
            raise HarborTrialAdmissionError("current trial proxy is not armed")

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

    def _revoke_proxy(self) -> None:
        """Revoke from whichever lifecycle point ends the trial first, and only once.

        Harbor gives an installed agent no teardown hook and stops calling it the moment one of its
        methods raises, so every method that can be the last one entered has to be able to take the
        route down. The flag is set before the revoke, not after: a revoke that raises has already
        published what it could and must not be re-run by an outer handler.
        """
        if self._proxy_session is None or self._revoked:
            return
        self._revoked = True
        revoke_trial_proxy(self._proxy_session, capture_inventory=self._capture_inventory)

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
        try:
            await self._install(environment)
        except BaseException:
            self._revoke_proxy()
            raise

    async def _install(self, environment: BaseEnvironment) -> None:
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

    def _is_coder_review(self) -> bool:
        return arm_orchestration_mode(self._trial_seed.arm) == CODER_REVIEW_MODE

    def _compose_arm_resolution(self, facts: ContainerFacts) -> dict[str, object]:
        credential = (
            None if self._proxy_session is None
            else self._proxy_session.credential_block(self._trial_seed.credential)
        )
        return compose_arm_resolution(self._trial_seed, facts, credential=credential)

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        try:
            self._require_admitted_proxy()
            await self._setup(environment)
        except BaseException:
            # Harbor abandons the agent when setup raises and never reaches run(), and a cancelled
            # setup (its timeout) arrives here as a BaseException too. Either way this is the last
            # code of ours that executes, so the route it armed goes down here.
            self._revoke_proxy()
            raise

    async def _setup(self, environment: BaseEnvironment) -> None:
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
        if self._is_coder_review():
            # The declaration the composed parent role's `mcp_config_paths` already names. It is
            # instruction-independent, so it is written here rather than at run time.
            write_benchmark_thread_mcp_config(
                self.logs_dir, self._container_facts.bundle_root,
            )
        self._resolved_cwd = resolved_cwd

    def _write_thread_policy(self, instruction: str) -> None:
        """The in-trial thread's policy, written beside the resolution the instant before the run.

        It cannot be written at setup time: the canonical instruction is only handed to `run`, and
        the deadline is an instant rather than a duration, so it is anchored on the run that is
        about to start rather than on a setup that may have been slow.
        """
        if not self._is_coder_review():
            return
        assert self._resolved_cwd is not None
        write_benchmark_thread_policy(self.logs_dir, build_benchmark_thread_policy(
            self._trial_seed.arm,
            canonical_instruction=instruction,
            workspace_cwd=self._resolved_cwd.realpath,
            profile_name=PROFILE_NAME,
            root_run_id=self._manifest_seed.root_run_id,
            started_epoch_ms=int(time.time() * 1_000),
        ))

    def _agent_paths(
        self,
    ) -> tuple[PurePosixPath, PurePosixPath, PurePosixPath, PurePosixPath]:
        agent_dir = EnvironmentPaths().agent_dir
        return (
            agent_dir / "instruction.md",
            TRAJECTORY_CONTAINER_PATH / "events.jsonl",
            TRAJECTORY_CONTAINER_PATH,
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
        # Harbor calls this by keyword — `run(instruction=…, environment=…, context=…)` at
        # harbor/trial/trial.py:451-455 — so the parameter names are part of the contract. A
        # renamed one is a TypeError raised before the body runs, taking the revoke with it.
        context: AgentContext,
    ) -> None:
        try:
            self._require_admitted_proxy()
            if self._resolved_cwd is None:
                raise RuntimeError("CortexBenchAgent.setup() must complete before run")
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / "instruction.md").write_text(instruction)
            self._write_thread_policy(instruction)
            _, _, trajectory_root, _ = self._agent_paths()
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
            # The whole body is inside the try, so no statement of ours can end the trial with the
            # route still armed.
            self._revoke_proxy()
