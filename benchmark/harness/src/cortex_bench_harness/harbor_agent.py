import json
import os
import re
import shlex
import tarfile
from pathlib import Path, PurePosixPath
from collections.abc import Sequence
from typing import Any, Mapping, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from .container_boundary import ContainerBoundaryObservation
from .cwd import ResolvedCwd, resolve_task_workdir
from .launcher.arms import backend_cli_binary
from .launcher.production_arms import (
    ProductionArmBundle,
    require_production_arm,
)
from .launcher.production_home import (
    MaterializedProductionHome,
    ProductionArmLaunchFacts,
    materialize_production_home,
)
from .launcher.production_session import (
    DEADLINE_EXHAUSTED,
    InstalledProductionServer,
    ProductionServerSession,
    ProductionSessionError,
    ProductionSessionSpec,
)
from .launcher.sealed_environment import trial_scratch_command
from .launcher.trial_admission_io import (
    HarborTrialAdmissionError,
    validate_admission_environment,
)
from .launcher.runtime_mounts import (
    RuntimeMountError,
    arm_runtime_names,
    runtime_agent_command,
    runtime_link_command,
)
from .launcher.trial_seed import parse_trial_seed
from .host_finalization import (
    LAUNCH_ATTESTATION_FILENAME,
    HostFinalizationError,
    HostFinalizationResult,
    parse_host_scan_policy,
)
from .launcher.trial_proxy import TrialProxySession
from .manifest import (
    MANIFEST_FILENAME,
    build_harness_manifest,
    parse_manifest_seed,
    write_harness_manifest,
)
from .proxy.manifest import fill_proxy_manifest
from .trial_assets import PRODUCTION_HOME_DIRNAME
from .trial_lifecycle import TrialLifecycle, consume_host_credential
from .scan.models import ArtifactInventory, ScanPolicy

PACKAGE_VERSION = "0.1.0"
PROFILE_NAME = "benchmark"
NPM_INSTALL_PREFIX = PurePosixPath("/installed-agent/npm")
BUNDLE_PACKAGE = "@cortex-agent/server"
PRODUCTION_HOME_NAME = PRODUCTION_HOME_DIRNAME
VERSION_COMMAND = "cortex daemon --version"
BIN_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
BIN_TARGET = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")
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


def _packed_package_json(npm_artifact: Path) -> object:
    try:
        with tarfile.open(npm_artifact, "r:gz") as tar:
            member = tar.extractfile("package/package.json")
            return json.load(member) if member is not None else None
    except (OSError, KeyError, ValueError, tarfile.TarError) as error:
        raise RuntimeError("npm artifact package.json is unreadable") from error


