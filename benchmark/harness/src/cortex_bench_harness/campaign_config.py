# input:  one committed campaign YAML document and the directory it is read against
# output: a strictly validated campaign with its ordered trial plan, or a refusal
# pos:    Campaign configuration boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The campaign document is the run's declared configuration: arms, tasks, the proxy envelope, and
# the address space and concurrency its trials run in. It is read closed-world — an unknown key is
# a refusal, not a comment — because the failure this boundary must not have is a typo that
# silently drops a bound. Every refusal names the offending field and what the field accepts, so
# the operator can fix the file without reading this module.
#
# Three fields a reader may go looking for are deliberately gone. `cost_ceiling_usd` was a
# between-trial stop on accumulated published cost; with trials in flight it could be overshot by
# a whole wave and could not see the money being spent while it was being checked, so it is
# refused rather than kept as the appearance of a bound. What still bounds spend is per-trial and
# proxy-enforced: max_provider_requests, and deadline_seconds. The proxy's cost pair
# (`max_request_cost_usd` with the two per-million prices) and the arm's `max_cost_usd` are gone
# too: the reservation they funded was never reconciled against actual cost, so the pair only ever
# expressed a request count that `max_provider_requests` already states, and holding a price list
# at the proxy made it over-state a 99.2%-cached trial by 12.7x.
# `proxy.bound_source_ip` was one literal describing one container; it is now derived per slot.

import ipaddress
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
import re

import yaml

from .launcher.arms import IMAGE_DIGEST
from .launcher.comparison_report import DIFFERENCE_CLASSES
from .launcher.trial_proxy import TrialProxySpec, parse_trial_proxy_spec

CAMPAIGN_SCHEMA_VERSION = "cortex-bench-campaign/1"
ARM_SCHEMA_VERSION = "cortex-benchmark-arm/2"
# Campaign, arm and task identifiers become one Harbor trial id, which is a container hostname.
IDENTIFIER = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

CAMPAIGN_REQUIRED_FIELDS = frozenset({
    "schema_version", "campaign", "paid", "trials_dir", "cli_version",
    "manifest", "credential", "host_scan_policy", "docker_network", "proxy", "arms", "tasks",
})
# `concurrency` is absent-means-one: a document that says nothing about parallelism gets the
# serial campaign it has always described.
CAMPAIGN_OPTIONAL_FIELDS = frozenset({"comparisons", "timeouts", "concurrency"})
# Harbor bounds the agent and verifier phases separately from the arm's own deadline. Absent
# means today's behaviour: the agent phase is cut at `limits.deadline_seconds`, and the verifier
# at whatever the task's own `[verifier] timeout_sec` declares. Declaring them here overrides a
# digest-pinned task.toml without editing one, which is what Harbor's override fields are for.
TIMEOUT_FIELDS = frozenset({"agent_seconds", "verifier_seconds"})
MANIFEST_FIELDS = frozenset({
    "wheel_path", "lockfile_path", "lockfile_manifest_path", "npm_artifact_path",
})
MANIFEST_PATH_FIELDS = ("wheel_path", "lockfile_path", "npm_artifact_path")
CREDENTIAL_FIELDS = frozenset({
    "upstream_base_url", "route_identity_host", "proxy_host_suffix", "dummy_token_ref",
})
# The campaign declares the route's SUFFIX, never a whole URL: admission requires each trial's
# proxy hostname to begin with that trial's own id (`trial_admission._validate_proxy_destination`),
# so one campaign-wide URL could satisfy at most one trial. The port is absent on purpose — the
# live route's port is whatever the armed proxy handle binds, and admission reads only the host.
CREDENTIAL_SEED_FIELDS = ("upstream_base_url", "route_identity_host", "dummy_token_ref")
# The campaign declares an address POOL, never one subnet: concurrent trials need one Docker
# network each, and Docker refuses two networks whose subnets overlap.
DOCKER_NETWORK_FIELDS = frozenset({"subnet_pool", "subnet_prefix"})
# A slot needs a gateway (.1) and a container (.2) below the broadcast address, so /30 is the
# smallest network that can carry a trial.
SMALLEST_SLOT_PREFIX = 30
DEFAULT_CONCURRENCY = 1
PROXY_ROUTE_SCHEME = "http"
HOST_SUFFIX = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")
MAXIMUM_HOSTNAME_LENGTH = 253
# The destinations admission refuses outright, restated from `_forbidden_network_hosts` so a
# campaign that would compose one is refused while it is still a document.
FORBIDDEN_ROUTE_HOSTS = frozenset({"169.254.169.254", "metadata.google.internal"})
HOST_SCAN_POLICY_MAPPING_FIELDS = (
    "secret_environment", "forbidden_environment", "forbidden_argv_environment",
    "host_identity_environment",
)
HOST_SCAN_POLICY_TEXT_FIELDS = ("repository_checkout_environment",)
HOST_SCAN_POLICY_FIELDS = frozenset(
    HOST_SCAN_POLICY_MAPPING_FIELDS + HOST_SCAN_POLICY_TEXT_FIELDS)
