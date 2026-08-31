# input:  trial seed, task/config, proxy and host scan policy
# output: sealed launch and post-stop finalization lifecycle
# pos:    Production Harbor container admission boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import ipaddress
import os
import re
import stat
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, override
from urllib.parse import urlsplit

from harbor.environments.base import ExecResult
from harbor.models.task.config import (
    EnvironmentConfig as TaskEnvironmentConfig,
    NetworkMode,
    NetworkPolicy,
    TaskOS,
    VerifierEnvironmentMode,
)
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
from harbor.models.trial.paths import EnvironmentPaths, TrialPaths
from harbor.trial.trial import Trial

from ..container_boundary import ContainerBoundaryProbe, ContainerBoundaryUnproven
from ..vendor_agents import VENDOR_FIXED_ENVIRONMENT
from .trial_seed import TrialSeed, parse_trial_seed
from .host_credential_vault import HOST_CREDENTIAL_VAULT
from .arms import VENDOR_AGENTS, arm_backend, build_agent_config, require_pinned_image
from .runtime_mounts import RUNTIME_TARGETS
from .network_policy import (
    MODE_OPEN,
    DenylistEntry,
    NetworkAccess,
    denylist_addresses,
    network_record,
    parse_network_access,
    resolve_denylist,
)
from .trial_admission_io import (
    HarborTrialAdmissionError, PullDisabledDockerEnvironment,
    atomic_write_json,
    environment_digest,
    inspect_image_configuration,
    isolated_command,
    redact_mount_sources,
)

ADMISSION_SCHEMA_VERSION = "cortex-harbor-launch-admission/3"
ADMISSION_EVIDENCE_FILENAME = "harbor-launch-admission.json"
# What a task image may not declare for itself.
#
# Until 2026-08-27 the rule was that an image's own environment had to be a subset of the keys
# this harness injects. That is satisfiable only by an image this harness built. Running the
# unmodified upstream corpus, 47 of 89 tasks were refused -- 46 of them for carrying
# `GPG_KEY`, `PYTHON_VERSION` and `PYTHON_SHA256`, which is what `FROM python:3.x` puts in every
# image built on it.
#
# The subset rule was not what kept the image's environment away from the trial. `isolated_command`
# runs every command as `exec env -i <sealed keys> /bin/bash -c ...`, so the agent and the verifier
# start from an empty environment holding exactly the sealed values, whatever the image declared.
# The one process that does inherit the image's environment is the service's own entrypoint, which
# `docker compose up` starts. These keys are refused because each of them can send that process's
# traffic somewhere else, or load code into it before its main runs. Everything else is admitted
# and recorded: the image is pinned by digest, so what it declares cannot change without the pin
# changing, and the evidence names the full set either way.
IMAGE_ENVIRONMENT_DENYLIST = frozenset({
    "ALL_PROXY", "BASH_ENV", "HTTPS_PROXY", "HTTP_PROXY", "LD_AUDIT", "LD_LIBRARY_PATH",
    "LD_PRELOAD", "NODE_OPTIONS", "NO_PROXY",
})
ADMISSION_ENVIRONMENT_IMPORT_PATH = "cortex_bench_harness.launcher.trial_admission:AdmittedDockerEnvironment"
TRIAL_ROOT = PurePosixPath("/logs/agent/trial-home")
VERIFIER_UVX_ALIAS = TRIAL_ROOT / "home/.local/bin/uvx"
VERIFIER_UVX_TARGET = PurePosixPath("/opt/terminal-bench-verifier/bin/uvx")
FIXED_PATH = "/installed-agent/npm/bin:/usr/local/bin:/usr/bin:/bin"
TRIAL_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
PROVIDER_ENV_KEYS = {
    "anthropic": frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"}),
    "deepseek": frozenset({"DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"}),
    "openai": frozenset({"OPENAI_API_KEY", "OPENAI_BASE_URL"}),
    "openai-codex": frozenset({"OPENAI_API_KEY"}),
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
    ".cortex", ".claude", ".anthropic", ".pi", ".ssh", ".gnupg", ".aws",
    ".azure", ".docker", ".kube", ".config/gcloud", ".config/gh",
)
@dataclass(frozen=True)
class VendorRuntimeProjection:
    vendor_agent: str
    environment: Mapping[str, str]


