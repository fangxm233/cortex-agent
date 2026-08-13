# input:  Harbor lifecycle, inner/proxy evidence, workspace
# output: installed run and validated grader admission
# pos:    Production Harbor lifecycle wrapper for Cortex
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import contextlib
import shlex
import shutil
import time
from collections.abc import Coroutine
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
from .launcher.host_credential_vault import HOST_CREDENTIAL_VAULT
from .host_finalization import (
    HostFinalizationError,
    HostFinalizationResult,
    finalize_host_trial,
    parse_host_scan_policy,
)
from .launcher.trial_proxy import (
    TrialProxySession,
    TrialRevocation,
    arm_trial_proxy,
    capture_trial_inventory,
    parse_trial_proxy_spec,
    require_capability_admission,
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
from .scan.models import ArtifactInventory, ScanPolicy

PACKAGE_VERSION = "0.1.0"
PROFILE_NAME = "benchmark"
# How long the host keeps waiting for `cortex agent-run` to return AFTER that run has published its
# own terminal marker, and how often the marker is looked for while the run is still going.
# The grace is generous because the ordinary exit path — flushing the journal, publishing the
# composite manifest and closing the trial — happens after the marker is written; only a run that
# has stopped making progress reaches the end of it.
INNER_RUN_TERMINAL_GRACE_SECONDS = 120.0
INNER_RUN_TERMINAL_POLL_SECONDS = 1.0
NPM_INSTALL_PREFIX = PurePosixPath("/installed-agent/npm")
BUNDLE_PACKAGE = "@cortex-agent/server"
SUPERVISOR_PATH = PurePosixPath("native/cortex-supervisor/dist/cortex-supervisor")
VERSION_COMMAND = "cortex daemon --version"
WORKSPACE_EVIDENCE_FILENAME = "workspace.diff"
WORKSPACE_COLLECTOR = r"""
const fs = require('node:fs');
const path = require('node:path');
const schema = 'cortex-bench-workspace-evidence/1';
const root = fs.realpathSync(process.argv[1]);
const output = process.argv[2];
const descriptor = fs.openSync(output, 'wx', 0o600);
let closed = false;
function write(bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let offset = 0;
  while (offset < payload.length) offset += fs.writeSync(descriptor, payload, offset);
}
function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const target = path.join(directory, name);
    const info = fs.lstatSync(target);
    if (info.isDirectory()) {
      visit(target);
      continue;
    }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error('unsupported workspace entry');
    const kind = info.isSymbolicLink() ? 'symlink' : 'file';
    const payload = kind === 'symlink'
      ? fs.readlinkSync(target, {encoding: 'buffer'}) : fs.readFileSync(target);
    write(JSON.stringify({path: path.relative(root, target), kind, size_bytes: payload.length}) + '\n');
    write(payload);
    write('\n');
  }
}
try {
  write(JSON.stringify({schema_version: schema}) + '\n');
  visit(root);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  closed = true;
  const directory = fs.openSync(path.dirname(output), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
} catch (error) {
  if (!closed) try { fs.closeSync(descriptor); } catch {}
  try { fs.unlinkSync(output); } catch {}
  throw error;
}
"""


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
        host_scan_policy: Mapping[str, object] | None = None,
        admission_environment_digest: str | None = None,
        defer_proxy_arm: bool = False,
        credential_handle: str | None = None,
        extra_env: dict[str, str] | None = None,
        version: str = PACKAGE_VERSION,
        **kwargs: Any,
    ) -> None:
        self._initialize_trial_state(
            artifact_dir, manifest, trial_seed, trial_proxy, host_scan_policy,
            admission_environment_digest, defer_proxy_arm, extra_env,
            credential_handle,
        )
        super().__init__(logs_dir, *args, version=version, extra_env=extra_env, **kwargs)
        self._verifier_dir = Path(logs_dir).parent / EnvironmentPaths().verifier_dir.name
        # The sealed path defers arming until EnvironmentFactory admits Harbor's final inputs.
        try:
            self._proxy_session = None if defer_proxy_arm else self._arm_proxy(trial_proxy)
        finally:
            if not defer_proxy_arm:
                self._host_credential = None

    def _initialize_trial_state(
        self, artifact_dir: Path | str, manifest: Mapping[str, object],
        trial_seed: Mapping[str, object], trial_proxy: Mapping[str, object] | None,
        host_scan_policy: Mapping[str, object] | None,
        environment_hash: str | None, defer_proxy_arm: bool,
        extra_env: Mapping[str, str] | None, credential_handle: str | None,
    ) -> None:
        self._artifact_dir = Path(artifact_dir)
        self._manifest_seed = parse_manifest_seed(manifest)
        self._trial_seed = parse_trial_seed(trial_seed)
        self._validate_trial_seed_binding()
        if not self._allow_unsupported_fixture_seed:
            require_composable_arm(self._trial_seed.arm)
        self._host_credential = None
        if credential_handle is not None:
            require_capability_admission(
                self._trial_seed.arm, paid_run=self._trial_seed.paid_run,
            )
            self._host_credential = HOST_CREDENTIAL_VAULT.consume(credential_handle)
        try:
            self._initialize_admitted_state(
                trial_proxy, host_scan_policy, environment_hash,
                defer_proxy_arm, extra_env,
            )
        except BaseException:
            self._host_credential = None
            raise

    def _initialize_admitted_state(
        self, trial_proxy: Mapping[str, object] | None,
        host_scan_policy: Mapping[str, object] | None,
        environment_hash: str | None, defer_proxy_arm: bool,
        extra_env: Mapping[str, str] | None,
    ) -> None:
        self._validate_admission_environment(extra_env, environment_hash)
        self._resolved_cwd: ResolvedCwd | None = None
        self._staged_npm_artifact: Path | None = None
        self._cortex_cli_version: str | None = None
        self._container_facts: ContainerFacts | None = None
        self._captured_inventory: ArtifactInventory | None = None
        self._revocation: TrialRevocation | None = None
        self._initialize_finalization(host_scan_policy, environment_hash)
        self._proxy_arm_deferred = defer_proxy_arm
        self._deferred_proxy = dict(trial_proxy) if trial_proxy is not None else None
        self._inner_run_terminal_grace_seconds = INNER_RUN_TERMINAL_GRACE_SECONDS
        self._inner_run_poll_seconds = INNER_RUN_TERMINAL_POLL_SECONDS
        self._inner_run_stall: str | None = None

    def _initialize_finalization(
        self, policy: Mapping[str, object] | None, environment_hash: str | None,
    ) -> None:
        self._host_scan_policy: ScanPolicy | None = (
            parse_host_scan_policy(policy) if policy is not None else None
        )
        if environment_hash is not None and self._host_scan_policy is None:
            raise HarborTrialAdmissionError("sealed trials require a host scan policy")
        self._revoked = False
        self._grader_admitted = False
        self._outer_publication: HostFinalizationResult | None = None
        self._requires_admitted_proxy = environment_hash is not None

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
        try:
            session = self._arm_proxy(self._deferred_proxy)
        finally:
            self._host_credential = None
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
        """The artifact-dir inventory captured at proxy revocation."""
        return self._captured_inventory

    @property
    def grader_admitted(self) -> bool:
        return self._grader_admitted

    @property
    def outer_envelope_sha256(self) -> str | None:
        publication = self._outer_publication
        return publication.sha256 if publication is not None else None

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
            host_credential=self._host_credential,
            paid_run=self._trial_seed.paid_run,
        )

    def _revoke_proxy(self) -> TrialRevocation | None:
        """Revoke from whichever lifecycle point ends the trial first, and only once."""
        if self._proxy_session is None or self._revoked:
            return self._revocation
        self._revoked = True
        self._revocation = revoke_trial_proxy(
            self._proxy_session, capture_inventory=self._capture_inventory,
        )
        return self._revocation

    def revoke_admitted_proxy(self) -> None:
        self._revoke_proxy()

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
            f"npm install --global --prefix {prefix} --cache /installed-agent/npm-cache"
            f" --offline --no-audit --no-fund {package}"
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
            f"npm ls --global --parseable --depth=0 --prefix {prefix}"
            f" --cache /installed-agent/npm-cache --offline {BUNDLE_PACKAGE}"
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
        execution_error: Exception | None = None
        try:
            await self._execute_run(instruction, environment)
        except Exception as error:
            execution_error = error
        finally:
            revocation = self._revoke_after_run()
        if execution_error is not None:
            if self._host_scan_policy is None:
                raise execution_error
            raise HostFinalizationError("inner_execution_failed") from execution_error
        await self._collect_trial_outputs(environment)
        self._finalize_outer(revocation)

    async def _execute_run(self, instruction: str, environment: BaseEnvironment) -> None:
        self._require_admitted_proxy()
        if self._resolved_cwd is None:
            raise RuntimeError("CortexBenchAgent.setup() must complete before run")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "instruction.md").write_text(instruction)
        self._write_thread_policy(instruction)
        _, _, trajectory_root, _ = self._agent_paths()
        await self.exec_as_agent(environment, f"mkdir -p {shlex.quote(str(trajectory_root))}")
        try:
            result = await self._await_inner_run(self.exec_as_agent(
                environment, shlex.join(self.preview_run_argv()),
                cwd=self._resolved_cwd.realpath,
            ))
        except Exception as error:
            self._settle_non_zero_inner_run(error)
            return
        if result is None:
            self._write_collected_streams("", self._inner_run_stall)
            return
        self._write_collected_streams(result.stdout, result.stderr)

    def _settle_non_zero_inner_run(self, error: Exception) -> None:
        """A non-zero `cortex agent-run` is not by itself a stage failure.

        Harbor's `exec_as_agent` raises on any non-zero exit (`agents/installed/base.py:550`),
        and a run whose agent failed exits non-zero — so the ordinary shape of a failed agent
        could not be finalized at all: the phase raised, the verifier never ran, and the campaign
        stopped. Which of the two happened was decided by a race, since a run that published its
        marker before its process returned took the other path instead.

        The marker settles it. With one, the exit code only restates what the run already said
        under the inner contract, and `host_finalization` grades the marker — publishing a
        non-admitted envelope if it is not `completed`/`ok`. Without one, the process died
        without stating an outcome, which is a stage failure and still raises.
        """
        if not self._terminal_marker_path().exists():
            raise error
        self._write_collected_streams("", (
            f"`cortex agent-run` exited non-zero after publishing "
            f"{self._terminal_marker_path().name}; the run's own terminal marker is the outcome "
            f"of record. Reported by Harbor as: {error}"
        ))

    def _terminal_marker_path(self) -> Path:
        """The run's own terminal marker, written atomically into the shared trajectory root.

        Same name `host_finalization` reads, so the file the host stops waiting on is the file it
        goes on to grade.
        """
        return (
            self.logs_dir / "trajectory"
            / f"run-{self._trial_seed.root_run_id}.terminal.json"
        )

    async def _await_inner_run(self, execution: Coroutine[Any, Any, Any]) -> Any | None:
        """Wait for `cortex agent-run`, but never past the run's own terminal marker.

        Harbor bounds the agent phase by the trial's wall clock alone, so an inner run that
        reaches a terminal state in seconds without its process returning — a provider budget
        refusal, for instance — used to hold the phase open to that full timeout, and a timed-out
        phase publishes no outer envelope and stops the campaign. The marker is the run's own
        durable statement that it is over, so once it exists the host waits only the grace an
        ordinary exit needs and then finalizes on the published inner evidence: an admitted trial
        is still published, and a failed one is reported by its coded finalization refusal instead
        of by a wall-clock timeout.

        Returns the exec result, or None once the run is known to be over without one.
        """
        task = asyncio.ensure_future(execution)
        while True:
            try:
                done, _ = await asyncio.wait({task}, timeout=self._inner_run_poll_seconds)
            except BaseException:
                # The phase itself was cancelled or timed out; the exec goes with it.
                await self._abandon_inner_run(task)
                raise
            if done:
                return task.result()
            if self._terminal_marker_path().exists():
                return await self._settle_terminated_inner_run(task)

    async def _settle_terminated_inner_run(self, task: "asyncio.Future[Any]") -> Any | None:
        grace = self._inner_run_terminal_grace_seconds
        try:
            return await asyncio.wait_for(asyncio.shield(task), grace)
        except (TimeoutError, asyncio.TimeoutError):
            await self._abandon_inner_run(task)
            self._inner_run_stall = (
                f"{self._terminal_marker_path().name} was published but `cortex agent-run` had "
                f"not returned {grace:g}s later; the host stopped waiting and finalized on the "
                "published inner evidence"
            )
            return None

    @staticmethod
    async def _abandon_inner_run(task: "asyncio.Future[Any]") -> None:
        task.cancel()
        with contextlib.suppress(BaseException):
            await task

    def _revoke_after_run(self) -> TrialRevocation | None:
        try:
            return self._revoke_proxy()
        except Exception as error:
            if self._host_scan_policy is None:
                raise
            raise HostFinalizationError("proxy_revocation_uncertain") from error

    def _write_collected_streams(self, stdout: str | None, stderr: str | None) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "stdout.txt").write_text(stdout or "", encoding="utf-8")
        (self.logs_dir / "stderr.txt").write_text(stderr or "", encoding="utf-8")

    async def _collect_trial_outputs(self, environment: BaseEnvironment) -> None:
        if self._host_scan_policy is None:
            return
        assert self._resolved_cwd is not None
        output = EnvironmentPaths().agent_dir / WORKSPACE_EVIDENCE_FILENAME
        command = shlex.join([
            "node", "-e", WORKSPACE_COLLECTOR,
            self._resolved_cwd.realpath, str(output),
        ])
        # A run that had to be abandoned may have left the container wedged, so collection after
        # one is bounded too: an unbounded collection would hand the phase straight back to the
        # timeout this class just stopped waiting for.
        timeout = (
            None if self._inner_run_stall is None
            else int(self._inner_run_terminal_grace_seconds) or 1
        )
        try:
            await self.exec_as_agent(
                environment, command, cwd=self._resolved_cwd.realpath, timeout_sec=timeout)
            readable = shlex.join(["chmod", "-R", "a+rX", str(EnvironmentPaths().agent_dir)])
            await self.exec_as_agent(environment, readable, timeout_sec=timeout)
        except Exception as error:
            raise HostFinalizationError("trial_output_collection_failed") from error

    def _finalize_outer(self, revocation: TrialRevocation | None) -> None:
        if self._host_scan_policy is None:
            return
        if self._staged_npm_artifact is None:
            raise RuntimeError("CortexBenchAgent.install() must complete before finalization")
        publication = finalize_host_trial(
            logs_dir=self.logs_dir, verifier_dir=self._verifier_dir,
            artifact_dir=self._artifact_dir,
            root_run_id=self._trial_seed.root_run_id, trial_id=self._trial_seed.trial_id,
            arm=self._trial_seed.arm, staged_npm_artifact=self._staged_npm_artifact,
            revocation=revocation, scan_policy=self._host_scan_policy,
        )
        self._outer_publication = publication
        self._grader_admitted = publication.admitted