ARM_REQUIRED_FIELDS = frozenset({
    "name", "kind", "backend", "provider", "model", "credential_capability",
    "orchestration", "limits",
})
ORCHESTRATION_REQUIRED_FIELDS = frozenset({"mode", "ask_manager"})
ORCHESTRATION_OPTIONAL_FIELDS = frozenset({"coder_review_variant"})
# Campaign limits describe the host envelope. Orchestration and concurrency live in the committed
# production config bundle rather than a second arm schema.
ARM_POSITIVE_LIMITS = (
    "max_provider_requests", "deadline_seconds", "max_output_tokens",
)
ARM_LIMIT_FIELDS = frozenset(ARM_POSITIVE_LIMITS + ("max_cost_usd",))
TASK_REQUIRED_FIELDS = frozenset({"task_id", "path", "image_ref"})
TASK_OPTIONAL_FIELDS = frozenset({"image_size_bytes"})
COMPARISON_FIELDS = frozenset({"left_arm", "right_arm", "difference_class"})


class CampaignConfigError(ValueError):
    """A campaign document could not be read as a complete, bounded campaign."""


@dataclass(frozen=True)
class NetworkSlot:
    """One concurrency slot's whole address space: its network, its gateway, its container.

    `container_ip` is not a description — it is the address the trial's credential route binds to
    and the only source it will answer, so it is pinned into the container's own Docker network
    configuration rather than predicted from Docker's allocation order.
    """

    index: int
    subnet: str
    gateway: str
    container_ip: str


@dataclass(frozen=True)
class DockerNetworkPool:
    """The address space a campaign may carve concurrent trial networks out of."""

    subnet_pool: str
    subnet_prefix: int

    @property
    def slot_count(self) -> int:
        return 1 << (self.subnet_prefix - ipaddress.IPv4Network(self.subnet_pool).prefixlen)

    def slot(self, index: int) -> NetworkSlot:
        if not 0 <= index < self.slot_count:
            raise CampaignConfigError(
                f"concurrency slot {index} is outside the {self.slot_count} slots "
                f"{self.subnet_pool} carves into /{self.subnet_prefix} networks")
        pool = ipaddress.IPv4Network(self.subnet_pool)
        size = 1 << (pool.max_prefixlen - self.subnet_prefix)
        network = ipaddress.IPv4Network(
            (int(pool.network_address) + index * size, self.subnet_prefix))
        return NetworkSlot(
            index=index, subnet=str(network),
            gateway=str(network.network_address + 1),
            container_ip=str(network.network_address + 2),
        )

    def as_document(self) -> dict[str, object]:
        return {"subnet_pool": self.subnet_pool, "subnet_prefix": self.subnet_prefix}


@dataclass(frozen=True)
class CampaignTask:
    task_id: str
    path: Path
    image_ref: str
    image_digest: str
    image_size_bytes: int | None

    def as_seed_task(self) -> dict[str, object]:
        return {"task_id": self.task_id, "image_ref": self.image_ref,
                "image_digest": self.image_digest}


@dataclass(frozen=True)
class TrialPlan:
    trial_id: str
    root_run_id: str
    arm: Mapping[str, object]
    task: CampaignTask

    @property
    def arm_name(self) -> str:
        return str(self.arm["name"])