def _required_text(values: Mapping[str, object], field: str) -> str:
    value = values.get(field)
    if not isinstance(value, str) or not value:
        raise HarborTrialAdmissionError(f"{field} must be a non-empty string")
    return value


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
    provider = _required_text(arm, "provider")
    if provider not in PROVIDER_ENV_KEYS:
        raise HarborTrialAdmissionError(f"unsupported provider environment: {provider}")
    return provider


def _validate_proxy_destination(seed: TrialSeed, hostname: str) -> None:
    if hostname in _forbidden_network_hosts(seed):
        raise HarborTrialAdmissionError("proxy route cannot name a forbidden destination")
    if hostname.split(".", 1)[0] != _safe_trial_id(seed.trial_id):
        raise HarborTrialAdmissionError("proxy hostname must be trial-scoped")


def _proxy_host(seed: TrialSeed) -> str:
    proxy_url = _required_text(seed.credential, "proxy_base_url")
    parsed = urlsplit(proxy_url)
    if parsed.scheme != "http" or not parsed.hostname:
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


# The scratch directories the sealed environment NAMES, which therefore have to EXIST. Nothing
# created them: an agent that runs `mkdir -p` before writing never noticed, and PI -- whose bash
# executor spills to `os.tmpdir()` with a bare `createWriteStream` once a command's output grows
# past its buffer -- died on the first task that produced enough output. It solved the two tasks
# that did not. A trial whose TMPDIR does not exist is a trap that springs on output volume, so
# these are created as the agent before the agent runs.
TRIAL_SCRATCH_DIRECTORIES = ("home", "tmp", "xdg-cache", "xdg-config")


def trial_scratch_command() -> str:
    """The agent-side command that makes the sealed environment's promise true."""
    targets = " ".join(str(TRIAL_ROOT / name) for name in TRIAL_SCRATCH_DIRECTORIES)
    return f"mkdir -p {targets}"


# The same four directories are scratch on the way out. They are named by the sealed environment,
# so third parties fill them: pip's HTTP cache under XDG_CACHE_HOME was 157.84 MB of the 173.7 MB
# one campaign collected across 29 trials -- 91% of all evidence -- and one cached PyPI response
# body in it carried a package author's `/home/<name>` path, which the leak scanner matched and
# which discarded a trial that had solved its task. Chromium leaves root-owned directories under
# XDG_CONFIG_HOME and TMPDIR that the collector cannot traverse, and one unreadable entry marks
# the whole agent root unavailable. None of this is trial evidence. Discarding the four trees in
# the live container -- after the agent and the verifier have both finished, before anything is
# collected -- fixes all three without loosening the scanner or the collector by one byte. The
# census is written first so the evidence still records that TMPDIR existed and how much it held.
TRIAL_SCRATCH_CENSUS_SCHEMA = "cortex-trial-scratch-discard/1"
TRIAL_SCRATCH_CENSUS_PATH = TRIAL_ROOT.parent / "trial-scratch-discarded.json"


def trial_scratch_discard_command(
    root: PurePosixPath = TRIAL_ROOT,
    census: PurePosixPath = TRIAL_SCRATCH_CENSUS_PATH,
) -> str:
    """Census the scratch trees, then discard them. Only the discard has to succeed."""
    targets = " ".join(str(root / name) for name in TRIAL_SCRATCH_DIRECTORIES)
    survey = "".join((
        '{ printf \'{"schema":"', TRIAL_SCRATCH_CENSUS_SCHEMA, '","directories":{\'; ',
        "sep=''; for name in ", " ".join(TRIAL_SCRATCH_DIRECTORIES), "; do ",
        'dir="', str(root), '/$name"; ',
        'if [ -d "$dir" ]; then ',
        'files=$(find "$dir" -type f 2>/dev/null | wc -l | tr -d " "); ',
        'kib=$(du -sk "$dir" 2>/dev/null | cut -f1 | tr -d " "); ',
        "present=true; else files=0; kib=0; present=false; fi; ",
        'printf \'%s"%s":{"present":%s,"files":%s,"kib":%s}\' ',
        '"$sep" "$name" "$present" "${files:-0}" "${kib:-0}"; ',
        "sep=','; done; printf '}}\\n'; } > ", str(census), " 2>/dev/null || :",
    ))
    return f"set -u; {survey}; rm -rf -- {targets}"


