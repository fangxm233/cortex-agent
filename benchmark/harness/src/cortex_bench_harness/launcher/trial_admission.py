"""Launch-side admission: a trial seed becomes the sealed contract and the Harbor trial carrying it.

What the contract promises is enforced again when Harbor constructs the trial's environment
(`admitted_environment`), against Harbor's final inputs (`admission_contract`).
"""

import ipaddress
import re
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urlsplit

from harbor.models.task.config import VerifierEnvironmentMode
from harbor.models.task.task import Task
from harbor.models.task.verifier_mode import (
    resolve_step_verifier_mode,
    resolve_task_verifier_mode,
)
from harbor.models.trial.config import (
    AgentConfig,
    EnvironmentConfig as TrialEnvironmentConfig,
    ServiceVolumeConfig,
    TaskConfig,
    TrialConfig,
    VerifierConfig,
)
from harbor.trial.trial import Trial

from .trial_seed import TrialSeed, parse_trial_seed
from .host_credential_vault import HOST_CREDENTIAL_VAULT
from .arms import VENDOR_AGENTS, arm_backend, build_agent_config, require_pinned_image
from .runtime_mounts import RUNTIME_TARGETS
from .network_policy import METADATA_HOSTS, MODE_OPEN, NetworkAccess
from .trial_mounts import canonical_target
from .trial_admission_io import (
    TRIAL_ROOT,
    HarborTrialAdmissionError,
    environment_digest,
    required_text,
)
from .admission_contract import ADMISSION_SCHEMA_VERSION, contract_runtime_mounts
from .admitted_environment import AdmittedDockerEnvironment
from .sealed_environment import (
    agent_search_path,
    image_search_path,
    sealed_trial_environment,
    validate_environment_values,
)

ADMISSION_ENVIRONMENT_IMPORT_PATH = "cortex_bench_harness.launcher.admitted_environment:AdmittedDockerEnvironment"
ADMISSION_VERIFIER_IMPORT_PATH = "cortex_bench_harness.launcher.trial_verifier:AdmittedVerifier"
TRIAL_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
SUPPORTED_PROVIDERS = frozenset({"anthropic", "deepseek", "openai", "openai-codex"})


def _safe_trial_id(value: str) -> str:
    if not TRIAL_ID_PATTERN.fullmatch(value):
        raise HarborTrialAdmissionError(
            "trial_id must be one lowercase DNS label and path component"
        )
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
    provider = required_text(arm, "provider")
    if provider not in SUPPORTED_PROVIDERS:
        raise HarborTrialAdmissionError(f"unsupported provider environment: {provider}")
    return provider


def _validate_proxy_destination(seed: TrialSeed, hostname: str) -> None:
    if hostname in _forbidden_network_hosts(seed):
        raise HarborTrialAdmissionError("proxy route cannot name a forbidden destination")
    if hostname.split(".", 1)[0] != _safe_trial_id(seed.trial_id):
        raise HarborTrialAdmissionError("proxy hostname must be trial-scoped")