def bundle_bin_links(npm_artifact: Path) -> tuple[tuple[str, str], ...]:
    """The packed package's own `bin` table as (target, command) pairs, sorted by command.

    Read from the artifact rather than restated here: a hand-copied table kept linking a deleted
    entry point, and `ln -sfn` turns that into a dangling command instead of an error.
    """
    document = _packed_package_json(npm_artifact)
    table = document.get("bin") if isinstance(document, Mapping) else None
    if not isinstance(table, Mapping) or not table:
        raise RuntimeError("npm artifact package.json declares no bin table")
    links: list[tuple[str, str]] = []
    for name, target in sorted(table.items()):
        relative = PurePosixPath(target).as_posix() if isinstance(target, str) else ""
        valid = (
            isinstance(name, str) and BIN_NAME.fullmatch(name) is not None
            and BIN_TARGET.fullmatch(relative) is not None
            and not {".", ".."} & set(relative.split("/"))
        )
        if not valid:
            raise RuntimeError(f"npm artifact bin entry {name!r} is not a package-relative file")
        links.append((relative, name))
    return tuple(links)


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
            admission_environment_digest, extra_env, credential_handle,
        )
        super().__init__(logs_dir, *args, version=version, extra_env=extra_env, **kwargs)
        self._verifier_dir = Path(logs_dir).parent / EnvironmentPaths().verifier_dir.name
        # The sealed path defers arming until EnvironmentFactory admits Harbor's final inputs.
        if not defer_proxy_arm:
            self._lifecycle.arm()

    def _initialize_trial_state(
        self, artifact_dir: Path | str, manifest: Mapping[str, object],
        trial_seed: Mapping[str, object], trial_proxy: Mapping[str, object] | None,
        host_scan_policy: Mapping[str, object] | None, environment_hash: str | None,
        extra_env: Mapping[str, str] | None, credential_handle: str | None,
    ) -> None:
        self._artifact_dir = Path(artifact_dir)
        self._manifest_seed = parse_manifest_seed(manifest)
        self._trial_seed = parse_trial_seed(trial_seed)
        self._validate_trial_seed_binding()
        self._production_arm: ProductionArmBundle = require_production_arm(self._trial_seed.arm)
        host_credential = consume_host_credential(credential_handle, self._trial_seed)
        validate_admission_environment(extra_env, environment_hash)
        self._initialize_finalization(host_scan_policy, environment_hash)
        self._resolved_cwd: ResolvedCwd | None = None
        self._npm_artifact: Path | None = None
        self._cortex_cli_version: str | None = None
        self._installed_server: InstalledProductionServer | None = None
        self._materialized_home: MaterializedProductionHome | None = None
        self._production_server_stopped = False
        self._inherited_environment = {**os.environ, **dict(extra_env or {})}
        self._lifecycle = TrialLifecycle(
            artifact_dir=self._artifact_dir, seed=self._trial_seed, trial_proxy=trial_proxy,
            host_credential=host_credential, inventory_sources={
                "manifest": self._artifact_dir / MANIFEST_FILENAME,
                "launch_attestation": self._artifact_dir / LAUNCH_ATTESTATION_FILENAME,
            },
        )

    def _initialize_finalization(
        self, policy: Mapping[str, object] | None, environment_hash: str | None,
    ) -> None:
        self._host_scan_policy: ScanPolicy | None = (
            parse_host_scan_policy(policy) if policy is not None else None
        )
        if environment_hash is not None and self._host_scan_policy is None:
            raise HarborTrialAdmissionError("sealed trials require a host scan policy")
        self._outer_publication: HostFinalizationResult | None = None

    @staticmethod
    @override
    def name() -> str:
        return "cortex-bench"

    @property
    def proxy_session(self) -> TrialProxySession | None:
        """The armed credential route, or None for a trial that declared no proxy."""
        return self._lifecycle.proxy_session

    def arm_admitted_proxy(self) -> TrialProxySession:
        return self._lifecycle.arm_admitted()

    def revoke_admitted_proxy(self) -> None:
        self._lifecycle.revoke()

    def _require_admitted_proxy(self) -> TrialProxySession:
        session = self._lifecycle.proxy_session
        if self._lifecycle.awaiting_admission or session is None:
            raise HarborTrialAdmissionError("current trial proxy is not armed")
        return session

    @property
    def captured_inventory(self) -> ArtifactInventory | None:
        """The artifact-dir inventory captured at proxy revocation."""
        return self._lifecycle.captured_inventory

    @property
    def production_server_stopped(self) -> bool:
        return self._production_server_stopped

    @property
    def post_stop_finalization_pending(self) -> bool:
        return self._lifecycle.finalization_pending

    @property
    def outer_envelope_sha256(self) -> str | None:
        publication = self._outer_publication
        return publication.sha256 if publication is not None else None

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

    def _install_command(
        self, artifact: PurePosixPath, links: Sequence[tuple[str, str]],
    ) -> str:
        package_root = NPM_INSTALL_PREFIX / "lib/node_modules" / BUNDLE_PACKAGE
        link_commands = " && ".join(
            f'ln -sfn "$package_root/{target}" {NPM_INSTALL_PREFIX / "bin" / name}'
            for target, name in links
        )
        return (
            f"package_root={shlex.quote(str(package_root))}"
            f' && mkdir -p "$package_root" {NPM_INSTALL_PREFIX / "bin"}'
            f" && tar -xzf {shlex.quote(str(artifact))} --strip-components=1"
            f' --exclude=package/node_modules -C "$package_root"'
            f' && mv "$package_root/bundled-dependencies" "$package_root/node_modules"'
            f" && {link_commands}"
            f" && ln -sfn {NPM_INSTALL_PREFIX / 'bin/cortex'} /usr/local/bin/cortex"
        )

    def _verification_commands(self) -> tuple[str, str]:
        return "command -v cortex >/dev/null 2>&1", "cortex-evidence-export --help >/dev/null"

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
        await self.exec_as_agent(environment, command=self._bundle_root_command())
        bundle_root = NPM_INSTALL_PREFIX / "lib/node_modules" / BUNDLE_PACKAGE
        target = bundle_root / "dist/entry/production-app-bootstrap.js"
        await self.exec_as_agent(
            environment, command=f"test -f {shlex.quote(str(target))}",
        )
        binary = backend_cli_binary(self._trial_seed.arm)
        await self._probe(
            environment, f'realpath -- "$(command -v {shlex.quote(binary)})"',
            f"Installed {binary} CLI path probe returned no path",
        )
        cli_version = await self._probe(
            environment, f"{shlex.quote(binary)} --version",
            f"Installed {binary} CLI version probe returned no version",
        )
        return InstalledProductionServer(bundle_root, cli_version)

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        try:
            await self._install(environment)
        except BaseException:
            self._lifecycle.revoke()
            raise

    async def _install(self, environment: BaseEnvironment) -> None:
        await self._prepare_trial_scratch(environment)
        await self._link_staged_runtimes(environment)
        artifact_path, artifact = self._npm_artifact_upload()
        links = bundle_bin_links(artifact_path)
        await environment.upload_file(artifact_path, str(artifact))
        await self.exec_as_root(environment, command=self._install_command(artifact, links))
        for command in self._verification_commands():
            await self.exec_as_agent(environment, command=command)
        self._installed_server = await self._discover_installed_server(environment)
        self._cortex_cli_version = await self._probe(
            environment, VERSION_COMMAND,
            "Installed Cortex CLI version probe returned no version",
        )

    async def _prepare_trial_scratch(self, environment: BaseEnvironment) -> None:
        """Create the directories the sealed environment names before anything writes to them."""
        await self.exec_as_agent(environment, command=trial_scratch_command())

    async def _link_staged_runtimes(self, environment: BaseEnvironment) -> None:
        """Put the staged runtimes on PATH before the bundle that drives them is unpacked.

        A Cortex arm installs itself from the pinned npm bundle, so from its image it needs a Node
        interpreter -- and the CLI of the backend it drives, which the server shells out to.
        Mounting both is what lets a Cortex arm run on an unmodified upstream task image instead
        of a per-task image baked to hold the same trees.
        """
        names = arm_runtime_names(self._trial_seed.arm)
        self._require_backend_runtime(names)
        command = runtime_link_command(names)
        if command:
            await self.exec_as_root(environment, command=command)
        agent_command = runtime_agent_command(names)
        if agent_command:
            await self.exec_as_agent(environment, command=agent_command)

    def _require_backend_runtime(self, names: Sequence[str]) -> None:
        """Refuse a mounted arm whose backend CLI was not among the mounts.

        Only checked for an arm that mounts anything at all: an arm on a baked image mounts
        nothing and finds every CLI already installed. But an arm that mounts Node and forgets its
        backend gets a container with no `pi` in it, and the first thing that notices is a
        `realpath -- ""` deep inside install -- a minute later, and about the wrong thing.
        """
        binary = backend_cli_binary(self._trial_seed.arm)
        if names and binary not in names:
            raise RuntimeMountError(
                f"arm {self._trial_seed.arm.get('name')!r} mounts {list(names)} but drives the "
                f"{binary} backend, whose CLI is neither mounted nor guaranteed by the task "
                f"image; add {binary!r} to this arm's runtime_mounts")

    def _materialize_production_home(self, workspace_cwd: str) -> MaterializedProductionHome:
        assert self._npm_artifact is not None
        assert self._installed_server is not None
        session = self._lifecycle.proxy_session
        assert session is not None
        credential = session.credential_block(self._trial_seed.credential)
        facts = ProductionArmLaunchFacts(
            arm_bundle=self._production_arm,
            trial_id=self._trial_seed.trial_id,
            root_run_id=self._trial_seed.root_run_id,
            npm_artifact=self._npm_artifact,
            backend_cli_version=self._installed_server.backend_cli_version,
            proxy_base_url=str(credential["proxy_base_url"]),
            dummy_token_ref=str(credential["dummy_token_ref"]),
            model_alias_policy=self._trial_seed.model_alias_policy,
            workspace_cwd=workspace_cwd,
            max_output_tokens=int(self._trial_seed.arm["limits"]["max_output_tokens"]),
        )
        return materialize_production_home(
            cortex_home=self.logs_dir / PRODUCTION_HOME_NAME,
            runtime_cortex_home=EnvironmentPaths().agent_dir / PRODUCTION_HOME_NAME,
            artifacts_dir=self._artifact_dir, facts=facts,
            inherited_environment=self._inherited_environment,
        )

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        try:
            self._require_admitted_proxy()
            await self._setup(environment)
        except BaseException:
            # Harbor abandons the agent when setup raises and never reaches run(), and a cancelled
            # setup (its timeout) arrives here as a BaseException too. Either way this is the last
            # code of ours that executes, so the route it armed goes down here.
            self._lifecycle.revoke()
            raise

    async def _setup(self, environment: BaseEnvironment) -> None:
        resolved_cwd = await resolve_task_workdir(environment)
        await super().setup(environment)
        assert self._npm_artifact is not None
        assert self._cortex_cli_version is not None
        assert self._installed_server is not None
        inputs = self._manifest_seed.with_cwd(resolved_cwd, self._cortex_cli_version)
        manifest_path = write_harness_manifest(
            self._artifact_dir, build_harness_manifest(inputs),
        )
        session = self._lifecycle.proxy_session
        if session is not None:
            fill_proxy_manifest(manifest_path, session.handle)
        self._materialized_home = self._materialize_production_home(resolved_cwd.realpath)
        self._resolved_cwd = resolved_cwd

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
            await self._execute_production_run(instruction, environment)
        except Exception as error:
            execution_error = error
        finally:
            self._revoke_after_run()
        if execution_error is not None:
            if self._host_scan_policy is None:
                raise execution_error
            raise HostFinalizationError("inner_execution_failed") from execution_error
        await self._collect_trial_outputs(environment)
        if self._host_scan_policy is not None:
            self._lifecycle.finalization_pending = True

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
            result = await session.run(instruction, execute)
            if result.status != DEADLINE_EXHAUSTED:
                self._require_production_proxy_traffic()
        finally:
            self._production_server_stopped = session.stopped_cleanly

    def _require_production_proxy_traffic(self) -> None:
        evidence = self._require_admitted_proxy().handle.accounting_export
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

    def _revoke_after_run(self) -> None:
        try:
            self._lifecycle.revoke()
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
        """Record what the boundary observed, then publish, once."""
        if self._lifecycle.record_container_boundary(observation):
            self._finalize_outer()

    def _finalize_outer(self) -> None:
        if self._host_scan_policy is None:
            return
        if self._npm_artifact is None or self._installed_server is None:
            raise RuntimeError("CortexBenchAgent.install() must complete before finalization")
        self._outer_publication = self._lifecycle.finalize(
            logs_dir=self.logs_dir, verifier_dir=self._verifier_dir,
            scan_policy=self._host_scan_policy, npm_artifact=self._npm_artifact,
            bundle_root=str(self._installed_server.bundle_root),
        )