@dataclass(frozen=True)
class CampaignConfig:
    source: str
    campaign: str
    paid: bool
    trials_dir: Path
    cli_version: str
    manifest: Mapping[str, object]
    credential: Mapping[str, object]
    proxy_host_suffix: str
    host_scan_policy: Mapping[str, object]
    docker_network: DockerNetworkPool
    concurrency: int
    proxy: Mapping[str, object]
    timeouts: Mapping[str, int]
    arms: tuple[Mapping[str, object], ...]
    tasks: tuple[CampaignTask, ...]
    comparisons: tuple[Mapping[str, object], ...]

    def slot(self, index: int) -> NetworkSlot:
        return self.docker_network.slot(index)

    def slot_proxy(self, slot: NetworkSlot) -> dict[str, object]:
        """This slot's trial proxy spec: the declared envelope plus the address it binds to.

        `bound_source_ip` is derived here rather than declared, because one document literal can
        describe at most one concurrent container.
        """
        return {**dict(self.proxy), "bound_source_ip": slot.container_ip}

    def trials(self) -> tuple[TrialPlan, ...]:
        """Every declared trial, task-major so an interrupted campaign still compares arms."""
        return tuple(
            _trial_plan(self.campaign, arm, task)
            for task in self.tasks for arm in self.arms
        )

    def trial_manifest(self, plan: TrialPlan) -> dict[str, object]:
        return {
            "root_run_id": plan.root_run_id, "trial_id": plan.trial_id,
            "arm": plan.arm_name, **dict(self.manifest),
            "image_ref": plan.task.image_ref, "image_digest": plan.task.image_digest,
            "image_size_bytes": plan.task.image_size_bytes,
        }

    def trial_route(self, plan: TrialPlan) -> str:
        """This trial's own proxy route: admission accepts no hostname but its own trial id."""
        return f"{PROXY_ROUTE_SCHEME}://{plan.trial_id}.{self.proxy_host_suffix}"

    def trial_credential(self, plan: TrialPlan) -> dict[str, object]:
        return {**dict(self.credential), "proxy_base_url": self.trial_route(plan)}

    def trial_seed(self, plan: TrialPlan) -> dict[str, object]:
        return {
            "arm": dict(plan.arm), "arm_path": f"arm://{plan.arm_name}",
            "trial_id": plan.trial_id, "root_run_id": plan.root_run_id,
            "task": plan.task.as_seed_task(), "profile_name": PROFILE_NAME,
            "paid_run": self.paid, "pi_benchmark_capability_proven": True,
            "credential": self.trial_credential(plan),
            "model_alias_policy": dict(MODEL_ALIAS_POLICY),
        }


# The benchmark profile and the exact-alias policy are properties of the harness, not choices a
# campaign makes: the agent refuses any other profile name and an alias would unfreeze the model.
PROFILE_NAME = "benchmark"
MODEL_ALIAS_POLICY = {"kind": "exact"}


def load_campaign_config(path: Path | str) -> CampaignConfig:
    """Read a campaign document from a file, resolving relative paths beside it."""
    source = Path(path)
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as error:
        raise CampaignConfigError(
            f"cannot read campaign config {source}: {error.strerror or error}") from error
    return parse_campaign_config(
        text, base_dir=source.resolve().parent, source=str(source))


