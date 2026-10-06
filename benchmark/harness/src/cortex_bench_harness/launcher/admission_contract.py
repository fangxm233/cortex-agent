"""The sealed admission contract, read back when Harbor constructs the trial's environment.

`trial_admission` seals the contract at launch; here Harbor's final inputs -- task environment,
persistent environment, mounts and network plan -- are admitted against it, and the launch
evidence is stated from it.
"""

from collections.abc import Mapping, Sequence
from pathlib import Path

from harbor.models.task.config import (
    EnvironmentConfig as TaskEnvironmentConfig,
    NetworkMode,
    NetworkPolicy,
    TaskOS,
)
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths

from .network_policy import (
    DenylistEntry,
    NetworkAccess,
    network_record,
    parse_network_access,
    resolve_denylist,
)
from .sealed_environment import VendorRuntimeProjection, validate_environment_values
from .trial_admission_io import (
    HarborTrialAdmissionError,
    environment_digest,
    redact_mount_sources,
    required_text,
)
from .trial_mounts import (
    canonical_mount,
    mount_record,
    prepare_harbor_mount_modes,
    refresh_mount_records,
    standard_mounts,
)

ADMISSION_SCHEMA_VERSION = "cortex-harbor-launch-admission/3"
ADMISSION_EVIDENCE_FILENAME = "harbor-launch-admission.json"


def _parse_contract(source: object) -> Mapping[str, object]:
    if not isinstance(source, Mapping):
        raise HarborTrialAdmissionError("admission policy must be a mapping")
    required = {
        "schema_version", "trial_id", "root_run_id", "task_root", "trial_root",
        "image_ref", "proxy_host", "container_ipv4", "configured_environment_keys",
        "admitted_environment_keys", "environment_digest", "network", "runtime_mounts",
    }
    if set(source) != required or source.get("schema_version") != ADMISSION_SCHEMA_VERSION:
        raise HarborTrialAdmissionError("admission policy is incomplete or unsupported")
    return source


def _contract_path(contract: Mapping[str, object], key: str) -> Path:
    value = required_text(contract, key)
    return Path(value).resolve(strict=True)


def contract_runtime_mounts(contract: Mapping[str, object]) -> dict[str, str]:
    value = contract.get("runtime_mounts")
    if not isinstance(value, Mapping) or not all(
        isinstance(target, str) and isinstance(source, str)
        for target, source in value.items()
    ):
        raise HarborTrialAdmissionError(
            "admission policy runtime_mounts must map container targets to host sources")
    return {str(target): str(source) for target, source in value.items()}


def contract_keys(contract: Mapping[str, object], key: str) -> frozenset[str]:
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


def validate_persistent_environment(
    environment: Mapping[str, str] | None, contract: Mapping[str, object],
) -> None:
    values = dict(environment or {})
    admitted = contract_keys(contract, "admitted_environment_keys")
    if set(values) != admitted or environment_digest(values) != contract["environment_digest"]:
        raise HarborTrialAdmissionError("container environment differs from the sealed allowlist")
    validate_environment_values(values)


def _mount_records(
    mounts: Sequence[ServiceVolumeConfig] | None, trial_paths: TrialPaths,
    contract: Mapping[str, object],
) -> tuple[list[dict[str, object]], list[ServiceVolumeConfig]]:
    task_root = _contract_path(contract, "task_root")
    trial_root = _contract_path(contract, "trial_root")
    actual_trial_root = trial_paths.trial_dir.resolve(strict=True)
    if actual_trial_root != trial_root:
        raise HarborTrialAdmissionError("Harbor trial root differs from sealed policy")
    standard = standard_mounts(trial_paths)
    runtime = contract_runtime_mounts(contract)
    records = [
        mount_record(mount, standard, task_root, trial_root, runtime)
        for mount in list(mounts or [])
    ]
    targets = [str(record["target"]) for record in records]
    if len(targets) != len(set(targets)) or not set(standard).issubset(targets):
        raise HarborTrialAdmissionError("Harbor final mount list is incomplete or duplicated")
    # A sealed runtime that never reached the container is a trial whose agent would fall back to
    # whatever the image happens to have, which is the comparison this whole harness exists to
    # prevent. Missing is as much a refusal as extra.
    if not set(runtime).issubset(targets):
        raise HarborTrialAdmissionError(
            f"sealed runtime mounts are missing from the final mount list: "
            f"{sorted(set(runtime) - set(targets))}")
    ordered = sorted(records, key=lambda record: str(record["target"]))
    return ordered, [canonical_mount(record) for record in ordered]


def _contract_network(contract: Mapping[str, object]) -> NetworkAccess:
    """Read the network declaration back out of the sealed contract."""
    declared = contract.get("network")
    if not isinstance(declared, Mapping):
        raise HarborTrialAdmissionError("admission policy network must be a mapping")
    try:
        return parse_network_access(declared)
    except ValueError as error:
        raise HarborTrialAdmissionError(f"admission policy network is invalid: {error}") from error


