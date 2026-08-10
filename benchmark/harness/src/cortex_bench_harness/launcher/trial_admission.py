# input:  trial seed, Harbor task/config, final environment factory inputs
# output: sealed TrialConfig, admitted Docker environment, launch evidence
# pos:    Production Harbor container admission boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any, override
from urllib.parse import urlsplit

from harbor.environments.base import ExecResult
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import (
    EnvironmentConfig as TaskEnvironmentConfig,
    NetworkMode,
    NetworkPolicy,
    TaskOS,
)
from harbor.models.trial.config import (
    AgentConfig,
    EnvironmentConfig as TrialEnvironmentConfig,
    ServiceVolumeConfig,
    TaskConfig,
    TrialConfig,
)
from harbor.models.trial.paths import EnvironmentPaths, TrialPaths
from harbor.trial.trial import Trial

from .arm_resolution import TrialSeed, parse_trial_seed
from .arms import arm_backend, build_agent_config, require_pinned_image

ADMISSION_SCHEMA_VERSION = "cortex-harbor-launch-admission/1"
ADMISSION_EVIDENCE_FILENAME = "harbor-launch-admission.json"
ADMISSION_ENVIRONMENT_IMPORT_PATH = (
    "cortex_bench_harness.launcher.trial_admission:AdmittedDockerEnvironment"
)
TRIAL_ROOT = PurePosixPath("/logs/agent/trial-home")
FIXED_PATH = "/installed-agent/npm/bin:/usr/local/bin:/usr/bin:/bin"
TRIAL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
DENIED_NETWORK_CATEGORIES = (
    "arbitrary-egress",
    "direct-provider",
    "host-daemon",
    "instance-metadata",
    "public-network",
    "sibling-route",
)
PROVIDER_ENV_KEYS = {
    "anthropic": frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"}),
    "openai": frozenset({"OPENAI_API_KEY", "OPENAI_BASE_URL"}),
}
CREDENTIAL_ENV_KEYS = (
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_CONFIG_DIR",
    "KUBECONFIG",
    "SSH_AUTH_SOCK",
    "GPG_AGENT_INFO",
    "DOCKER_HOST",
    "CONTAINER_HOST",
)
SENSITIVE_HOME_PATHS = (
    ".cortex", ".claude", ".anthropic", ".ssh", ".gnupg", ".aws",
    ".azure", ".docker", ".kube", ".config/gcloud", ".config/gh",
)


class HarborTrialAdmissionError(ValueError):
    """The final Harbor construction cannot enforce the standalone boundary."""