def parse_campaign_config(
    text: str, *, base_dir: Path, source: str,
) -> CampaignConfig:
    """Read a campaign document, resolving relative paths against `base_dir`."""
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise CampaignConfigError(f"campaign config {source} is not valid YAML: {error}") from error
    if not isinstance(document, Mapping):
        raise CampaignConfigError(f"campaign config {source} must be a mapping")
    _require_fields(document, CAMPAIGN_REQUIRED_FIELDS, CAMPAIGN_OPTIONAL_FIELDS, "campaign")
    version = document.get("schema_version")
    if version != CAMPAIGN_SCHEMA_VERSION:
        raise CampaignConfigError(
            f"campaign schema_version must be {CAMPAIGN_SCHEMA_VERSION!r}; got {version!r}")
    arms = _arms(document["arms"])
    declared = _exact_text_mapping(document["credential"], CREDENTIAL_FIELDS, "credential")
    pool = _docker_network(document["docker_network"])
    config = CampaignConfig(
        source=source,
        campaign=_identifier(document, "campaign"),
        paid=_boolean(document, "paid"),
        trials_dir=_path(document, "trials_dir", base_dir),
        cli_version=_text(document, "cli_version"),
        manifest=_manifest(document["manifest"], base_dir),
        credential={field: declared[field] for field in CREDENTIAL_SEED_FIELDS},
        proxy_host_suffix=_host_suffix(declared["proxy_host_suffix"]),
        host_scan_policy=_host_scan_policy(document["host_scan_policy"]),
        docker_network=pool,
        concurrency=_concurrency(document, pool),
        proxy=_proxy(document["proxy"], pool),
        timeouts=_timeouts(document.get("timeouts")),
        arms=arms,
        tasks=_tasks(document["tasks"], base_dir),
        comparisons=_comparisons(document.get("comparisons", []), arms),
    )
    _validate_trial_routes(config)
    return config


def _timeouts(value: object) -> Mapping[str, int]:
    """Read the optional Harbor phase timeouts, closed-world and positive."""
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise CampaignConfigError("campaign timeouts must be a mapping")
    _require_fields(value, frozenset(), TIMEOUT_FIELDS, "campaign timeouts")
    return {field: _positive_int(value, field) for field in TIMEOUT_FIELDS if field in value}


def _host_suffix(value: str) -> str:
    suffix = value.lower()
    if suffix != value or HOST_SUFFIX.fullmatch(suffix) is None:
        raise CampaignConfigError(
            f"campaign credential proxy_host_suffix must be a lowercase DNS suffix such as "
            f"'proxy.invalid'; got {value!r}. The trial id is prefixed to it, so declare no "
            "scheme, port or path")
    return suffix


def _validate_trial_routes(config: CampaignConfig) -> None:
    """Refuse a campaign whose composed routes admission would reject, while it is still a file.

    Admission owns this rule (`trial_admission._proxy_host`): the hostname's first label must be
    the trial's own id and must name no forbidden destination. Checking it here turns a failure
    on trial one into a refusal before any trial is armed.
    """
    forbidden = {str(config.credential["route_identity_host"]).lower(), *FORBIDDEN_ROUTE_HOSTS}
    upstream = urlsplit(str(config.credential["upstream_base_url"])).hostname
    if upstream:
        forbidden.add(upstream.lower())
    for plan in config.trials():
        hostname = f"{plan.trial_id}.{config.proxy_host_suffix}"
        if len(hostname) > MAXIMUM_HOSTNAME_LENGTH:
            raise CampaignConfigError(
                f"campaign trial {plan.trial_id} composes the over-long proxy hostname "
                f"{hostname!r}")
        if hostname in forbidden:
            raise CampaignConfigError(
                f"campaign trial {plan.trial_id} composes the proxy hostname {hostname!r}, "
                "which is the upstream, the route identity host or a metadata address; "
                "admission refuses a route that names one")





def _trial_plan(
    campaign: str, arm: Mapping[str, object], task: CampaignTask,
) -> TrialPlan:
    arm_name = str(arm["name"])
    trial_id = f"{campaign}-{task.task_id}-{arm_name}"
    if IDENTIFIER.fullmatch(trial_id) is None:
        raise CampaignConfigError(
            f"campaign, task_id and arm name compose the invalid trial id {trial_id!r}; "
            "it must match [a-z0-9-] and stay within 63 characters")
    return TrialPlan(
        trial_id=trial_id, root_run_id=f"{trial_id}.{arm_name}", arm=arm, task=task)


def _require_fields(
    document: Mapping[str, object], required: frozenset[str],
    optional: frozenset[str], label: str,
) -> None:
    rejected = sorted(set(document) - required - optional)
    if rejected:
        raise CampaignConfigError(
            f"{label} rejects unknown fields {rejected}; "
            f"it accepts {sorted(required | optional)}")
    missing = sorted(required - set(document))
    if missing:
        raise CampaignConfigError(f"{label} requires fields {missing}")