def _proxy_host(seed: TrialSeed) -> str:
    proxy_url = required_text(seed.credential, "proxy_base_url")
    parsed = urlsplit(proxy_url)
    if parsed.scheme != "http" or not parsed.hostname:
        raise HarborTrialAdmissionError("proxy_base_url must be an absolute HTTP URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HarborTrialAdmissionError("proxy_base_url cannot contain credentials or metadata")
    hostname = parsed.hostname.lower()
    _validate_proxy_destination(seed, hostname)
    return hostname


def _forbidden_network_hosts(seed: TrialSeed) -> set[str]:
    upstream = urlsplit(required_text(seed.credential, "upstream_base_url")).hostname
    route_identity = required_text(seed.credential, "route_identity_host").lower()
    return {
        host for host in (
            upstream.lower() if upstream else None,
            route_identity,
            *METADATA_HOSTS,
        ) if host
    }


def _common_trial_environment(seed: TrialSeed) -> dict[str, str]:
    return sealed_trial_environment(
        seed.trial_id, agent_search_path(image_search_path(_task_image(seed)[0])))


def _trial_environment(seed: TrialSeed, backend: str) -> dict[str, str]:
    root = TRIAL_ROOT
    environment = {
        **_common_trial_environment(seed),
        "CORTEX_BENCH_BACKEND": backend,
        "CORTEX_BENCH_DEADLINE_SECONDS": str(_deadline_seconds(seed.arm)),
        "CORTEX_BENCH_ROOT_RUN_ID": seed.root_run_id,
        "CORTEX_BENCH_TRIAL_ID": seed.trial_id,
        "CORTEX_HOME": str(root / "cortex-home"),
        "CORTEX_PROJECTS_DIR": str(root / "projects"),
    }
    if backend == "claude":
        environment["CLAUDE_CONFIG_DIR"] = str(root / "claude-config")
    return dict(sorted(environment.items()))


def _vendor_agent(arm: Mapping[str, object]) -> str | None:
    if arm.get("kind") != "vendor-baseline":
        return None
    vendor_agent = required_text(arm, "vendor_agent")
    if vendor_agent not in VENDOR_AGENTS:
        raise HarborTrialAdmissionError(f"unsupported vendor agent: {vendor_agent}")
    return vendor_agent


def _initial_trial_environment(seed: TrialSeed) -> dict[str, str]:
    if _vendor_agent(seed.arm) is not None:
        return dict(sorted(_common_trial_environment(seed).items()))
    return _trial_environment(seed, arm_backend(seed.arm))


def _task_image(seed: TrialSeed) -> tuple[str, str]:
    image_ref = required_text(seed.task, "image_ref")
    image_digest = required_text(seed.task, "image_digest")
    return require_pinned_image(image_ref, image_digest)


def _require_trial_proxy(
    trial_proxy: Mapping[str, object] | None,
) -> Mapping[str, object]:
    if trial_proxy is None:
        raise HarborTrialAdmissionError(
            "production Harbor admission requires a current trial proxy"
        )
    return trial_proxy


def _container_ipv4(trial_proxy: Mapping[str, object] | None) -> str:
    """The address this trial's container will be given, and the only source its route accepts.

    Sealed into the contract so the two are one decision: the same value configures the container's
    Docker address and is checked against the armed route's source binding. Concurrent trials each
    hold their own subnet, so a container address that is merely *predicted* is a prediction made
    once per trial rather than once per campaign.
    """
    value = required_text(_require_trial_proxy(trial_proxy), "bound_source_ip")
    try:
        address = ipaddress.IPv4Address(value)
    except ValueError as error:
        raise HarborTrialAdmissionError(
            f"trial proxy bound_source_ip must be an IPv4 address; got {value!r}") from error
    return str(address)


def _admission_contract(
    seed: TrialSeed, task_root: Path, trial_root: Path,
    environment: Mapping[str, str], proxy_host: str, container_ipv4: str,
    network: NetworkAccess, runtime_mounts: Mapping[str, str],
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
        "container_ipv4": container_ipv4,
        "configured_environment_keys": sorted(environment),
        "admitted_environment_keys": sorted(environment),
        "environment_digest": environment_digest(environment),
        "network": {
            "mode": network.mode,
            "allowlist": list(network.allowlist),
            "denylist": list(network.denylist),
        },
        # Target-keyed and sorted: the only extra bind mounts this trial may carry, each at the
        # one container path its runtime name maps to. Empty for a trial whose agent runtime is
        # baked into its task image, which is every trial this harness ran before mounts existed.
        "runtime_mounts": _sealed_runtime_mounts(runtime_mounts),
    }


def _sealed_runtime_mounts(runtime_mounts: Mapping[str, str]) -> dict[str, str]:
    sealed: dict[str, str] = {}
    for target, source in sorted(runtime_mounts.items()):
        if target not in RUNTIME_TARGETS.values():
            raise HarborTrialAdmissionError(
                f"runtime mount target is not one this harness mounts: {target}")
        path = Path(source).expanduser()
        if not path.is_absolute() or not path.is_dir():
            raise HarborTrialAdmissionError(
                f"runtime mount source must be an existing absolute directory: {source}")
        sealed[canonical_target(target)] = str(path.resolve(strict=True))
    return sealed


def _trial_paths(trials_dir: Path | str, trial_id: str) -> tuple[Path, Path]:
    root = Path(trials_dir).expanduser().resolve()
    return root, root / _safe_trial_id(trial_id)


def _validate_task_topology(task_root: Path) -> None:
    task = Task(task_dir=task_root)
    modes = (
        [resolve_step_verifier_mode(task.config, step) for step in task.config.steps]
        if task.config.steps else [resolve_task_verifier_mode(task.config)]
    )
    if VerifierEnvironmentMode.SEPARATE in modes:
        raise HarborTrialAdmissionError(
            "separate verifier environments bypass the admitted Docker boundary"
        )


def _reserve_trial_root(trials_root: Path, trial_root: Path) -> None:
    trials_root.mkdir(parents=True, exist_ok=True)
    try:
        trial_root.mkdir()
    except FileExistsError as error:
        raise HarborTrialAdmissionError(
            f"fresh trial root already exists: {trial_root}"
        ) from error


def _lease_seconds(arm: Mapping[str, object], agent_timeout_seconds: int) -> int:
    """The window in which the container may still make a request.

    Whichever fires first ends the request stream: the inner run stops itself at its own
    `deadline_seconds`, and Harbor cuts the agent phase at its timeout. The credential must
    outlive neither, so the lease budget is the smaller of the two.
    """
    return min(_deadline_seconds(arm), agent_timeout_seconds)


def _sealed_trial_proxy(
    trial_proxy: Mapping[str, object] | None, proxy_host: str, lease_seconds: int,
) -> Mapping[str, object] | None:
    sealed = dict(_require_trial_proxy(trial_proxy))
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
    sealed["lease_seconds"] = lease_seconds
    return sealed


def _build_trial_agent_config(
    arm: Mapping[str, object], seed: TrialSeed, trial_root: Path,
    manifest: Mapping[str, object], trial_seed: Mapping[str, object],
    cli_version: str, environment: Mapping[str, str], proxy_host: str,
    trial_proxy: Mapping[str, object] | None, host_scan_policy: Mapping[str, object],
    credential_handle: str | None, agent_timeout_seconds: int,
) -> AgentConfig:
    return build_agent_config(
        arm, cli_version=cli_version, artifact_dir=trial_root / "artifacts",
        manifest=manifest, trial_seed=trial_seed, env=environment,
        # Harbor resolves the agent phase as min(override, max) * multiplier, so declaring both
        # pins it exactly and supersedes the task's own `[agent] timeout_sec` without editing a
        # digest-pinned task.toml.
        override_timeout_sec=float(agent_timeout_seconds),
        max_timeout_sec=float(agent_timeout_seconds),
        # No extra allowed hosts. Harbor's own plan is PUBLIC, so anything declared here is
        # discarded rather than enforced (`trial/network_policy.merge_extra_allowlists`), and the
        # trial proxy is already carried by the admitted network declaration. Leaving it set would
        # be a second, silently ignored statement of the reachable set.
        extra_allowed_hosts=[],
        trial_proxy=_sealed_trial_proxy(
            trial_proxy, proxy_host, _lease_seconds(seed.arm, agent_timeout_seconds)),
        host_scan_policy=host_scan_policy,
        admission_environment_digest=environment_digest(environment),
        defer_proxy_arm=True, credential_handle=credential_handle,
    )


def build_harbor_trial_config(
    arm: Mapping[str, object], *, task_path: Path | str, trials_dir: Path | str,
    manifest: Mapping[str, object], trial_seed: Mapping[str, object], cli_version: str,
    host_scan_policy: Mapping[str, object], trial_proxy: Mapping[str, object] | None = None,
    credential_handle: str | None = None, agent_timeout_seconds: int | None = None,
    verifier_timeout_seconds: int | None = None, network: NetworkAccess | None = None,
    runtime_mounts: Mapping[str, str] | None = None, cpuset: str | None = None,
) -> TrialConfig:
    seed = parse_trial_seed(trial_seed)
    if seed.arm != arm:
        raise ValueError("trial_seed.arm must equal the selected arm")
    task_root = Path(task_path).expanduser().resolve(strict=True)
    _validate_task_topology(task_root)
    trials_root, trial_root = _trial_paths(trials_dir, seed.trial_id)
    proxy_host = _proxy_host(seed)
    environment = _initial_trial_environment(seed)
    validate_environment_values(environment)
    contract = _admission_contract(
        seed, task_root, trial_root, environment, proxy_host,
        _container_ipv4(trial_proxy), network or NetworkAccess(mode=MODE_OPEN),
        runtime_mounts or {},
    )
    agent = _build_trial_agent_config(
        arm, seed, trial_root, manifest, trial_seed, cli_version,
        environment, proxy_host, trial_proxy, host_scan_policy, credential_handle,
        agent_timeout_seconds or _deadline_seconds(seed.arm),
    )
    trial_environment = _trial_environment_config(
        environment, contract, _vendor_agent(seed.arm), cpuset,
    )

    return _reserve_trial_config(
        task_root, trials_root, trial_root, seed.trial_id, agent,
        trial_environment, verifier_timeout_seconds,
    )


def _reserve_trial_config(
    task_root: Path, trials_root: Path, trial_root: Path, trial_id: str,
    agent: AgentConfig, environment: TrialEnvironmentConfig,
    verifier_timeout_seconds: int | None,
) -> TrialConfig:
    config = TrialConfig(
        task=TaskConfig(path=task_root), trial_name=trial_id, trials_dir=trials_root,
        agent=agent, environment=environment, **_verifier_config(verifier_timeout_seconds),
    )
    _reserve_trial_root(trials_root, trial_root)
    return config


def _trial_environment_config(
    environment: Mapping[str, str], contract: Mapping[str, object], vendor_agent: str | None,
    cpuset: str | None,
) -> TrialEnvironmentConfig:
    kwargs: dict[str, object] = {"admission": contract}
    if vendor_agent is not None:
        kwargs["vendor_agent"] = vendor_agent
    if cpuset is not None:
        kwargs["cpuset"] = cpuset
    runtime = contract_runtime_mounts(contract)
    return TrialEnvironmentConfig(
        import_path=ADMISSION_ENVIRONMENT_IMPORT_PATH,
        env=dict(environment), kwargs=kwargs,
        mounts=[
            ServiceVolumeConfig(type="bind", source=source, target=target, read_only=True)
            for target, source in sorted(runtime.items())
        ] or None,
    )


def _verifier_config(verifier_timeout_seconds: int | None) -> dict[str, object]:
    """An undeclared verifier timeout leaves the task's own `[verifier] timeout_sec` in force.

    The import path is not optional: harbor's stock verifier would run the task's tests through
    the environment sealed for the agent, and that sealing is what made three tasks unscoreable
    for every arm. Naming the phase-aware verifier here is what keeps the two apart.
    """
    fields: dict[str, object] = {"import_path": ADMISSION_VERIFIER_IMPORT_PATH}
    if verifier_timeout_seconds is not None:
        seconds = float(verifier_timeout_seconds)
        fields.update(override_timeout_sec=seconds, max_timeout_sec=seconds)
    return {"verifier": VerifierConfig(**fields)}


async def create_harbor_trial(
    arm: Mapping[str, object], *, task_path: Path | str,
    trials_dir: Path | str, manifest: Mapping[str, object],
    trial_seed: Mapping[str, object], cli_version: str,
    host_scan_policy: Mapping[str, object], trial_proxy: Mapping[str, object] | None = None,
    credential_handle: str | None = None,
    agent_timeout_seconds: int | None = None,
    verifier_timeout_seconds: int | None = None,
    network: NetworkAccess | None = None,
    runtime_mounts: Mapping[str, str] | None = None, cpuset: str | None = None,
) -> Trial:
    try:
        config = build_harbor_trial_config(
            arm, task_path=task_path, trials_dir=trials_dir, manifest=manifest,
            trial_seed=trial_seed, cli_version=cli_version,
            host_scan_policy=host_scan_policy, trial_proxy=trial_proxy,
            credential_handle=credential_handle,
            agent_timeout_seconds=agent_timeout_seconds,
            verifier_timeout_seconds=verifier_timeout_seconds,
            network=network, runtime_mounts=runtime_mounts, cpuset=cpuset,
        )
        _validate_no_extra_allowed_hosts(config)
        _validate_admitted_verifier(config)
        trial = await Trial.create(config)
        if type(trial.agent_environment) is not AdmittedDockerEnvironment:
            raise HarborTrialAdmissionError("Harbor did not construct the admitted environment")
        trial.agent_environment.bind_proxy_controller(trial.agent)
        return trial
    finally:
        if credential_handle is not None:
            HOST_CREDENTIAL_VAULT.purge(credential_handle)


def _validate_admitted_verifier(config: TrialConfig) -> None:
    """The verifier phase must be the one that knows it is not the agent phase."""
    if config.verifier.import_path != ADMISSION_VERIFIER_IMPORT_PATH:
        raise HarborTrialAdmissionError(
            "trial config must name the admitted verifier; harbor's own would score the task "
            "through the environment sealed for the agent")


def _validate_no_extra_allowed_hosts(config: TrialConfig) -> None:
    """The admitted network declaration is the only statement of what a trial may reach.

    Harbor would merge these into its own plan, and since that plan is PUBLIC it would discard
    them with a warning -- so a host smuggled in here never widens anything. It is refused anyway,
    because a caller that asked for a destination and was silently ignored is exactly the
    ambiguity this boundary exists to remove.
    """
    declared = [
        *(config.agent.extra_allowed_hosts or []),
        *(config.environment.extra_allowed_hosts or []),
    ]
    if declared:
        raise HarborTrialAdmissionError(
            "trial config cannot declare extra allowed hosts; the campaign's network block is "
            f"the only source of a trial's reachable set (got {sorted(set(declared))})")