def environment_digest(environment: Mapping[str, str]) -> str:
    payload = json.dumps(
        dict(sorted(environment.items())), sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _required_text(values: Mapping[str, object], field: str) -> str:
    value = values.get(field)
    if not isinstance(value, str) or not value:
        raise HarborTrialAdmissionError(f"{field} must be a non-empty string")
    return value


def _safe_trial_id(value: str) -> str:
    if not TRIAL_ID_PATTERN.fullmatch(value) or ".." in value:
        raise HarborTrialAdmissionError("trial_id must be one path-safe component")
    return value


def _arm_limits(arm: Mapping[str, object]) -> Mapping[str, object]:
    limits = arm.get("limits")
    if not isinstance(limits, Mapping):
        raise HarborTrialAdmissionError("arm requires limits")
    return limits


def _deadline_seconds(arm: Mapping[str, object]) -> int:
    value = _arm_limits(arm).get("deadline_seconds")
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise HarborTrialAdmissionError("deadline_seconds must be a positive integer")
    return value


def _provider(arm: Mapping[str, object]) -> str:
    provider = _required_text(arm, "provider")
    if provider not in PROVIDER_ENV_KEYS:
        raise HarborTrialAdmissionError(f"unsupported provider environment: {provider}")
    return provider


def _validate_proxy_destination(seed: TrialSeed, hostname: str) -> None:
    if hostname in _forbidden_network_hosts(seed):
        raise HarborTrialAdmissionError("proxy route cannot name a forbidden destination")
    trial_label = re.sub(r"[^a-z0-9-]", "-", seed.trial_id.lower()).strip("-")
    if hostname.split(".", 1)[0] != trial_label:
        raise HarborTrialAdmissionError("proxy hostname must be trial-scoped")


def _proxy_host(seed: TrialSeed) -> str:
    proxy_url = _required_text(seed.credential, "proxy_base_url")
    parsed = urlsplit(proxy_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HarborTrialAdmissionError("proxy_base_url must be an absolute HTTP URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HarborTrialAdmissionError("proxy_base_url cannot contain credentials or metadata")
    hostname = parsed.hostname.lower()
    _validate_proxy_destination(seed, hostname)
    return hostname


def _forbidden_network_hosts(seed: TrialSeed) -> set[str]:
    upstream = urlsplit(_required_text(seed.credential, "upstream_base_url")).hostname
    route_identity = _required_text(seed.credential, "route_identity_host").lower()
    return {
        host for host in (
            upstream.lower() if upstream else None,
            route_identity,
            "169.254.169.254",
            "metadata.google.internal",
        ) if host
    }


def _trial_environment(seed: TrialSeed, backend: str) -> dict[str, str]:
    root = TRIAL_ROOT
    environment = {
        "CORTEX_BENCH_BACKEND": backend,
        "CORTEX_BENCH_DEADLINE_SECONDS": str(_deadline_seconds(seed.arm)),
        "CORTEX_BENCH_ROOT_RUN_ID": seed.root_run_id,
        "CORTEX_BENCH_TRIAL_ID": seed.trial_id,
        "CORTEX_HOME": str(root / "cortex-home"),
        "CORTEX_PROJECTS_DIR": str(root / "projects"),
        "HOME": str(root / "home"),
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PATH": FIXED_PATH,
        "TEMP": str(root / "tmp"), "TMP": str(root / "tmp"),
        "TMPDIR": str(root / "tmp"), "TZ": "UTC",
        "XDG_CACHE_HOME": str(root / "xdg-cache"),
        "XDG_CONFIG_HOME": str(root / "xdg-config"),
    }
    if backend == "claude":
        environment["CLAUDE_CONFIG_DIR"] = str(root / "claude-config")
    return dict(sorted(environment.items()))


def _validate_environment_values(environment: Mapping[str, str]) -> None:
    for key, value in environment.items():
        if not key or not isinstance(value, str) or not value:
            raise HarborTrialAdmissionError("trial environment values must be non-empty strings")
        if "${" in value or "\x00" in value or "\n" in value:
            raise HarborTrialAdmissionError(f"trial environment {key} is not a literal value")


def _task_image(seed: TrialSeed) -> tuple[str, str]:
    image_ref = _required_text(seed.task, "image_ref")
    image_digest = _required_text(seed.task, "image_digest")
    return require_pinned_image(image_ref, image_digest)


def _admission_contract(
    seed: TrialSeed, task_root: Path, trial_root: Path,
    environment: Mapping[str, str], proxy_host: str,
) -> dict[str, object]:
    _provider(seed.arm)
    return {
        "schema_version": ADMISSION_SCHEMA_VERSION,
        "trial_id": seed.trial_id,
        "root_run_id": seed.root_run_id,
        "task_root": str(task_root),
        "trial_root": str(trial_root),
        "image_ref": _task_image(seed)[0],
        "proxy_host": proxy_host,
        "configured_environment_keys": sorted(environment),
        "admitted_environment_keys": sorted(environment),
        "environment_digest": environment_digest(environment),
    }


def _trial_paths(trials_dir: Path | str, trial_id: str) -> tuple[Path, Path]:
    root = Path(trials_dir).expanduser().resolve()
    return root, root / _safe_trial_id(trial_id)


def _sealed_trial_proxy(
    trial_proxy: Mapping[str, object] | None, proxy_host: str,
) -> Mapping[str, object] | None:
    if trial_proxy is None:
        raise HarborTrialAdmissionError(
            "production Harbor admission requires a current trial proxy"
        )
    sealed = dict(trial_proxy)
    if sealed.get("listen_host") != "0.0.0.0":
        raise HarborTrialAdmissionError(
            "trial proxy listen_host must expose the container route"
        )
    advertised = sealed.get("advertised_host")
    if advertised is not None and str(advertised).lower() != proxy_host:
        raise HarborTrialAdmissionError(
            "trial proxy advertised host differs from the admitted host"
        )
    sealed["advertised_host"] = proxy_host
    return sealed


def _build_trial_agent_config(
    arm: Mapping[str, object], seed: TrialSeed, trial_root: Path,
    manifest: Mapping[str, object], trial_seed: Mapping[str, object],
    cli_version: str, environment: Mapping[str, str], proxy_host: str,
    trial_proxy: Mapping[str, object] | None,
) -> AgentConfig:
    return build_agent_config(
        arm, cli_version=cli_version, artifact_dir=trial_root / "artifacts",
        manifest=manifest, trial_seed=trial_seed, env=environment,
        override_timeout_sec=float(_deadline_seconds(seed.arm)),
        max_timeout_sec=float(_deadline_seconds(seed.arm)),
        extra_allowed_hosts=[proxy_host],
        trial_proxy=_sealed_trial_proxy(trial_proxy, proxy_host),
        admission_environment_digest=environment_digest(environment),
        defer_proxy_arm=True,
    )


def build_harbor_trial_config(
    arm: Mapping[str, object], *, task_path: Path | str,
    trials_dir: Path | str, manifest: Mapping[str, object],
    trial_seed: Mapping[str, object], cli_version: str,
    trial_proxy: Mapping[str, object] | None = None,
) -> TrialConfig:
    seed = parse_trial_seed(trial_seed)
    task_root = Path(task_path).expanduser().resolve(strict=True)
    trials_root, trial_root = _trial_paths(trials_dir, seed.trial_id)
    proxy_host = _proxy_host(seed)
    environment = _trial_environment(seed, arm_backend(seed.arm))
    _validate_environment_values(environment)
    contract = _admission_contract(
        seed, task_root, trial_root, environment, proxy_host,
    )
    agent = _build_trial_agent_config(
        arm, seed, trial_root, manifest, trial_seed, cli_version,
        environment, proxy_host, trial_proxy,
    )
    trial_environment = TrialEnvironmentConfig(
        import_path=ADMISSION_ENVIRONMENT_IMPORT_PATH,
        env=environment, kwargs={"admission": contract},
    )
    return TrialConfig(
        task=TaskConfig(path=task_root), trial_name=seed.trial_id,
        trials_dir=trials_root, agent=agent, environment=trial_environment,
    )


async def create_harbor_trial(
    arm: Mapping[str, object], *, task_path: Path | str,
    trials_dir: Path | str, manifest: Mapping[str, object],
    trial_seed: Mapping[str, object], cli_version: str,
    trial_proxy: Mapping[str, object] | None = None,
) -> Trial:
    config = build_harbor_trial_config(
        arm, task_path=task_path, trials_dir=trials_dir, manifest=manifest,
        trial_seed=trial_seed, cli_version=cli_version, trial_proxy=trial_proxy,
    )
    trial = await Trial.create(config)
    if type(trial.agent_environment) is not AdmittedDockerEnvironment:
        raise HarborTrialAdmissionError("Harbor did not construct the admitted environment")
    if not (trial.paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME).is_file():
        raise HarborTrialAdmissionError("Harbor launch admission evidence is missing")
    session = trial.agent.arm_admitted_proxy()
    actual_host = urlsplit(session.handle.base_url).hostname
    expected_host = config.environment.kwargs["admission"]["proxy_host"]
    if actual_host != expected_host:
        session.handle.stop()
        raise HarborTrialAdmissionError("armed proxy differs from admitted network route")
    return trial


def _parse_contract(source: object) -> Mapping[str, object]:
    if not isinstance(source, Mapping):
        raise HarborTrialAdmissionError("admission policy must be a mapping")
    required = {
        "schema_version", "trial_id", "root_run_id", "task_root", "trial_root",
        "image_ref", "proxy_host", "configured_environment_keys",
        "admitted_environment_keys", "environment_digest",
    }
    if set(source) != required or source.get("schema_version") != ADMISSION_SCHEMA_VERSION:
        raise HarborTrialAdmissionError("admission policy is incomplete or unsupported")
    return source


def _contract_path(contract: Mapping[str, object], key: str) -> Path:
    value = _required_text(contract, key)
    return Path(value).resolve(strict=True)


def _contract_keys(contract: Mapping[str, object], key: str) -> frozenset[str]:
    value = contract.get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise HarborTrialAdmissionError(f"admission policy {key} must be a string list")
    return frozenset(value)


def _validate_task_runtime_surface(
    task_config: TaskEnvironmentConfig, expected_image: str,
) -> None:
    if task_config.os is not TaskOS.LINUX:
        raise HarborTrialAdmissionError("admission requires a Linux Docker environment")
    if task_config.docker_image != expected_image:
        raise HarborTrialAdmissionError("task image must equal the admitted pinned image")
    if task_config.env or task_config.mcp_servers or task_config.skills_dir:
        raise HarborTrialAdmissionError("task environment cannot add env, MCP, or skills")


def _validate_task_environment(
    environment_dir: Path, task_config: TaskEnvironmentConfig,
    expected_image: str, extra_compose: Sequence[Path | str] | None,
) -> None:
    _validate_task_runtime_surface(task_config, expected_image)
    if task_config.healthcheck is not None or task_config.allow_internet is not None:
        raise HarborTrialAdmissionError("task environment contains unsupported launch policy")
    if (environment_dir / "docker-compose.yaml").exists() or extra_compose:
        raise HarborTrialAdmissionError("task Docker Compose overrides are not admitted")


def _validate_persistent_environment(
    environment: Mapping[str, str] | None, contract: Mapping[str, object],
) -> None:
    values = dict(environment or {})
    configured = _contract_keys(contract, "configured_environment_keys")
    if set(values) != configured or environment_digest(values) != contract["environment_digest"]:
        raise HarborTrialAdmissionError("container environment differs from the sealed allowlist")
    _validate_environment_values(values)


def _canonical_target(value: str) -> str:
    target = PurePosixPath(value)
    if not target.is_absolute() or ".." in target.parts or str(target) != value:
        raise HarborTrialAdmissionError(f"mount target is not canonical: {value}")
    return value


def _repository_root(start: Path) -> Path | None:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate.resolve()
    return None


def _cortex_checkout_root(start: Path) -> Path | None:
    root = _repository_root(start)
    if root is None:
        return None
    markers = (root / "agent-server/package.json", root / "benchmark/harness/pyproject.toml")
    return root if all(marker.exists() for marker in markers) else None


def _sensitive_roots() -> tuple[Path, ...]:
    home = Path.home().resolve()
    roots = [home / relative for relative in SENSITIVE_HOME_PATHS]
    for start in (Path.cwd().resolve(), Path(__file__).resolve()):
        checkout = _cortex_checkout_root(start)
        if checkout is not None:
            roots.append(checkout)
    return tuple(dict.fromkeys(path.resolve() for path in roots if path.exists()))


def _credential_path(value: str | None) -> Path | None:
    if not value:
        return None
    if value.startswith("unix://"):
        value = value.removeprefix("unix://")
    if not value.startswith("/"):
        return None
    return Path(value).resolve()


def _credential_paths() -> tuple[Path, ...]:
    candidates = (_credential_path(os.environ.get(key)) for key in CREDENTIAL_ENV_KEYS)
    return tuple(dict.fromkeys(path for path in candidates if path is not None))


def _overlaps(candidate: Path, root: Path) -> bool:
    return (
        candidate == root or candidate.is_relative_to(root)
        or root.is_relative_to(candidate)
    )


def _reject_socket_or_credential(source: Path) -> None:
    if stat.S_ISSOCK(source.stat().st_mode):
        raise HarborTrialAdmissionError(f"mount source is a socket: {source}")
    for credential in _credential_paths():
        if _overlaps(source, credential):
            raise HarborTrialAdmissionError(f"mount exposes a host credential path: {source}")


def _reject_sensitive_source(source: Path) -> None:
    _reject_socket_or_credential(source)
    home = Path.home().resolve()
    if source == home or home.is_relative_to(source):
        raise HarborTrialAdmissionError(f"mount exposes a sensitive host path: {source}")
    if any(_overlaps(source, root) for root in _sensitive_roots()):
        raise HarborTrialAdmissionError(f"mount exposes a sensitive host path: {source}")


def _prepare_harbor_mount_modes(trial_paths: TrialPaths) -> None:
    trial_paths.chmod_dir()
    current = trial_paths.host_artifact_path("main", "/logs/artifacts")
    while True:
        current.chmod(0o777)
        if current == trial_paths.artifacts_dir:
            return
        current = current.parent


def _standard_mounts(trial_paths: TrialPaths) -> dict[str, Path]:
    environment = EnvironmentPaths()
    return {
        str(environment.agent_dir): trial_paths.agent_dir.resolve(strict=True),
        str(environment.verifier_dir): trial_paths.verifier_dir.resolve(strict=True),
        str(environment.artifacts_dir): trial_paths.host_artifact_path(
            "main", str(environment.artifacts_dir),
        ).resolve(strict=True),
    }


def _validate_mount_shape(mount: ServiceVolumeConfig) -> None:
    if mount.get("type") != "bind":
        raise HarborTrialAdmissionError("only declared Harbor bind mounts are admitted")
    allowed = {"type", "source", "target", "read_only"}
    if set(mount) - allowed:
        raise HarborTrialAdmissionError("Harbor mount options are unsupported")


def _mount_record(
    mount: ServiceVolumeConfig, standard: Mapping[str, Path],
    task_root: Path, trial_root: Path,
) -> dict[str, object]:
    _validate_mount_shape(mount)
    source = Path(str(mount.get("source", ""))).resolve(strict=True)
    target = _canonical_target(str(mount.get("target", "")))
    _reject_sensitive_source(source)
    owner, read_only = _mount_owner(mount, source, target, standard, task_root)
    if owner == "harbor-output-handoff" and not source.is_relative_to(trial_root):
        raise HarborTrialAdmissionError(f"Harbor mount escapes trial root: {source}")
    info = source.stat()
    return {
        "type": "bind", "source": str(source), "target": target,
        "access": "read-only" if read_only else "read-write", "owner": owner,
        "uid": info.st_uid, "gid": info.st_gid,
        "source_mode": oct(stat.S_IMODE(info.st_mode)),
    }


def _standard_mount_owner(
    mount: ServiceVolumeConfig, source: Path, target: str,
    standard: Mapping[str, Path],
) -> tuple[str, bool] | None:
    if target not in standard:
        return None
    if source != standard[target] or mount.get("read_only") is True:
        raise HarborTrialAdmissionError(f"Harbor output mount does not match {target}")
    return "harbor-output-handoff", False


def _mount_owner(
    mount: ServiceVolumeConfig, source: Path, target: str,
    standard: Mapping[str, Path], task_root: Path,
) -> tuple[str, bool]:
    standard_owner = _standard_mount_owner(mount, source, target, standard)
    if standard_owner is not None:
        return standard_owner
    if target != "/harbor/input" or not source.is_relative_to(task_root):
        raise HarborTrialAdmissionError(f"extra bind mount is not admitted: {target}")
    if mount.get("read_only") is not True:
        raise HarborTrialAdmissionError("Harbor task input mount must be read-only")
    return "harbor-task-input", True


def _refresh_mount_records(records: Sequence[dict[str, object]]) -> None:
    for record in records:
        info = Path(str(record["source"])).stat()
        record["uid"] = info.st_uid
        record["gid"] = info.st_gid
        record["source_mode"] = oct(stat.S_IMODE(info.st_mode))


def _mount_records(
    mounts: Sequence[ServiceVolumeConfig] | None, trial_paths: TrialPaths,
    contract: Mapping[str, object],
) -> list[dict[str, object]]:
    task_root = _contract_path(contract, "task_root")
    trial_root = _contract_path(contract, "trial_root")
    actual_trial_root = trial_paths.trial_dir.resolve(strict=True)
    if actual_trial_root != trial_root:
        raise HarborTrialAdmissionError("Harbor trial root differs from sealed policy")
    standard = _standard_mounts(trial_paths)
    records = [
        _mount_record(mount, standard, task_root, trial_root)
        for mount in list(mounts or [])
    ]
    targets = [str(record["target"]) for record in records]
    if len(targets) != len(set(targets)) or not set(standard).issubset(targets):
        raise HarborTrialAdmissionError("Harbor final mount list is incomplete or duplicated")
    return sorted(records, key=lambda record: str(record["target"]))


def _policy_record(policy: NetworkPolicy) -> dict[str, object]:
    return {
        "network_mode": policy.network_mode.value,
        "allowed_hosts": list(policy.allowed_hosts),
    }


def _validate_phase_policies(
    policies: Sequence[NetworkPolicy], proxy_host: str,
) -> None:
    if any(
        policy.network_mode is not NetworkMode.ALLOWLIST for policy in policies
    ):
        raise HarborTrialAdmissionError(
            "Harbor phase network policy must remain default-deny"
        )
    hosts = {host for policy in policies for host in policy.allowed_hosts}
    if hosts != {proxy_host}:
        raise HarborTrialAdmissionError(
            "Harbor network allowlist must contain only the trial proxy"
        )


def _network_record(
    startup: NetworkPolicy | None, phases: Sequence[NetworkPolicy] | None,
    contract: Mapping[str, object],
) -> dict[str, object]:
    if startup is None or startup.network_mode is not NetworkMode.ALLOWLIST:
        raise HarborTrialAdmissionError("Harbor network baseline must be default-deny allowlist")
    proxy_host = _required_text(contract, "proxy_host")
    policies = list(phases or [])
    if startup.allowed_hosts or not policies:
        raise HarborTrialAdmissionError("Harbor network allowlist is incomplete")
    _validate_phase_policies(policies, proxy_host)
    return {
        "default": "deny", "loopback": "allow",
        "startup_policy": _policy_record(startup),
        "phase_policies": [_policy_record(policy) for policy in policies],
        "proxy_route": {
            "host": proxy_host, "scope": "current-trial",
            "trial_id": _required_text(contract, "trial_id"),
        },
        "denied": list(DENIED_NETWORK_CATEGORIES),
    }


def _evidence_document(
    contract: Mapping[str, object], mounts: list[dict[str, object]],
    network: Mapping[str, object],
) -> dict[str, object]:
    return {
        "schema_version": ADMISSION_SCHEMA_VERSION,
        "trial_id": _required_text(contract, "trial_id"),
        "root_run_id": _required_text(contract, "root_run_id"),
        "image": {
            "reference": _required_text(contract, "image_ref"), "pinned": True,
        },
        "environment": {
            "admitted_keys": sorted(_contract_keys(
                contract, "admitted_environment_keys",
            )),
            "configured_keys": sorted(_contract_keys(
                contract, "configured_environment_keys",
            )),
            "inheritance": "none",
        },
        "mounts": mounts,
        "network": dict(network),
    }


def _atomic_write_json(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _isolated_command(command: str, environment: Mapping[str, str]) -> str:
    assignments = " ".join(
        f"{key}={shlex.quote(value)}" for key, value in sorted(environment.items())
    )
    return f"exec env -i {assignments} /bin/bash -c {shlex.quote(command)}"


def _parse_image_environment_entry(entry: object) -> tuple[str, str]:
    if not isinstance(entry, str) or "=" not in entry:
        raise HarborTrialAdmissionError("image environment is not a KEY=value list")
    key, value = entry.split("=", 1)
    if not key:
        raise HarborTrialAdmissionError("image environment contains an empty key")
    return key, value


def _parse_image_environment(source: str) -> dict[str, str]:
    try:
        document = json.loads(source)
    except json.JSONDecodeError as error:
        raise HarborTrialAdmissionError("image environment probe returned invalid JSON") from error
    if not isinstance(document, list):
        raise HarborTrialAdmissionError("image environment probe did not return a list")
    entries = dict(_parse_image_environment_entry(entry) for entry in document)
    if len(entries) != len(document):
        raise HarborTrialAdmissionError("image environment contains duplicate keys")
    return entries


def _inspect_image_environment(image_ref: str) -> dict[str, str]:
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .Config.Env}}", image_ref],
            check=True, capture_output=True, text=True, timeout=10,
        )
    except Exception as error:
        raise HarborTrialAdmissionError(
            "pinned image environment cannot be inspected without pulling"
        ) from error
    return _parse_image_environment(result.stdout)


def _admit_final_inputs(
    environment_dir: Path, task_env_config: TaskEnvironmentConfig,
    trial_paths: TrialPaths, admission: Mapping[str, object],
    persistent_env: Mapping[str, str] | None,
    mounts: Sequence[ServiceVolumeConfig] | None,
    network_policy: NetworkPolicy | None,
    phase_network_policies: Sequence[NetworkPolicy],
    extra_docker_compose: Sequence[Path | str],
) -> tuple[Mapping[str, object], list[dict[str, object]], dict[str, object]]:
    contract = _parse_contract(admission)
    _validate_task_environment(
        environment_dir, task_env_config, _required_text(contract, "image_ref"),
        extra_docker_compose,
    )
    _validate_persistent_environment(persistent_env, contract)
    records = _mount_records(mounts, trial_paths, contract)
    _prepare_harbor_mount_modes(trial_paths)
    _refresh_mount_records(records)
    network = _network_record(network_policy, phase_network_policies, contract)
    return contract, records, network


class AdmittedDockerEnvironment(DockerEnvironment):
    def __init__(
        self, environment_dir: Path, environment_name: str, session_id: str,
        trial_paths: TrialPaths, task_env_config: TaskEnvironmentConfig,
        *args: object, admission: Mapping[str, object],
        persistent_env: dict[str, str] | None = None,
        mounts: list[ServiceVolumeConfig] | None = None,
        network_policy: NetworkPolicy | None = None,
        phase_network_policies: Sequence[NetworkPolicy] = (),
        extra_docker_compose: Sequence[Path | str] = (), **kwargs: Any,
    ) -> None:
        contract, records, network = _admit_final_inputs(
            environment_dir, task_env_config, trial_paths, admission,
            persistent_env, mounts, network_policy, phase_network_policies,
            extra_docker_compose,
        )
        super().__init__(
            environment_dir, environment_name, session_id, trial_paths,
            task_env_config, *args, persistent_env=persistent_env, mounts=mounts,
            network_policy=network_policy,
            phase_network_policies=phase_network_policies,
            extra_docker_compose=extra_docker_compose, **kwargs,
        )
        self._record_admission(contract, records, network, trial_paths)

    def _record_admission(
        self, contract: Mapping[str, object], records: list[dict[str, object]],
        network: Mapping[str, object], trial_paths: TrialPaths,
    ) -> None:
        self._admitted_environment_keys = _contract_keys(
            contract, "admitted_environment_keys",
        )
        self._admitted_environment_digest = _required_text(
            contract, "environment_digest",
        )
        self._admitted_image_ref = _required_text(contract, "image_ref")
        evidence = _evidence_document(contract, records, network)
        _atomic_write_json(
            trial_paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME, evidence,
        )

    @override
    async def start(self, force_build: bool) -> None:
        image_environment = _inspect_image_environment(self._admitted_image_ref)
        unknown = sorted(set(image_environment) - self._admitted_environment_keys)
        if unknown:
            raise HarborTrialAdmissionError(
                f"image environment contains unadmitted keys: {unknown}"
            )
        await super().start(force_build=force_build)

    @override
    async def exec(
        self, command: str, cwd: str | None = None,
        env: dict[str, str] | None = None, timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        merged = self._merge_env(env) or {}
        keys_match = set(merged) == self._admitted_environment_keys
        values_match = environment_digest(merged) == self._admitted_environment_digest
        if not keys_match or not values_match:
            raise HarborTrialAdmissionError(
                "process environment differs from the sealed values"
            )
        return await self._compose_exec(
            _isolated_command(command, merged), service="main",
            cwd=cwd or self.task_env_config.workdir, env=None,
            timeout_sec=timeout_sec, user=self._resolve_user(user),
        )