def _text(document: Mapping[str, object], field: str, label: str = "campaign") -> str:
    value = document.get(field)
    if not isinstance(value, str) or not value:
        raise CampaignConfigError(f"{label} {field} must be a non-empty string")
    return value


def _identifier(document: Mapping[str, object], field: str, label: str = "campaign") -> str:
    value = _text(document, field, label)
    if IDENTIFIER.fullmatch(value) is None:
        raise CampaignConfigError(
            f"{label} {field} must match [a-z0-9-] and start and end with [a-z0-9]; "
            f"got {value!r}")
    return value


def _boolean(document: Mapping[str, object], field: str, label: str = "campaign") -> bool:
    value = document.get(field)
    if not isinstance(value, bool):
        raise CampaignConfigError(f"{label} {field} must be true or false")
    return value


def _positive_int(
    document: Mapping[str, object], field: str, label: str = "campaign",
) -> int:
    value = document.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise CampaignConfigError(f"{label} {field} must be a positive integer")
    return value



def _positive_decimal(
    document: Mapping[str, object], field: str, label: str = "campaign",
) -> Decimal:
    # Decimal strings only: a YAML float would be compared through a binary approximation of the
    # number the reviewer of this file read.
    value = document.get(field)
    if not isinstance(value, str):
        raise CampaignConfigError(
            f"{label} {field} must be a decimal string such as \"10.00\"")
    try:
        parsed = Decimal(value)
    except InvalidOperation as error:
        raise CampaignConfigError(
            f"{label} {field} must be a decimal string such as \"10.00\"; "
            f"got {value!r}") from error
    if not parsed.is_finite() or parsed <= 0:
        raise CampaignConfigError(f"{label} {field} must be a positive decimal; got {value!r}")
    return parsed


def _path(
    document: Mapping[str, object], field: str, base_dir: Path, label: str = "campaign",
) -> Path:
    return _resolve(_text(document, field, label), base_dir)