def sealed_trial_environment(trial_id: str) -> dict[str, str]:
    """The environment every phase of a trial starts from, the verifier's included.

    Public because the verifier phase is measurable outside a trial and has to be measured under
    exactly this: `HOME` decides where an upstream test.sh's `source $HOME/.local/bin/env` looks
    for the uv it just installed, and `PATH` -- which carries no /sbin -- decides which apt-get and
    curl that script finds. A probe that used the image's own environment would be answering a
    different question from the one the trial asks.
    """
    root = TRIAL_ROOT
    return {
        "HOME": str(root / "home"), "HOSTNAME": trial_id,
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
        "NODE_DISABLE_COMPILE_CACHE": "1", "PATH": FIXED_PATH,
        "TEMP": str(root / "tmp"), "TMP": str(root / "tmp"),
        "TMPDIR": str(root / "tmp"), "TZ": "UTC",
        "XDG_CACHE_HOME": str(root / "xdg-cache"),
        "XDG_CONFIG_HOME": str(root / "xdg-config"),
    }


def _common_trial_environment(seed: TrialSeed) -> dict[str, str]:
    return sealed_trial_environment(seed.trial_id)


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
    vendor_agent = _required_text(arm, "vendor_agent")
    if vendor_agent not in VENDOR_AGENTS:
        raise HarborTrialAdmissionError(f"unsupported vendor agent: {vendor_agent}")
    return vendor_agent


def _initial_trial_environment(seed: TrialSeed) -> dict[str, str]:
    if _vendor_agent(seed.arm) is not None:
        return dict(sorted(_common_trial_environment(seed).items()))
    return _trial_environment(seed, arm_backend(seed.arm))


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
    value = _required_text(_require_trial_proxy(trial_proxy), "bound_source_ip")
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
        sealed[_canonical_target(target)] = str(path.resolve(strict=True))
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
    _validate_environment_values(environment)
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
    runtime = _contract_runtime_mounts(contract)
    return TrialEnvironmentConfig(
        import_path=ADMISSION_ENVIRONMENT_IMPORT_PATH,
        env=dict(environment), kwargs=kwargs,
        mounts=[
            ServiceVolumeConfig(type="bind", source=source, target=target, read_only=True)
            for target, source in sorted(runtime.items())
        ] or None,
    )


def _verifier_config(verifier_timeout_seconds: int | None) -> dict[str, object]:
    """An undeclared verifier timeout leaves the task's own `[verifier] timeout_sec` in force."""
    if verifier_timeout_seconds is None:
        return {}
    seconds = float(verifier_timeout_seconds)
    return {"verifier": VerifierConfig(
        override_timeout_sec=seconds, max_timeout_sec=seconds)}


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
        trial = await Trial.create(config)
        if type(trial.agent_environment) is not AdmittedDockerEnvironment:
            raise HarborTrialAdmissionError("Harbor did not construct the admitted environment")
        trial.agent_environment.bind_proxy_controller(trial.agent)
        return trial
    finally:
        if credential_handle is not None:
            HOST_CREDENTIAL_VAULT.purge(credential_handle)


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
    value = _required_text(contract, key)
    return Path(value).resolve(strict=True)