def _validate_task_network_plan(policies: Sequence[NetworkPolicy | None]) -> None:
    """The task's own plan must be the widest one, because admission is what narrows it.

    Every committed task.toml declares `network_mode = "public"`. A task that declared anything
    narrower would have Harbor applying its own policy on top of the admitted one, and two things
    steering the same wheel is how a trial ends up on a network neither of them chose.
    """
    if any(
        policy is not None and policy.network_mode is not NetworkMode.PUBLIC
        for policy in policies
    ):
        raise HarborTrialAdmissionError(
            "task network plan must be public; admission is what narrows a trial's network")


def _network_record(
    startup: NetworkPolicy | None, phases: Sequence[NetworkPolicy] | None,
    contract: Mapping[str, object], denylist: Sequence[DenylistEntry],
) -> dict[str, object]:
    """State the network this trial actually runs on.

    The policies handed in are the ones the environment is holding; they are checked against what
    the sealed declaration says they should be, so a drift refuses the trial rather than producing
    evidence describing a network the container is not on.
    """
    access = _contract_network(contract)
    proxy_host = required_text(contract, "proxy_host")
    expected = access.startup_policy()
    if startup != expected or any(policy != expected for policy in phases or []):
        raise HarborTrialAdmissionError(
            "Harbor network policy differs from the sealed network declaration")
    record = network_record(access, expected, access.effective_policy(proxy_host), denylist)
    record["proxy_route"] = {
        "host": proxy_host, "scope": "current-trial",
        "trial_id": required_text(contract, "trial_id"),
    }
    return record


def _projection_record(projection: VendorRuntimeProjection) -> dict[str, object]:
    return {
        "vendor_agent": projection.vendor_agent,
        "environment": dict(sorted(projection.environment.items())),
    }


def evidence_document(
    contract: Mapping[str, object], mounts: list[dict[str, object]], network: Mapping[str, object],
    projection: VendorRuntimeProjection | None = None,
    image_environment: Mapping[str, str] | None = None,
) -> dict[str, object]:
    environment: dict[str, object] = {
        "admitted_keys": sorted(contract_keys(contract, "admitted_environment_keys")),
        "configured_keys": sorted(contract_keys(contract, "configured_environment_keys")),
        "inheritance": "none",
    }
    if projection is not None:
        environment["runtime_projection"] = _projection_record(projection)
    # `inheritance: none` above is a statement about the trial's processes, which `env -i` makes
    # true. These two say what the image itself carried, so the attestation is complete rather
    # than only complete about the part the harness controls.
    declared = dict(image_environment or {})
    return {
        "schema_version": ADMISSION_SCHEMA_VERSION,
        "trial_id": required_text(contract, "trial_id"),
        "root_run_id": required_text(contract, "root_run_id"),
        "image": {
            "reference": required_text(contract, "image_ref"), "pinned": True,
            "declared_environment_keys": sorted(declared),
            "declared_environment_digest": environment_digest(declared),
        },
        "environment": environment,
        "mounts": redact_mount_sources(mounts),
        "network": dict(network),
    }


def admit_final_inputs(
    environment_dir: Path, task_env_config: TaskEnvironmentConfig,
    trial_paths: TrialPaths, admission: Mapping[str, object],
    persistent_env: Mapping[str, str] | None,
    mounts: Sequence[ServiceVolumeConfig] | None,
    network_policy: NetworkPolicy | None,
    phase_network_policies: Sequence[NetworkPolicy],
    extra_docker_compose: Sequence[Path | str],
    denylist: Sequence[DenylistEntry],
) -> tuple[
    Mapping[str, object], list[dict[str, object]], dict[str, object],
    list[ServiceVolumeConfig],
]:
    contract = _parse_contract(admission)
    _validate_task_environment(
        environment_dir, task_env_config, required_text(contract, "image_ref"),
        extra_docker_compose,
    )
    validate_persistent_environment(persistent_env, contract)
    records, canonical_mounts = _mount_records(mounts, trial_paths, contract)
    prepare_harbor_mount_modes(trial_paths)
    refresh_mount_records(records)
    network = _network_record(network_policy, phase_network_policies, contract, denylist)
    return contract, records, network, canonical_mounts


def prepare_admitted_environment(
    environment_dir: Path, task_env_config: TaskEnvironmentConfig, trial_paths: TrialPaths,
    admission: Mapping[str, object], persistent_env: Mapping[str, str] | None,
    mounts: Sequence[ServiceVolumeConfig] | None, network_policy: NetworkPolicy | None,
    phase_network_policies: Sequence[NetworkPolicy], extra_docker_compose: Sequence[Path | str],
) -> tuple[NetworkAccess, Sequence[DenylistEntry], NetworkPolicy,
           tuple[NetworkPolicy, ...], Mapping[str, object], list[ServiceVolumeConfig]]:
    _validate_task_network_plan([network_policy, *phase_network_policies])
    access = _contract_network(_parse_contract(admission))
    denylist = resolve_denylist(access)
    admitted_policy = access.startup_policy()
    admitted_phases = tuple(admitted_policy for _ in phase_network_policies)
    contract, _, _, canonical_mounts = admit_final_inputs(
        environment_dir, task_env_config, trial_paths, admission,
        persistent_env, mounts, admitted_policy, admitted_phases,
        extra_docker_compose, denylist,
    )
    return access, denylist, admitted_policy, admitted_phases, contract, canonical_mounts