def _resolve(value: str, base_dir: Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else (base_dir / path).resolve()


def _manifest(source: object, base_dir: Path) -> dict[str, object]:
    document = _mapping(source, "campaign manifest")
    _require_fields(document, MANIFEST_FIELDS, frozenset(), "campaign manifest")
    manifest: dict[str, object] = {
        field: str(_resolve(_text(document, field, "campaign manifest"), base_dir))
        for field in MANIFEST_PATH_FIELDS
    }
    manifest["lockfile_manifest_path"] = _text(
        document, "lockfile_manifest_path", "campaign manifest")
    return manifest


def _exact_text_mapping(
    source: object, fields: frozenset[str], label: str,
) -> dict[str, object]:
    document = _mapping(source, f"campaign {label}")
    _require_fields(document, fields, frozenset(), f"campaign {label}")
    return {field: _text(document, field, f"campaign {label}") for field in sorted(fields)}


def _host_scan_policy(source: object) -> dict[str, object]:
    document = _mapping(source, "campaign host_scan_policy")
    _require_fields(
        document, HOST_SCAN_POLICY_FIELDS, frozenset(), "campaign host_scan_policy")
    policy: dict[str, object] = {
        field: _text(document, field, "campaign host_scan_policy")
        for field in HOST_SCAN_POLICY_TEXT_FIELDS
    }
    for field in HOST_SCAN_POLICY_MAPPING_FIELDS:
        rules = _mapping(document.get(field), f"campaign host_scan_policy {field}")
        policy[field] = {
            _rule_name(field, rule): _text(rules, rule, f"campaign host_scan_policy {field}")
            for rule in rules
        }
    return policy


def _rule_name(field: str, rule: object) -> str:
    if not isinstance(rule, str) or not rule:
        raise CampaignConfigError(
            f"campaign host_scan_policy {field} rule names must be non-empty strings")
    return rule


def _docker_network(source: object) -> DockerNetworkPool:
    """Read the address pool concurrent trial networks are carved from.

    A pool rather than a subnet, because Docker refuses to create two networks whose subnets
    overlap: one literal can serve one trial at a time. A private pool is required — carving a
    Docker subnet out of routable space would blackhole real destinations from inside the trial.
    """
    document = _mapping(source, "campaign docker_network")
    _require_fields(document, DOCKER_NETWORK_FIELDS, frozenset(), "campaign docker_network")
    text = _text(document, "subnet_pool", "campaign docker_network")
    try:
        pool = ipaddress.IPv4Network(text, strict=True)
    except ValueError as error:
        raise CampaignConfigError(
            f"campaign docker_network subnet_pool must be an IPv4 network with zero host bits, "
            f"such as '172.30.240.0/20'; got {text!r} ({error})") from error
    if not pool.is_private:
        raise CampaignConfigError(
            f"campaign docker_network subnet_pool {text} is not private address space; a trial "
            "network carved out of routable space would blackhole real destinations")
    prefix = _positive_int(document, "subnet_prefix", "campaign docker_network")
    if not pool.prefixlen <= prefix <= SMALLEST_SLOT_PREFIX:
        raise CampaignConfigError(
            f"campaign docker_network subnet_prefix must be between the pool's own "
            f"/{pool.prefixlen} and /{SMALLEST_SLOT_PREFIX}, which is the smallest network that "
            f"still carries a gateway and a container; got /{prefix}")
    return DockerNetworkPool(subnet_pool=str(pool), subnet_prefix=prefix)


def _concurrency(document: Mapping[str, object], pool: DockerNetworkPool) -> int:
    """How many trials may be in flight, bounded by the addresses the campaign declared."""
    if "concurrency" not in document:
        return DEFAULT_CONCURRENCY
    value = _positive_int(document, "concurrency")
    if value > pool.slot_count:
        raise CampaignConfigError(
            f"campaign concurrency {value} exceeds the {pool.slot_count} trial networks "
            f"{pool.subnet_pool} carves into /{pool.subnet_prefix} subnets; widen subnet_pool, "
            "raise subnet_prefix, or lower concurrency")
    return value


def _proxy(source: object, pool: DockerNetworkPool) -> dict[str, object]:
    document = _mapping(source, "campaign proxy")
    if "bound_source_ip" in document:
        raise CampaignConfigError(
            "campaign proxy rejects bound_source_ip: the address a trial's route binds to is "
            "derived per concurrency slot from docker_network, because one literal can describe "
            "at most one concurrent container")
    # The trial proxy spec already owns its own closed field set and value rules; parsing it here
    # keeps one definition of the route's envelope rather than a second, drifting copy. It is
    # parsed with the address slot 0 will really use, so the document is validated against a real
    # binding rather than a placeholder.
    try:
        parse_trial_proxy_spec({**document, "bound_source_ip": pool.slot(0).container_ip})
    except ValueError as error:
        raise CampaignConfigError(f"campaign proxy is invalid: {error}") from error
    return dict(document)


def _arms(source: object) -> tuple[Mapping[str, object], ...]:
    entries = _sequence(source, "campaign arms")
    arms = tuple(_arm(entry) for entry in entries)
    names = [str(arm["name"]) for arm in arms]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise CampaignConfigError(f"campaign arm names must be unique; repeated {duplicates}")
    return arms


def _arm(source: object) -> dict[str, object]:
    document = _mapping(source, "campaign arm")
    _require_fields(document, ARM_REQUIRED_FIELDS, frozenset(), "campaign arm")
    kind = _text(document, "kind", "campaign arm")
    if kind != "cortex":
        raise CampaignConfigError(
            f"campaign arm kind must be 'cortex'; got {kind!r}. Vendor baselines are declared "
            "outside a campaign document")
    return {
        "schema_version": ARM_SCHEMA_VERSION, "kind": "cortex",
        "name": _identifier(document, "name", "campaign arm"),
        **{field: _text(document, field, "campaign arm")
           for field in ("backend", "provider", "model", "credential_capability")},
        "orchestration": _orchestration(document["orchestration"]),
        "limits": _limits(document["limits"]),
    }


def _orchestration(source: object) -> dict[str, object]:
    document = _mapping(source, "campaign arm orchestration")
    _require_fields(
        document, ORCHESTRATION_REQUIRED_FIELDS, ORCHESTRATION_OPTIONAL_FIELDS,
        "campaign arm orchestration")
    orchestration: dict[str, object] = {
        "mode": _text(document, "mode", "campaign arm orchestration"),
        "ask_manager": _boolean(document, "ask_manager", "campaign arm orchestration"),
    }
    if "coder_review_variant" in document:
        orchestration["coder_review_variant"] = _text(
            document, "coder_review_variant", "campaign arm orchestration")
    return orchestration


def _limits(source: object) -> dict[str, object]:
    document = _mapping(source, "campaign arm limits")
    _require_fields(document, ARM_LIMIT_FIELDS, frozenset(), "campaign arm limits")
    limits: dict[str, object] = {
        field: _integer(document, field, minimum=1) for field in ARM_POSITIVE_LIMITS
    }
    limits["max_cost_usd"] = str(
        _positive_decimal(document, "max_cost_usd", "campaign arm limits"))
    return limits


def _integer(document: Mapping[str, object], field: str, *, minimum: int) -> int:
    value = document.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise CampaignConfigError(
            f"campaign arm limits {field} must be an integer of at least {minimum}; "
            f"got {value!r}")
    return value


def _tasks(source: object, base_dir: Path) -> tuple[CampaignTask, ...]:
    entries = _sequence(source, "campaign tasks")
    tasks = tuple(_task(entry, base_dir) for entry in entries)
    identifiers = [task.task_id for task in tasks]
    duplicates = sorted({value for value in identifiers if identifiers.count(value) > 1})
    if duplicates:
        raise CampaignConfigError(f"campaign task ids must be unique; repeated {duplicates}")
    return tasks


def _task(source: object, base_dir: Path) -> CampaignTask:
    document = _mapping(source, "campaign task")
    _require_fields(document, TASK_REQUIRED_FIELDS, TASK_OPTIONAL_FIELDS, "campaign task")
    image_ref = _text(document, "image_ref", "campaign task")
    _, _, digest = image_ref.rpartition("@")
    if IMAGE_DIGEST.fullmatch(digest) is None:
        raise CampaignConfigError(
            f"campaign task image_ref must be digest-pinned as <ref>@sha256:<64 hex>; "
            f"got {image_ref!r}")
    size = document.get("image_size_bytes")
    if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size <= 0):
        raise CampaignConfigError(
            "campaign task image_size_bytes must be a positive integer when declared")
    return CampaignTask(
        task_id=_identifier(document, "task_id", "campaign task"),
        path=_path(document, "path", base_dir, "campaign task"),
        image_ref=image_ref, image_digest=digest, image_size_bytes=size,
    )


