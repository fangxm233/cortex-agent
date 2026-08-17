# input:  Harbor lifecycle, inner/proxy evidence, workspace and stop observation
# output: auth-bootstrapped run whose evidence is recorded once Harbor confirms container stop
# pos:    Production Harbor lifecycle wrapper for Cortex
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import contextlib
import os
import shlex
import time
from collections.abc import Coroutine
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from .container_boundary import ContainerBoundaryObservation
from .cwd import ResolvedCwd, resolve_task_workdir
from .launcher.arm_resolution import (
    ARM_RESOLUTION_CONTAINER_PATH,
    TRAJECTORY_CONTAINER_PATH,
    ContainerFacts,
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
from .launcher.production_home import (
    DirectArmLaunchFacts,
    MaterializedProductionHome,
    materialize_direct_arm_home,
)
from .launcher.production_session import (
    InstalledProductionServer,
    ProductionServerSession,
    ProductionSessionError,
    ProductionSessionSpec,
    is_production_direct_arm,
    is_production_direct_candidate,
    require_production_direct_arm,
)
from .launcher.trial_admission import (
    HarborTrialAdmissionError,
    environment_digest,
)
from .launcher.trial_admission_io import atomic_write_json
from .launcher.host_credential_vault import HOST_CREDENTIAL_VAULT
from .host_finalization import (
    CONTAINER_BOUNDARY_ATTESTATION_FILENAME,
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
INNER_RUN_TERMINAL_GRACE_SECONDS = 120.0
INNER_RUN_TERMINAL_POLL_SECONDS = 1.0
NPM_INSTALL_PREFIX = PurePosixPath("/installed-agent/npm")
BUNDLE_PACKAGE = "@cortex-agent/server"
SUPERVISOR_PATH = PurePosixPath("native/cortex-supervisor/dist/cortex-supervisor")
PRODUCTION_HOME_NAME = "production-cortex-home"
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
        require_composable_arm(self._trial_seed.arm)
        candidate = is_production_direct_candidate(self._trial_seed.arm)
        if candidate:
            require_production_direct_arm(self._trial_seed.arm)
        self._production_direct = is_production_direct_arm(self._trial_seed.arm)
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
        self._npm_artifact: Path | None = None
        self._cortex_cli_version: str | None = None
        self._container_facts: ContainerFacts | None = None
        self._installed_server: InstalledProductionServer | None = None
        self._materialized_home: MaterializedProductionHome | None = None
        self._production_server_stopped = False
        self._inherited_environment = {**os.environ, **dict(extra_env or {})}
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
        self._post_stop_revocation: TrialRevocation | None = None
        self._post_stop_finalization_pending = False
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
        proxy_required = self._requires_admitted_proxy or self._production_direct
        if self._proxy_arm_deferred or (proxy_required and self._proxy_session is None):
            raise HarborTrialAdmissionError("current trial proxy is not armed")

    @property
    def captured_inventory(self) -> ArtifactInventory | None:
        """The artifact-dir inventory captured at proxy revocation."""
        return self._captured_inventory

    @property
    def grader_admitted(self) -> bool:
        return self._grader_admitted

    @property
    def production_server_stopped(self) -> bool:
        return self._production_server_stopped

    @property
    def post_stop_finalization_pending(self) -> bool:
        return self._post_stop_finalization_pending

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

    def _npm_artifact_upload(self) -> tuple[Path, PurePosixPath]:
        """The bundle is uploaded from where the campaign pinned it, not through a copy inside the
        trial's log dir. A copy there would be collected as a trial output — 55.8 MB per trial, of
        which the model saw nothing but the prompts and skills that `trial_assets` now lifts out by
        name. The bundle's identity is kept the way it always was, by digest, in the manifest.
        """
        source = self._manifest_seed.npm_artifact_path
        self._npm_artifact = source
        return source, PurePosixPath("/installed-agent") / source.name

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
        command = (
            "cortex-evidence-export --help >/dev/null" if self._production_direct
            else "cortex agent-run --help >/dev/null"
        )
        return "command -v cortex >/dev/null 2>&1", command

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

    async def _discover_installed_server(
        self, environment: BaseEnvironment,
    ) -> InstalledProductionServer:
        bundle_root = await self._probe(
            environment, self._bundle_root_command(),
            f"Installed {BUNDLE_PACKAGE} bundle root probe returned no path",
        )
        probe = (
            "dist/entry/production-app-bootstrap.js"
            if self._production_direct else str(SUPERVISOR_PATH)
        )
        flag = "-f" if self._production_direct else "-x"
        target = PurePosixPath(bundle_root) / probe
        await self.exec_as_agent(
            environment, command=f"test {flag} {shlex.quote(str(target))}",
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
        return InstalledProductionServer(
            PurePosixPath(bundle_root), PurePosixPath(cli_path), cli_version,
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        try:
            await self._install(environment)
        except BaseException:
            self._revoke_proxy()
            raise

    async def _install(self, environment: BaseEnvironment) -> None:
        artifact_path, artifact = self._npm_artifact_upload()
        await environment.upload_file(artifact_path, str(artifact))
        await self.exec_as_root(environment, command=self._install_command(artifact))
        for command in self._verification_commands():
            await self.exec_as_agent(environment, command=command)
        self._installed_server = await self._discover_installed_server(environment)
        if not self._production_direct:
            self._container_facts = ContainerFacts(
                str(self._installed_server.bundle_root),
                str(self._installed_server.backend_cli_path),
                self._installed_server.backend_cli_version,
            )
        self._cortex_cli_version = await self._probe(
            environment, VERSION_COMMAND,
            "Installed Cortex CLI version probe returned no version",
        )

    def _materialize_production_home(self) -> MaterializedProductionHome:
        assert self._npm_artifact is not None
        assert self._installed_server is not None
        assert self._proxy_session is not None
        credential = self._proxy_session.credential_block(self._trial_seed.credential)
        facts = DirectArmLaunchFacts(
            trial_id=self._trial_seed.trial_id,
            root_run_id=self._trial_seed.root_run_id,
            npm_artifact=self._npm_artifact,
            backend_cli_version=self._installed_server.backend_cli_version,
            proxy_base_url=str(credential["proxy_base_url"]),
            dummy_token_ref=str(credential["dummy_token_ref"]),
            model_alias_policy=self._trial_seed.model_alias_policy,
        )
        return materialize_direct_arm_home(
            cortex_home=self.logs_dir / PRODUCTION_HOME_NAME,
            runtime_cortex_home=EnvironmentPaths().agent_dir / PRODUCTION_HOME_NAME,
            artifacts_dir=self._artifact_dir, facts=facts,
            inherited_environment=self._inherited_environment,
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
        assert self._npm_artifact is not None
        assert self._cortex_cli_version is not None
        assert self._installed_server is not None
        inputs = self._manifest_seed.with_cwd(
            resolved_cwd, self._npm_artifact, self._cortex_cli_version,
        )
        manifest_path = write_harness_manifest(
            self._artifact_dir, build_harness_manifest(inputs),
        )
        if self._proxy_session is not None:
            fill_proxy_manifest(manifest_path, self._proxy_session.handle)
        if self._production_direct:
            self._materialized_home = self._materialize_production_home()
        else:
            assert self._container_facts is not None
            write_arm_resolution(
                self.logs_dir, self._compose_arm_resolution(self._container_facts),
            )
            if self._is_coder_review():
                write_benchmark_thread_mcp_config(
                    self.logs_dir, self._container_facts.bundle_root,
                )
        self._resolved_cwd = resolved_cwd

    def _write_thread_policy(self, instruction: str) -> None:
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
            "--deadline-ms", str(self._inner_deadline_ms()),
        ]

    def _inner_deadline_ms(self) -> int:
        limits = self._trial_seed.arm.get("limits")
        if not isinstance(limits, Mapping):
            raise ValueError("arm requires limits to bound the inner run")
        seconds = limits.get("deadline_seconds")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
            raise ValueError("arm limits require a positive deadline_seconds")
        return seconds * 1000

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
        if self._host_scan_policy is not None:
            self._post_stop_revocation = revocation
            self._post_stop_finalization_pending = True

    async def _execute_run(self, instruction: str, environment: BaseEnvironment) -> None:
        if self._production_direct:
            await self._execute_production_run(instruction, environment)
            return
        await self._execute_legacy_run(instruction, environment)

    async def _execute_production_run(
        self, instruction: str, environment: BaseEnvironment,
    ) -> None:
        self._require_admitted_proxy()
        if self._resolved_cwd is None or self._materialized_home is None:
            raise RuntimeError("CortexBenchAgent.setup() must complete before run")
        assert self._installed_server is not None
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "instruction.md").write_text(instruction, encoding="utf-8")
        spec = ProductionSessionSpec(
            logs_dir=self.logs_dir,
            container_logs_dir=EnvironmentPaths().agent_dir,
            workspace_cwd=self._resolved_cwd.realpath,
            arm=self._trial_seed.arm,
            trial_id=self._trial_seed.trial_id,
            root_run_id=self._trial_seed.root_run_id,
            materialized_home=self._materialized_home,
            installed=self._installed_server,
        )

        async def execute(command: str, **kwargs: Any) -> Any:
            return await self.exec_as_agent(environment, command, **kwargs)

        session = ProductionServerSession(spec)
        try:
            await session.run(instruction, execute)
            self._require_production_proxy_traffic()
        finally:
            self._production_server_stopped = session.stopped_cleanly

    def _require_production_proxy_traffic(self) -> None:
        assert self._proxy_session is not None
        evidence = self._proxy_session.handle.accounting_export
        requests = evidence.get("requests")
        audit = evidence.get("audit_log")
        count = requests.get("value") if isinstance(requests, Mapping) else None
        audit_value = audit.get("value") if isinstance(audit, Mapping) else None
        valid = (
            isinstance(count, int) and not isinstance(count, bool) and count > 0
            and requests.get("status") == "available"
            and isinstance(audit_value, Mapping)
            and audit.get("status") == "available"
            and audit_value.get("durable_requests") == count
            and audit_value.get("agrees_with_counters") is True
        )
        if not valid:
            raise ProductionSessionError(
                "production PI/DeepSeek route did not reach the trial-scoped proxy"
            )

    async def _execute_legacy_run(
        self, instruction: str, environment: BaseEnvironment,
    ) -> None:
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
        if not self._terminal_marker_path().exists():
            raise error
        self._write_collected_streams("", (
            f"`cortex agent-run` exited non-zero after publishing "
            f"{self._terminal_marker_path().name}; the run's own terminal marker is the outcome "
            f"of record. Reported by Harbor as: {error}"
        ))

    def _terminal_marker_path(self) -> Path:
        return (
            self.logs_dir / "trajectory"
            / f"run-{self._trial_seed.root_run_id}.terminal.json"
        )

    async def _await_inner_run(self, execution: Coroutine[Any, Any, Any]) -> Any | None:
        task = asyncio.ensure_future(execution)
        while True:
            try:
                done, _ = await asyncio.wait({task}, timeout=self._inner_run_poll_seconds)
            except BaseException:
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

    def _write_collected_streams(self, stdout: str | None, stderr: str | None) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "stdout.txt").write_text(stdout or "", encoding="utf-8")
        (self.logs_dir / "stderr.txt").write_text(stderr or "", encoding="utf-8")

    def _revoke_after_run(self) -> TrialRevocation | None:
        try:
            return self._revoke_proxy()
        except Exception as error:
            if self._host_scan_policy is None:
                raise
            raise HostFinalizationError("proxy_revocation_uncertain") from error

    async def _collect_trial_outputs(self, environment: BaseEnvironment) -> None:
        if self._host_scan_policy is None:
            return
        assert self._resolved_cwd is not None
        output = EnvironmentPaths().agent_dir / WORKSPACE_EVIDENCE_FILENAME
        command = shlex.join([
            "node", "-e", WORKSPACE_COLLECTOR,
            self._resolved_cwd.realpath, str(output),
        ])
        try:
            await self.exec_as_agent(
                environment, command, cwd=self._resolved_cwd.realpath)
            readable = shlex.join(["chmod", "-R", "a+rX", str(EnvironmentPaths().agent_dir)])
            await self.exec_as_agent(environment, readable)
        except Exception as error:
            raise HostFinalizationError("trial_output_collection_failed") from error

    def finalize_after_container_stop(
        self, observation: ContainerBoundaryObservation | None,
    ) -> None:
        """Record what the boundary observed, then publish.

        A census that is unavailable, or that counts surviving descendants, used to refuse the
        trial as `container_boundary_unproven`. Both are now written down: an observation that
        says processes remained is evidence about this run, and destroying the whole record over
        it discards everything else the trial produced. The flag makes publication happen once.
        """
        if not self._post_stop_finalization_pending:
            return
        self._post_stop_finalization_pending = False
        path = self._artifact_dir / CONTAINER_BOUNDARY_ATTESTATION_FILENAME
        path.unlink(missing_ok=True)
        if observation is not None:
            atomic_write_json(path, observation.document(self._trial_seed.trial_id))
        self._finalize_outer(self._post_stop_revocation)

    def _finalize_outer(self, revocation: TrialRevocation | None) -> None:
        if self._host_scan_policy is None:
            return
        if self._npm_artifact is None or self._installed_server is None:
            raise RuntimeError("CortexBenchAgent.install() must complete before finalization")
        publication = finalize_host_trial(
            logs_dir=self.logs_dir, verifier_dir=self._verifier_dir,
            artifact_dir=self._artifact_dir,
            root_run_id=self._trial_seed.root_run_id, trial_id=self._trial_seed.trial_id,
            arm=self._trial_seed.arm, npm_artifact=self._npm_artifact,
            bundle_root=str(self._installed_server.bundle_root),
            revocation=revocation, scan_policy=self._host_scan_policy,
        )
        self._outer_publication = publication
        self._grader_admitted = publication.admitted
