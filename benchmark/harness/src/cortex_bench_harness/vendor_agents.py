# input:  Harbor vendor agents, admitted arm, proxy projection
# output: sealed vendor execution, process containment, finalization
# pos:    Fail-closed vendor execution and finalization boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import re
import secrets
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from .container_boundary import ContainerBoundaryObservation
from .launcher.host_credential_vault import HOST_CREDENTIAL_VAULT
from .launcher.trial_admission_io import (
    HarborTrialAdmissionError,
    atomic_write_json,
    environment_digest,
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
from .launcher.trial_seed import TrialSeed, parse_trial_seed
from .manifest import MANIFEST_FILENAME, SCHEMA_VERSION
from .scan.models import ArtifactInventory, ScanPolicy

TRIAL_ROOT = PurePosixPath("/logs/agent/trial-home")
EVIDENCE_PATH = PurePosixPath("/logs/agent/vendor-runtime-files.json")
PI_PROMPT_PATH = PurePosixPath("/logs/agent/pi/prompt.md")
PI_SESSION_PATH = PurePosixPath("pi/sessions")
VENDOR_PROCESS_TOKEN_ENV = "CORTEX_BENCH_VENDOR_PROCESS_TOKEN"
VENDOR_PROCESS_TERM_POLLS = 10
VENDOR_PROCESS_KILL_POLLS = 50
VENDOR_COMMAND_MARKERS = {
    "pi": "pi --print", "claude-code": "claude --verbose", "codex": "codex exec",
}
VENDOR_FIXED_ENVIRONMENT = {
    "pi": {
        "PI_CODING_AGENT_DIR": str(TRIAL_ROOT / "pi-agent"),
        "PI_OFFLINE": "1",
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0",
    },
    "codex": {"CODEX_HOME": str(TRIAL_ROOT / "codex-home")},
}
_SAFE_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class VendorPreflightError(RuntimeError):
    pass


@dataclass(frozen=True)
class RuntimeFile:
    path: PurePosixPath
    mode: int
    content: str


def _pi_usage_record(record: Mapping[str, object]) -> Mapping[str, object] | None:
    if record.get("type") == "message":
        message = record.get("message")
        if not isinstance(message, Mapping) or message.get("role") != "assistant":
            return None
        usage = message.get("usage")
    elif record.get("type") in {"compaction", "branch_summary"}:
        usage = record.get("usage")
    else:
        return None
    return usage if isinstance(usage, Mapping) else None


def _pi_session_usage(session_dir: Path) -> tuple[int, int, int, float]:
    input_tokens = output_tokens = cache_tokens = 0
    total_cost = 0.0
    for path in sorted(session_dir.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                usage = _pi_usage_record(json.loads(line))
            except json.JSONDecodeError:
                continue
            if usage is None:
                continue
            input_tokens += int(usage.get("input", 0))
            output_tokens += int(usage.get("output", 0))
            cache_tokens += int(usage.get("cacheRead", 0))
            cost = usage.get("cost")
            if isinstance(cost, Mapping):
                total_cost += float(cost.get("total", 0.0))
    return input_tokens, output_tokens, cache_tokens, total_cost


class VendorLifecycleMixin:
    VENDOR_AGENT: str

    def __init__(
        self,
        logs_dir: Path,
        *args: object,
        artifact_dir: Path | str | None = None,
        manifest: Mapping[str, object] | None = None,
        trial_seed: Mapping[str, object] | None = None,
        trial_proxy: Mapping[str, object] | None = None,
        host_scan_policy: Mapping[str, object] | None = None,
        admission_environment_digest: str | None = None,
        defer_proxy_arm: bool = False,
        credential_handle: str | None = None,
        extra_env: dict[str, str] | None = None,
        version: str | None = None,
        **kwargs: Any,
    ) -> None:
        self._initialize_vendor_lifecycle(
            artifact_dir, manifest, trial_seed, trial_proxy, host_scan_policy,
            admission_environment_digest, defer_proxy_arm, credential_handle,
            extra_env,
        )
        self._verifier_dir = Path(logs_dir).parent / EnvironmentPaths().verifier_dir.name
        super().__init__(
            logs_dir, *args, version=version, extra_env=extra_env, **kwargs,
        )
        self._arm_unsealed_proxy_if_requested()

    def _initialize_vendor_lifecycle(
        self, artifact_dir: Path | str | None, manifest: Mapping[str, object] | None,
        trial_seed: Mapping[str, object] | None,
        trial_proxy: Mapping[str, object] | None,
        host_scan_policy: Mapping[str, object] | None,
        expected_environment_digest: str | None, defer_proxy_arm: bool,
        credential_handle: str | None, extra_env: Mapping[str, str] | None,
    ) -> None:
        self._validate_environment(extra_env, expected_environment_digest)
        self._artifact_dir = Path(artifact_dir) if artifact_dir is not None else None
        self._manifest = dict(manifest or {})
        self._trial_seed = parse_trial_seed(trial_seed) if trial_seed is not None else None
        self._deferred_proxy = dict(trial_proxy) if trial_proxy is not None else None
        self._host_scan_policy = self._parse_scan_policy(host_scan_policy)
        self._proxy_arm_deferred = defer_proxy_arm
        self._proxy_session: TrialProxySession | None = None
        self._captured_inventory: ArtifactInventory | None = None
        self._revocation: TrialRevocation | None = None
        self._revoked = False
        self._setup_complete = False
        self._vendor_execution_active = False
        self._vendor_process_token = secrets.token_hex(16)
        self._post_stop_finalization_pending = False
        self._outer_publication: object | None = None
        self._host_credential = self._consume_credential(credential_handle)
        self._validate_lifecycle_inputs()

    @staticmethod
    def _parse_scan_policy(source: Mapping[str, object] | None) -> ScanPolicy | None:
        if source is None:
            return None
        from .host_finalization import parse_host_scan_policy

        return parse_host_scan_policy(source)

    @staticmethod
    def _validate_environment(
        extra_env: Mapping[str, str] | None, expected_digest: str | None,
    ) -> None:
        if expected_digest is None:
            return
        if environment_digest(dict(extra_env or {})) != expected_digest:
            raise HarborTrialAdmissionError(
                "agent environment differs from the sealed trial environment"
            )

    def _consume_credential(self, credential_handle: str | None) -> str | None:
        if credential_handle is None:
            return None
        if self._trial_seed is None:
            raise HarborTrialAdmissionError("credential handle requires a trial seed")
        require_capability_admission(
            self._trial_seed.arm, paid_run=self._trial_seed.paid_run,
        )
        return HOST_CREDENTIAL_VAULT.consume(credential_handle)

    def _validate_lifecycle_inputs(self) -> None:
        configured = any((self._artifact_dir, self._trial_seed, self._deferred_proxy))
        if not configured:
            return
        if self._artifact_dir is None or self._trial_seed is None:
            raise HarborTrialAdmissionError(
                "vendor lifecycle requires artifact_dir and trial_seed"
            )
        if self._deferred_proxy is None:
            raise HarborTrialAdmissionError("vendor lifecycle requires a trial proxy")

    def _arm_unsealed_proxy_if_requested(self) -> None:
        if self._trial_seed is None or self._proxy_arm_deferred:
            return
        try:
            self._proxy_session = self._arm_proxy()
        finally:
            self._host_credential = None

    def _arm_proxy(self) -> TrialProxySession:
        if self._trial_seed is None or self._artifact_dir is None:
            raise HarborTrialAdmissionError("vendor trial proxy is not configured")
        if self._deferred_proxy is None:
            raise HarborTrialAdmissionError("vendor trial proxy is unavailable")
        return arm_trial_proxy(
            arm=self._trial_seed.arm,
            trial_id=self._trial_seed.trial_id,
            upstream_base_url=str(self._trial_seed.credential["upstream_base_url"]),
            spec=parse_trial_proxy_spec(self._deferred_proxy),
            proxy_dir=self._artifact_dir / "proxy",
            trial_roots=(self._artifact_dir,),
            host_credential=self._host_credential,
            paid_run=self._trial_seed.paid_run,
        )

    def arm_admitted_proxy(self) -> TrialProxySession:
        if not self._proxy_arm_deferred:
            raise HarborTrialAdmissionError("vendor proxy is not awaiting admission")
        try:
            session = self._arm_proxy()
        finally:
            self._host_credential = None
        self._proxy_session = session
        self._proxy_arm_deferred = False
        self._deferred_proxy = None
        return session

    def project_vendor_runtime(self, session: object) -> object:
        if session is not self._proxy_session:
            raise HarborTrialAdmissionError("vendor projection names another proxy session")
        from .launcher.trial_admission import VendorRuntimeProjection

        return VendorRuntimeProjection(
            self.VENDOR_AGENT, self._projection_environment(session),
        )

    def _projection_environment(self, session: object) -> dict[str, str]:
        if self.VENDOR_AGENT in VENDOR_FIXED_ENVIRONMENT:
            return dict(VENDOR_FIXED_ENVIRONMENT[self.VENDOR_AGENT])
        handle = getattr(session, "handle", None)
        base_url = getattr(handle, "base_url", None)
        dummy_token = getattr(handle, "dummy_token", None)
        if not isinstance(base_url, str) or not isinstance(dummy_token, str):
            raise HarborTrialAdmissionError("vendor proxy projection is incomplete")
        return {"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": dummy_token}

    @property
    def post_stop_finalization_pending(self) -> bool:
        return self._post_stop_finalization_pending

    @property
    def captured_inventory(self) -> ArtifactInventory | None:
        return self._captured_inventory

    @property
    def revocation(self) -> TrialRevocation | None:
        return self._revocation

    def _capture_inventory(self) -> ArtifactInventory:
        self._captured_inventory = capture_trial_inventory(
            sources={}, session=self._proxy_session,
            trial_roots=(self._artifact_dir,) if self._artifact_dir is not None else (),
        )
        return self._captured_inventory

    def revoke_admitted_proxy(self) -> None:
        if self._proxy_session is None or self._revoked:
            return
        self._revoked = True
        self._revocation = revoke_trial_proxy(
            self._proxy_session, capture_inventory=self._capture_inventory,
        )

    def _proxy_values(self) -> tuple[str, str]:
        handle = getattr(self._proxy_session, "handle", None)
        base_url = getattr(handle, "base_url", None)
        dummy_token = getattr(handle, "dummy_token", None)
        if not isinstance(base_url, str) or not base_url:
            raise VendorPreflightError("vendor setup requires the armed proxy URL")
        if not isinstance(dummy_token, str) or not dummy_token:
            raise VendorPreflightError("vendor setup requires the dummy proxy token")
        return base_url.rstrip("/"), dummy_token

    def _runtime_files(self) -> tuple[RuntimeFile, ...]:
        if self.VENDOR_AGENT == "pi":
            return self._pi_runtime_files()
        if self.VENDOR_AGENT == "codex":
            return self._codex_runtime_files()
        return ()

    def _pi_runtime_files(self) -> tuple[RuntimeFile, ...]:
        base_url, dummy_token = self._proxy_values()
        if not self.model_name or "/" not in self.model_name:
            raise VendorPreflightError("PI model must use provider/model format")
        provider, model = self.model_name.split("/", 1)
        root = TRIAL_ROOT / "pi-agent"
        auth = {provider: {"type": "api_key", "key": dummy_token}}
        models = {
            "providers": {
                provider: self._pi_provider(
                    base_url, model, self._pi_completion_cap(),
                ),
            },
        }
        return (
            RuntimeFile(root / "auth.json", 0o600, self._json(auth)),
            RuntimeFile(root / "models.json", 0o644, self._json(models)),
            RuntimeFile(TRIAL_ROOT / "home/.nvm/nvm.sh", 0o644, ""),
        )

    def _pi_completion_cap(self) -> int:
        if self._trial_seed is None:
            raise VendorPreflightError("PI runtime requires an admitted trial seed")
        limits = self._trial_seed.arm.get("limits")
        cap = limits.get("max_output_tokens") if isinstance(limits, Mapping) else None
        if not isinstance(cap, int) or isinstance(cap, bool) or cap <= 0:
            raise VendorPreflightError(
                "PI runtime requires admitted arm max_output_tokens"
            )
        return cap

    @staticmethod
    def _pi_provider(
        base_url: str, model: str, completion_cap: int,
    ) -> dict[str, object]:
        return {
            "api": "openai-completions", "baseUrl": f"{base_url}/v1",
            "models": [{
                "id": model, "name": model, "reasoning": False,
                "input": ["text"], "contextWindow": 128000,
                "maxTokens": completion_cap,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            }],
        }

    def _codex_runtime_files(self) -> tuple[RuntimeFile, ...]:
        base_url, dummy_token = self._proxy_values()
        root = TRIAL_ROOT / "codex-home"
        auth = {
            "tokens": {
                "id_token": dummy_token, "access_token": dummy_token,
                "refresh_token": "dummy-refresh-never-forward",
            },
            "last_refresh": datetime.now(UTC).isoformat(),
        }
        return (
            RuntimeFile(root / "auth.json", 0o600, self._json(auth)),
            RuntimeFile(root / "config.toml", 0o600, self._codex_config(base_url)),
        )

    def _codex_config(self, base_url: str) -> str:
        if not self.model_name:
            raise VendorPreflightError("Codex model is required")
        model = json.dumps(self.model_name.split("/")[-1])
        proxy_url = json.dumps(f"{base_url}/codex")
        return (
            f"model = {model}\nmodel_provider = \"cortex_trial_proxy\"\n"
            "model_reasoning_effort = \"high\"\nweb_search = \"disabled\"\n"
            "[model_providers.cortex_trial_proxy]\nname = \"cortex trial proxy\"\n"
            f"base_url = {proxy_url}\nwire_api = \"responses\"\n"
            "requires_openai_auth = true\n"
        )

    @staticmethod
    def _json(value: object) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"

    def _runtime_file_evidence(
        self, files: tuple[RuntimeFile, ...],
    ) -> dict[str, object]:
        return {
            "schema_version": "cortex-bench-vendor-runtime-files/1",
            "vendor_agent": self.VENDOR_AGENT,
            "recorded_before_vendor_cli": True,
            "files": [self._file_record(item) for item in files],
        }

    @staticmethod
    def _file_record(item: RuntimeFile) -> dict[str, str]:
        return {
            "path": item.path.as_posix(), "mode": format(item.mode, "04o"),
            "sha256": hashlib.sha256(item.content.encode()).hexdigest(),
        }

    def _setup_command(self, files: tuple[RuntimeFile, ...]) -> str:
        commands = ["set -eu", "umask 077"]
        for item in files:
            commands.extend(self._write_file_commands(item))
        evidence = self._json(self._runtime_file_evidence(files))
        commands.extend(self._write_file_commands(RuntimeFile(EVIDENCE_PATH, 0o600, evidence)))
        return "; ".join(commands)

    @staticmethod
    def _write_file_commands(item: RuntimeFile) -> list[str]:
        path = shlex.quote(item.path.as_posix())
        content = shlex.quote(item.content)
        mode = format(item.mode, "04o")
        digest = hashlib.sha256(item.content.encode()).hexdigest()
        return [
            f"mkdir -p {shlex.quote(item.path.parent.as_posix())}",
            f"install -m {mode} /dev/null {path}",
            f"printf %s {content} > {path}",
            f"chmod {mode} {path}",
            f'test "$(stat -c %a {path})" = {mode.lstrip("0")}',
            f'test "$(sha256sum {path} | cut -d" " -f1)" = {digest}',
        ]

    async def setup(self, environment: BaseEnvironment) -> None:
        try:
            files = self._runtime_files()
            result = await environment.exec(command=self._setup_command(files))
            if result.return_code != 0:
                raise VendorPreflightError("vendor dummy runtime setup failed")
            await self._preflight_version(environment)
            self._write_vendor_manifest()
            self._setup_complete = True
        except BaseException:
            self.revoke_admitted_proxy()
            raise

    def _write_vendor_manifest(self) -> None:
        if self._artifact_dir is None or self._trial_seed is None:
            return
        task = self._trial_seed.task
        document = {
            "schema_version": SCHEMA_VERSION,
            "root_run_id": self._trial_seed.root_run_id,
            "trial_id": self._trial_seed.trial_id,
            "arm": self._trial_seed.arm["name"],
            "container": {
                "image_ref": task["image_ref"], "image_digest": task["image_digest"],
                "image_size_bytes": self._manifest.get("image_size_bytes"),
            },
            "vendor_cli": {"name": self.VENDOR_AGENT, "version": self._version},
        }
        atomic_write_json(self._artifact_dir / MANIFEST_FILENAME, document)

    async def _preflight_version(self, environment: BaseEnvironment) -> None:
        command = self.get_version_command()
        if not command or not self._version:
            raise VendorPreflightError("vendor version preflight is not pinned")
        result = await environment.exec(command=command)
        if result.return_code != 0:
            raise VendorPreflightError("preinstalled vendor binary is unavailable")
        installed = self.parse_version(result.stdout or "")
        if installed != self._version:
            raise VendorPreflightError(
                f"preinstalled vendor version mismatch: expected {self._version}, got {installed}"
            )

    async def install(self, environment: BaseEnvironment) -> None:
        raise VendorPreflightError("vendor installation is disabled")

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext,
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "instruction.md").write_text(instruction, encoding="utf-8")
        execution_error: BaseException | None = None
        self._vendor_execution_active = True
        try:
            await self._run_vendor_instruction(instruction, environment, context)
        except BaseException as error:
            execution_error = error
        finally:
            self._vendor_execution_active = False
        containment_error = await self._contain_failed_execution(
            environment, execution_error,
        )
        self._finish_vendor_run(execution_error is not None)
        if containment_error is not None:
            raise containment_error
        if execution_error is not None:
            raise execution_error

    async def _contain_failed_execution(
        self, environment: BaseEnvironment, error: BaseException | None,
    ) -> BaseException | None:
        if error is None:
            return None
        try:
            await self._terminate_vendor_process_group(environment)
        except BaseException as containment_error:
            return containment_error
        return None

    async def _run_vendor_instruction(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext,
    ) -> None:
        await super().run(instruction, environment, context)

    def _finish_vendor_run(self, failed: bool) -> None:
        if self._trial_seed is None:
            if failed:
                self.revoke_admitted_proxy()
            return
        try:
            self.revoke_admitted_proxy()
        except Exception as error:
            from .host_finalization import HostFinalizationError

            raise HostFinalizationError("proxy_revocation_uncertain") from error
        if self._setup_complete and self._host_scan_policy is not None:
            self._post_stop_finalization_pending = True

    def finalize_after_container_stop(
        self, observation: ContainerBoundaryObservation | None,
    ) -> None:
        if not self._post_stop_finalization_pending:
            return
        self._post_stop_finalization_pending = False
        self._write_container_boundary(observation)
        self._finalize_outer()

    def _write_container_boundary(
        self, observation: ContainerBoundaryObservation | None,
    ) -> None:
        from .host_finalization import CONTAINER_BOUNDARY_ATTESTATION_FILENAME

        assert self._artifact_dir is not None
        path = self._artifact_dir / CONTAINER_BOUNDARY_ATTESTATION_FILENAME
        path.unlink(missing_ok=True)
        if observation is not None and self._trial_seed is not None:
            atomic_write_json(path, observation.document(self._trial_seed.trial_id))

    def _finalize_outer(self) -> None:
        from .host_finalization import finalize_host_trial

        assert self._artifact_dir is not None
        assert self._trial_seed is not None
        assert self._host_scan_policy is not None
        self._outer_publication = finalize_host_trial(
            logs_dir=self.logs_dir, verifier_dir=self._verifier_dir,
            artifact_dir=self._artifact_dir, root_run_id=self._trial_seed.root_run_id,
            trial_id=self._trial_seed.trial_id, arm=self._trial_seed.arm,
            revocation=self._revocation, scan_policy=self._host_scan_policy,
            container_logs_dir=EnvironmentPaths().agent_dir, task=self._trial_seed.task,
        )

    async def _exec(
        self, environment: BaseEnvironment, command: str,
        user: str | int | None = None, env: dict[str, str] | None = None,
        cwd: str | None = None, timeout_sec: int | None = None,
    ) -> Any:
        process_env = self._sealed_process_environment(env)
        sealed_command = self._inline_environment(command, process_env)
        if self._should_contain_vendor_command(command):
            sealed_command = self._contained_vendor_command(sealed_command)
        return await super()._exec(
            environment, sealed_command, user=user, env=None,
            cwd=cwd, timeout_sec=timeout_sec,
        )

    def _should_contain_vendor_command(self, command: str) -> bool:
        marker = VENDOR_COMMAND_MARKERS[self.VENDOR_AGENT]
        return self._vendor_execution_active and marker in command

    def _contained_vendor_command(self, command: str) -> str:
        child_command = shlex.quote(f"set -o pipefail; {command}")
        token = shlex.quote(self._vendor_process_token)
        return (
            f"export {VENDOR_PROCESS_TOKEN_ENV}={token}; "
            f"setsid bash -c {child_command} & vendor_pid=$!; "
            "set +e; wait \"$vendor_pid\"; status=$?; set -e; exit \"$status\""
        )

    async def _terminate_vendor_process_group(
        self, environment: BaseEnvironment,
    ) -> None:
        result = await environment.exec(
            command=self._terminate_process_group_command(), user=0, timeout_sec=10,
        )
        if result.return_code != 0:
            raise VendorPreflightError("vendor process group termination failed")

    def _process_group_scan_command(self) -> str:
        needle = shlex.quote(
            f"{VENDOR_PROCESS_TOKEN_ENV}={self._vendor_process_token}"
        )
        return (
            "find_groups() { for process in /proc/[0-9]*; do "
            "test -r \"$process/environ\" || continue; "
            f"tr '\\0' '\\n' < \"$process/environ\" | grep -Fxq {needle} || continue; "
            "ps -o pgid= -p \"${process##*/}\"; done | tr -d ' ' | sort -u; }"
        )

    def _terminate_process_group_command(self) -> str:
        scan = self._process_group_scan_command()
        return (
            f"{scan}; groups=$(find_groups); test -n \"$groups\" || exit 0; "
            "for pgid in $groups; do kill -TERM -- \"-$pgid\" 2>/dev/null || true; done; "
            f"for _ in $(seq 1 {VENDOR_PROCESS_TERM_POLLS}); do "
            "test -z \"$(find_groups)\" && exit 0; sleep 0.1; done; "
            "groups=$(find_groups); for pgid in $groups; do "
            "kill -KILL -- \"-$pgid\" 2>/dev/null || true; done; "
            f"for _ in $(seq 1 {VENDOR_PROCESS_KILL_POLLS}); do "
            "test -z \"$(find_groups)\" && exit 0; sleep 0.1; done; exit 70"
        )

    def _sealed_process_environment(
        self, env: Mapping[str, str] | None,
    ) -> dict[str, str]:
        if self.VENDOR_AGENT == "pi":
            return {}
        if self.VENDOR_AGENT == "codex":
            return dict(VENDOR_FIXED_ENVIRONMENT["codex"])
        return self._claude_process_environment(env)

    def _claude_process_environment(
        self, env: Mapping[str, str] | None,
    ) -> dict[str, str]:
        values = {
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CONFIG_DIR": "/logs/agent/sessions",
            "ENABLE_BACKGROUND_TASKS": "1", "FORCE_AUTO_BACKGROUND_TASKS": "1",
            "IS_SANDBOX": "1",
        }
        instruction = {
            key: value for key, value in (env or {}).items()
            if key.startswith("HARBOR_CLAUDE_CODE_INSTRUCTION_")
        }
        return {**values, **instruction}

    def _get_env(self, key: str) -> str | None:
        return self._extra_env.get(key)

    def _has_env(self, key: str) -> bool:
        return key in self._extra_env

    def _get_env_prefixed(self, prefix: str) -> dict[str, str]:
        return {
            key[len(prefix):]: value for key, value in self._extra_env.items()
            if key.startswith(prefix)
        }

    @staticmethod
    def _is_bedrock_mode() -> bool:
        return False

    @staticmethod
    def _inline_environment(command: str, env: Mapping[str, str] | None) -> str:
        exports: list[str] = []
        for key, value in sorted((env or {}).items()):
            if not _SAFE_ENV_KEY.fullmatch(key):
                raise VendorPreflightError(f"unsafe vendor environment key: {key!r}")
            exports.append(f"export {key}={shlex.quote(value)}")
        return "; ".join([*exports, command])


class PreinstalledPi(VendorLifecycleMixin, Pi):
    VENDOR_AGENT = "pi"

    @with_prompt_template
    async def _run_vendor_instruction(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        prompt = RuntimeFile(PI_PROMPT_PATH, 0o600, instruction)
        await self.exec_as_agent(
            environment, command="; ".join(["set -eu", *self._write_file_commands(prompt)]),
        )
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)
        await self.exec_as_agent(environment, command=self._pi_text_command())

    def _pi_text_command(self) -> str:
        assert self.model_name is not None
        provider, model = self.model_name.split("/", 1)
        flags = self.build_cli_flags()
        cli_flags = f"{flags} " if flags else ""
        resume = "--continue " if self._resume else ""
        return (
            ". ~/.nvm/nvm.sh; pi --print --mode text "
            f"--session-dir /logs/agent/pi/sessions {resume}"
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} {cli_flags}"
            f"@{PI_PROMPT_PATH.as_posix()} 2>&1 </dev/null | "
            f"stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}"
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        usage = _pi_session_usage(self.logs_dir / PI_SESSION_PATH)
        context.n_input_tokens = usage[0] + usage[2]
        context.n_output_tokens = usage[1]
        context.n_cache_tokens = usage[2]
        context.cost_usd = usage[3] if usage[3] > 0 else None


class PreinstalledClaudeCode(VendorLifecycleMixin, ClaudeCode):
    VENDOR_AGENT = "claude-code"


class PreinstalledCodex(VendorLifecycleMixin, Codex):
    VENDOR_AGENT = "codex"
    _REMOTE_CODEX_HOME = TRIAL_ROOT / "codex-home"
    _REMOTE_CODEX_SECRETS_DIR = TRIAL_ROOT / "codex-secrets"

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        auth = next(
            item for item in self._codex_runtime_files() if item.path.name == "auth.json"
        )
        path = self._resolve_auth_json_path()
        assert path is not None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(auth.content, encoding="utf-8")
        path.chmod(0o600)

    def _resolve_auth_json_path(self) -> Path | None:
        return self.logs_dir / "codex-dummy-auth.json"