def _comparisons(
    source: object, arms: Sequence[Mapping[str, object]],
) -> tuple[Mapping[str, object], ...]:
    entries = _sequence(source, "campaign comparisons", allow_empty=True)
    names = {str(arm["name"]) for arm in arms}
    return tuple(_comparison(entry, names) for entry in entries)


def _comparison(source: object, names: set[str]) -> dict[str, object]:
    document = _mapping(source, "campaign comparison")
    _require_fields(document, COMPARISON_FIELDS, frozenset(), "campaign comparison")
    comparison = {
        field: _text(document, field, "campaign comparison") for field in sorted(COMPARISON_FIELDS)
    }
    for field in ("left_arm", "right_arm"):
        if comparison[field] not in names:
            raise CampaignConfigError(
                f"campaign comparison {field} {comparison[field]!r} is not a declared arm; "
                f"declared arms are {sorted(names)}")
    if comparison["difference_class"] not in DIFFERENCE_CLASSES:
        raise CampaignConfigError(
            f"campaign comparison difference_class must be one of "
            f"{sorted(DIFFERENCE_CLASSES)}; got {comparison['difference_class']!r}")
    return comparison


def _mapping(source: object, label: str) -> Mapping[str, Any]:
    if not isinstance(source, Mapping):
        raise CampaignConfigError(f"{label} must be a mapping")
    return source


def _sequence(
    source: object, label: str, *, allow_empty: bool = False,
) -> Sequence[object]:
    if not isinstance(source, list):
        raise CampaignConfigError(f"{label} must be a list")
    if not source and not allow_empty:
        raise CampaignConfigError(f"{label} must declare at least one entry")
    return source