def _contract_runtime_mounts(contract: Mapping[str, object]) -> dict[str, str]:
    value = contract.get("runtime_mounts")
    if not isinstance(value, Mapping) or not all(
        isinstance(target, str) and isinstance(source, str)
        for target, source in value.items()
    ):
        raise HarborTrialAdmissionError(
            "admission policy runtime_mounts must map container targets to host sources")
    return {str(target): str(source) for target, source in value.items()}


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
    admitted = _contract_keys(contract, "admitted_environment_keys")
    if set(values) != admitted or environment_digest(values) != contract["environment_digest"]:
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
    source_checkout = _cortex_checkout_root(source)
    if source == home or home.is_relative_to(source) or source_checkout is not None:
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
    task_root: Path, trial_root: Path, runtime: Mapping[str, str],
) -> dict[str, object]:
    _validate_mount_shape(mount)
    source = Path(str(mount.get("source", ""))).resolve(strict=True)
    target = _canonical_target(str(mount.get("target", "")))
    _reject_sensitive_source(source)
    owner, read_only = _mount_owner(mount, source, target, standard, task_root, runtime)
    if owner == "harbor-output-handoff" and not source.is_relative_to(trial_root):
        raise HarborTrialAdmissionError(f"Harbor mount escapes trial root: {source}")
    if owner == "harbor-task-input" and _overlaps(source, trial_root.parent):
        raise HarborTrialAdmissionError(f"Harbor input exposes a sibling trial root: {source}")
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
    standard: Mapping[str, Path], task_root: Path, runtime: Mapping[str, str],
) -> tuple[str, bool]:
    standard_owner = _standard_mount_owner(mount, source, target, standard)
    if standard_owner is not None:
        return standard_owner
    if target in runtime:
        return _runtime_mount_owner(mount, source, target, runtime)
    if target != "/harbor/input" or not source.is_relative_to(task_root):
        raise HarborTrialAdmissionError(f"extra bind mount is not admitted: {target}")
    if mount.get("read_only") is not True:
        raise HarborTrialAdmissionError("Harbor task input mount must be read-only")
    return "harbor-task-input", True


def _runtime_mount_owner(
    mount: ServiceVolumeConfig, source: Path, target: str, runtime: Mapping[str, str],
) -> tuple[str, bool]:
    """A staged runtime is admitted at exactly the target and source the contract sealed.

    Read-only is not a courtesy here. The same tree is mounted into every concurrent trial of the
    campaign, so a writable mount would let one trial modify the interpreter the next twenty run
    on, and the trials would stop being independent measurements of the same thing.
    """
    if str(source) != runtime[target]:
        raise HarborTrialAdmissionError(
            f"runtime mount at {target} differs from the sealed staged root")
    if mount.get("read_only") is not True:
        raise HarborTrialAdmissionError(f"runtime mount at {target} must be read-only")
    return "harness-staged-runtime", True


def _refresh_mount_records(records: Sequence[dict[str, object]]) -> None:
    for record in records:
        info = Path(str(record["source"])).stat()
        record["uid"] = info.st_uid
        record["gid"] = info.st_gid
        record["source_mode"] = oct(stat.S_IMODE(info.st_mode))


def _canonical_mount(record: Mapping[str, object]) -> ServiceVolumeConfig:
    mount = ServiceVolumeConfig(
        type="bind", source=str(record["source"]), target=str(record["target"]),
    )
    if record["access"] == "read-only":
        mount["read_only"] = True
    return mount


def _mount_records(
    mounts: Sequence[ServiceVolumeConfig] | None, trial_paths: TrialPaths,
    contract: Mapping[str, object],
) -> tuple[list[dict[str, object]], list[ServiceVolumeConfig]]:
    task_root = _contract_path(contract, "task_root")
    trial_root = _contract_path(contract, "trial_root")
    actual_trial_root = trial_paths.trial_dir.resolve(strict=True)
    if actual_trial_root != trial_root:
        raise HarborTrialAdmissionError("Harbor trial root differs from sealed policy")
    standard = _standard_mounts(trial_paths)
    runtime = _contract_runtime_mounts(contract)
    records = [
        _mount_record(mount, standard, task_root, trial_root, runtime)
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
    return ordered, [_canonical_mount(record) for record in ordered]


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
    proxy_host = _required_text(contract, "proxy_host")
    expected = access.startup_policy()
    if startup != expected or any(policy != expected for policy in phases or []):
        raise HarborTrialAdmissionError(
            "Harbor network policy differs from the sealed network declaration")
    record = network_record(access, expected, access.effective_policy(proxy_host), denylist)
    record["proxy_route"] = {
        "host": proxy_host, "scope": "current-trial",
        "trial_id": _required_text(contract, "trial_id"),
    }
    return record


def _projection_record(projection: VendorRuntimeProjection) -> dict[str, object]:
    return {
        "vendor_agent": projection.vendor_agent,
        "environment": dict(sorted(projection.environment.items())),
    }


def _evidence_document(
    contract: Mapping[str, object], mounts: list[dict[str, object]], network: Mapping[str, object],
    projection: VendorRuntimeProjection | None = None,
    image_environment: Mapping[str, str] | None = None,
) -> dict[str, object]:
    environment: dict[str, object] = {
        "admitted_keys": sorted(_contract_keys(contract, "admitted_environment_keys")),
        "configured_keys": sorted(_contract_keys(contract, "configured_environment_keys")),
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
        "trial_id": _required_text(contract, "trial_id"),
        "root_run_id": _required_text(contract, "root_run_id"),
        "image": {
            "reference": _required_text(contract, "image_ref"), "pinned": True,
            "declared_environment_keys": sorted(declared),
            "declared_environment_digest": environment_digest(declared),
        },
        "environment": environment,
        "mounts": redact_mount_sources(mounts),
        "network": dict(network),
    }


def _admit_final_inputs(
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
        environment_dir, task_env_config, _required_text(contract, "image_ref"),
        extra_docker_compose,
    )
    _validate_persistent_environment(persistent_env, contract)
    records, canonical_mounts = _mount_records(mounts, trial_paths, contract)
    _prepare_harbor_mount_modes(trial_paths)
    _refresh_mount_records(records)
    network = _network_record(network_policy, phase_network_policies, contract, denylist)
    return contract, records, network, canonical_mounts


def _prepare_admitted_environment(
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
    contract, _, _, canonical_mounts = _admit_final_inputs(
        environment_dir, task_env_config, trial_paths, admission,
        persistent_env, mounts, admitted_policy, admitted_phases,
        extra_docker_compose, denylist,
    )
    return access, denylist, admitted_policy, admitted_phases, contract, canonical_mounts


class AdmittedDockerEnvironment(PullDisabledDockerEnvironment):
    def __init__(
        self, environment_dir: Path, environment_name: str, session_id: str,
        trial_paths: TrialPaths, task_env_config: TaskEnvironmentConfig,
        *args: object, admission: Mapping[str, object], vendor_agent: str | None = None,
        persistent_env: dict[str, str] | None = None,
        mounts: list[ServiceVolumeConfig] | None = None,
        network_policy: NetworkPolicy | None = None,
        phase_network_policies: Sequence[NetworkPolicy] = (),
        extra_docker_compose: Sequence[Path | str] = (), **kwargs: Any,
    ) -> None:
        prepared = _prepare_admitted_environment(
            environment_dir, task_env_config, trial_paths, admission, persistent_env,
            mounts, network_policy, phase_network_policies, extra_docker_compose,
        )
        access, denylist, admitted_policy, admitted_phases, contract, canonical_mounts = prepared
        super().__init__(
            environment_dir, environment_name, session_id, trial_paths,
            task_env_config, *args, persistent_env=persistent_env,
            mounts=canonical_mounts, network_policy=admitted_policy,
            phase_network_policies=admitted_phases,
            extra_docker_compose=extra_docker_compose,
            external_network_name=f"{session_id}_default",
            proxy_host=_required_text(contract, "proxy_host"),
            container_ipv4=_required_text(contract, "container_ipv4"), **kwargs,
        )
        self._network_access = access
        self._denylist = denylist
        self._vendor_agent = vendor_agent
        self._seal_admission(contract, canonical_mounts, trial_paths)

    def _seal_admission(
        self, contract: Mapping[str, object],
        mounts: Sequence[ServiceVolumeConfig], trial_paths: TrialPaths,
    ) -> None:
        self._admission_contract = dict(contract)
        self._admitted_environment_keys = _contract_keys(
            contract, "admitted_environment_keys",
        )
        self._admitted_environment_digest = _required_text(
            contract, "environment_digest",
        )
        self._admitted_image_ref = _required_text(contract, "image_ref")
        self._sealed_mounts = [dict(mount) for mount in mounts]
        self._evidence_path = trial_paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME
        self._proxy_controller: Any | None = None
        # Filled by `_validate_image_configuration`, which runs before anything is armed. Empty
        # until then, and empty for an image that declares no environment of its own.
        self._image_environment: dict[str, str] = {}

    def bind_proxy_controller(self, controller: object) -> None:
        if self._proxy_controller is not None:
            raise HarborTrialAdmissionError("trial proxy controller is already bound")
        self._proxy_controller = controller

    def _current_admission(
        self,
    ) -> tuple[Mapping[str, object], list[dict[str, object]], dict[str, object]]:
        contract, records, network, mounts = _admit_final_inputs(
            self.environment_dir, self.task_env_config, self.trial_paths,
            self._admission_contract, self._persistent_env, self._mounts,
            self.network_policy, self._phase_network_policies,
            self.extra_docker_compose_paths, self._denylist,
        )
        if mounts != self._sealed_mounts:
            raise HarborTrialAdmissionError("Docker mounts differ from the sealed paths")
        return contract, records, network

    def _validate_image_configuration(self) -> None:
        environment, volumes = inspect_image_configuration(self._admitted_image_ref)
        if volumes:
            raise HarborTrialAdmissionError(
                f"image volumes are not admitted: {sorted(volumes)}"
            )
        steering = sorted(
            key for key in environment if key.upper() in IMAGE_ENVIRONMENT_DENYLIST
        )
        if steering:
            raise HarborTrialAdmissionError(
                f"image environment steers the container out of the sealed environment: {steering}"
            )
        self._image_environment = dict(sorted(environment.items()))

    def _arm_proxy_route(
        self, contract: Mapping[str, object],
    ) -> tuple[dict[str, object], object]:
        if self._proxy_controller is None:
            raise HarborTrialAdmissionError("trial proxy controller is not bound")
        session = self._proxy_controller.arm_admitted_proxy()
        parsed = urlsplit(session.handle.base_url)
        expected_host = _required_text(contract, "proxy_host")
        if parsed.scheme != "http" or parsed.hostname != expected_host or parsed.port is None:
            raise HarborTrialAdmissionError("armed proxy differs from admitted network route")
        if session.handle.trial_id != _required_text(contract, "trial_id"):
            raise HarborTrialAdmissionError("armed proxy differs from admitted trial identity")
        source = session.handle.manifest_block.get("source_binding")
        if not isinstance(source, Mapping) or source.get("kind") != "ip":
            raise HarborTrialAdmissionError("armed proxy source binding is unsupported")
        # The address the container is configured with and the only address its credential route
        # answers are one decision, so a drift between them refuses the trial rather than
        # producing a route bound to nobody.
        if _required_text(source, "value") != _required_text(contract, "container_ipv4"):
            raise HarborTrialAdmissionError(
                "armed proxy source binding differs from the admitted container address")
        route = {
            "scheme": parsed.scheme, "host": parsed.hostname, "port": parsed.port,
            "bound_source_ip": _required_text(source, "value"),
            "enforcement": self._route_enforcement(expected_host),
            "scope": "current-trial", "trial_id": session.handle.trial_id,
        }
        return route, session

    def _expected_vendor_environment(self, session: object) -> dict[str, str]:
        vendor_agent = self._vendor_agent
        handle = getattr(session, "handle", None)
        base_url = getattr(handle, "base_url", None)
        if not isinstance(base_url, str) or not base_url:
            raise HarborTrialAdmissionError("vendor projection requires an armed proxy URL")
        if vendor_agent == "claude-code":
            token = getattr(handle, "dummy_token", None)
            if not isinstance(token, str) or not token:
                raise HarborTrialAdmissionError("vendor projection requires a dummy token")
            return {"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": token}
        if vendor_agent == "codex":
            return dict(VENDOR_FIXED_ENVIRONMENT["codex"])
        if vendor_agent == "pi":
            return dict(VENDOR_FIXED_ENVIRONMENT["pi"])
        raise HarborTrialAdmissionError(f"unsupported vendor agent: {vendor_agent}")

    def _project_vendor_runtime(self, session: object) -> VendorRuntimeProjection:
        project = getattr(self._proxy_controller, "project_vendor_runtime", None)
        if not callable(project):
            raise HarborTrialAdmissionError("vendor runtime projection is unavailable")
        projection = project(session)
        if not isinstance(projection, VendorRuntimeProjection):
            raise HarborTrialAdmissionError("vendor runtime projection is invalid")
        if projection.vendor_agent != self._vendor_agent:
            raise HarborTrialAdmissionError("vendor runtime projection names another vendor")
        actual = dict(projection.environment)
        expected = self._expected_vendor_environment(session)
        unknown = sorted(set(actual) - set(expected))
        if unknown:
            raise HarborTrialAdmissionError(
                f"vendor runtime projection has unknown keys: {unknown}")
        if actual != expected:
            raise HarborTrialAdmissionError("vendor runtime projection has value drift")
        _validate_environment_values(actual)
        return VendorRuntimeProjection(projection.vendor_agent, dict(sorted(actual.items())))

    def _reseal_vendor_environment(self, projection: VendorRuntimeProjection) -> None:
        static_environment = dict(self._persistent_env)
        _validate_persistent_environment(static_environment, self._admission_contract)
        environment = dict(sorted({**static_environment, **projection.environment}.items()))
        if any(key.startswith("CORTEX_") for key in environment):
            raise HarborTrialAdmissionError("vendor runtime environment contains Cortex keys")
        digest = environment_digest(environment)
        self._persistent_env = environment
        self._admitted_environment_keys = frozenset(environment)
        self._admitted_environment_digest = digest
        self._admission_contract.update(
            admitted_environment_keys=sorted(environment), environment_digest=digest,
        )

    def _route_enforcement(self, proxy_host: str) -> dict[str, str]:
        """What actually constrains this route, rather than what once always did.

        Under `open` nothing does: the container reaches the whole internet and the proxy is
        simply where the credential lives. The port pin only exists for the proxy-only allowlist,
        because it rejects every marked connection that is not to the proxy -- correct when the
        proxy is the sole destination, and fatal to any broader allowlist.
        """
        if not self._network_access.filtered:
            return {"host": "none", "port": "none"}
        effective = self._network_access.effective_policy(proxy_host)
        return {
            "host": "harbor-allowlist" if effective.allowed_hosts else "none",
            "port": (
                "marked-egress-nftables"
                if effective.allowed_hosts == [proxy_host] else "none"
            ),
        }

    def _revoke_proxy(self) -> None:
        if self._proxy_controller is not None:
            self._proxy_controller.revoke_admitted_proxy()

    def _admit_vendor_runtime(
        self, session: object,
    ) -> tuple[VendorRuntimeProjection | None, Mapping[str, object], list[dict[str, object]], dict[str, object]]:
        if self._vendor_agent is None:
            contract, records, network = self._current_admission()
            return None, contract, records, network
        projection = self._project_vendor_runtime(session)
        self._reseal_vendor_environment(projection)
        contract, records, network = self._current_admission()
        return projection, contract, records, network

    @override
    async def start(self, force_build: bool) -> None:
        if force_build:
            raise HarborTrialAdmissionError("force_build bypasses the admitted pinned image")
        contract, _, _ = self._current_admission()
        await asyncio.to_thread(self._validate_image_configuration)
        try:
            route, session = self._arm_proxy_route(contract)
            projection, contract, records, network = self._admit_vendor_runtime(session)
            network["proxy_route"] = route
            document = _evidence_document(
                contract, records, network, projection, self._image_environment)
            if projection is not None:
                atomic_write_json(self._evidence_path, document)
            await super().start(force_build=False)
            document["cpuset"] = await self._require_pinned_cpus()
            await self._enforce_admitted_network(
                _required_text(contract, "proxy_host"), int(route["port"]))
            atomic_write_json(self._evidence_path, document)
        except BaseException:
            self._evidence_path.unlink(missing_ok=True)
            self._revoke_proxy()
            raise

    async def _require_pinned_cpus(self) -> dict[str, object]:
        """Read the started container's CPU pin back and refuse a trial that lost it.

        A Compose overlay that was ignored looks exactly like one that worked, and the whole point
        of the pin is that a wall-clock threshold means the same thing in every trial. So the
        applied `CpusetCpus` is read from the running container and stated in the evidence rather
        than assumed from the file that asked for it.
        """
        declared = self.declared_cpuset()
        if declared is None:
            return {"declared": None, "applied": None}
        result = await asyncio.to_thread(
            subprocess.run,
            ["docker", "inspect", "--format", "{{.HostConfig.CpusetCpus}}",
             await self._main_container_id()],
            check=False, capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise HarborTrialAdmissionError("trial container CPU pin is unobservable")
        applied = (result.stdout or "").strip()
        if applied != declared:
            raise HarborTrialAdmissionError(
                f"trial was pinned to CPUs {declared} but the container was granted "
                f"{applied or 'the whole host'}")
        return {"declared": declared, "applied": applied}

    async def _enforce_admitted_network(self, proxy_host: str, proxy_port: int) -> None:
        """Narrow the started container from its deny-all baseline to the declared policy.

        Nothing happens under `open`: no sidecar exists, so there is no namespace to install rules
        in and nothing claiming to filter. Under `filtered` the order is deliberate — the denylist
        table goes in while the container is still denied everything, so there is no instant in
        which egress is open and unfiltered.
        """
        if not self._network_access.filtered:
            return
        await self._install_denylist_filter(*denylist_addresses(self._denylist))
        effective = self._network_access.effective_policy(proxy_host)
        if effective.allowed_hosts == [proxy_host]:
            # Proxy-only is the historical shape, and the only one where pinning every
            # gost-forwarded connection to the proxy port is correct. With any other allowlist the
            # same rule would reject the very hosts the campaign asked to reach.
            await self._install_proxy_endpoint_filter(proxy_port)
        await self.set_network_policy(effective)

    def _container_boundary_probe(self) -> ContainerBoundaryProbe:
        return ContainerBoundaryProbe()

    async def _main_container_id(self) -> str:
        result = await self._run_docker_compose_command(["ps", "--quiet", "main"])
        values = (result.stdout or "").splitlines()
        if len(values) != 1 or re.fullmatch(r"[a-f0-9]{64}", values[0]) is None:
            raise HarborTrialAdmissionError("trial container identity is unobservable")
        return values[0]

    async def _remove_verifier_uvx_alias(self) -> None:
        """Remove only the verifier installer's known alias before output collection."""
        alias = str(VERIFIER_UVX_ALIAS)
        target = str(VERIFIER_UVX_TARGET)
        command = (
            f"set -eu; alias={alias}; target={target}; "
            "if [ -L \"$alias\" ] "
            "&& [ \"$(readlink -- \"$alias\")\" = \"$target\" ] "
            "&& [ -f \"$target\" ] && [ ! -L \"$target\" ]; then "
            "unlink -- \"$alias\"; fi"
        )
        result = await self._compose_exec(
            command, service="main", cwd=self.task_env_config.workdir,
            env=None, timeout_sec=None, user=self._resolve_user("root"),
        )
        if result.return_code != 0:
            raise HarborTrialAdmissionError("verifier uvx alias removal failed")

    async def _discard_trial_scratch(self) -> None:
        """Discard the scratch trees as root while the container is still alive."""
        # Absolute paths throughout, so this needs no working directory of its own.
        result = await self._compose_exec(
            trial_scratch_discard_command(), service="main",
            cwd=None, env=None, timeout_sec=None, user=self._resolve_user("root"),
        )
        if result.return_code != 0:
            raise HarborTrialAdmissionError("trial scratch discard failed")

    async def _finalize_after_container_stop(self) -> None:
        controller = self._proxy_controller
        if controller is None or not getattr(controller, "post_stop_finalization_pending", False):
            return
        await self._remove_verifier_uvx_alias()
        await self._discard_trial_scratch()
        probe = self._container_boundary_probe()
        census = None
        try:
            container_id = await self._main_container_id()
            census = await probe.capture(container_id)
        except (HarborTrialAdmissionError, ContainerBoundaryUnproven):
            pass
        await self._run_docker_compose_command(["stop"])
        observation = None
        if census is not None:
            try:
                observation = await probe.observe_after_stop(census)
            except ContainerBoundaryUnproven:
                pass
        controller.finalize_after_container_stop(observation)

    @override
    async def stop(self, delete: bool) -> None:
        failure: BaseException | None = None
        try:
            await self._finalize_after_container_stop()
        except BaseException as error:
            failure = error
        try:
            await super().stop(delete=delete)
        except BaseException as cleanup_error:
            if failure is not None:
                raise failure from cleanup_error
            raise
        finally:
            self._revoke_proxy()
        if failure is not None:
            raise failure

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
            isolated_command(command, merged), service="main",
            cwd=cwd or self.task_env_config.workdir, env=None,
            timeout_sec=timeout_sec, user=self._resolve_user(user),
        )
