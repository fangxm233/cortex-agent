# input:  the arm's capability key and limits, a host proxy spec, and the trial's roots
# output: an armed per-trial route, its credential block, its artifact sources and its revoke
# pos:    Production start and revoke boundary for the credential proxy
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The launcher arms the route before the container exists, so it arms the provisional bound `P`
# (lease_bound.py) and never a container-derived instant: the trial's own absolute deadline is
# compiled inside the container, on the container's clock, and does not exist yet at this point.
# The container shortens the lease later by echoing back a duration.

import json
import os
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from ..proxy.adapters import ProviderAdapter, select_adapter
from ..proxy.export import render_proxy_export
from ..proxy.lease import LeaseTerms
from ..proxy.models import PROXY_SCHEMA_VERSION, ProxyBudget
from ..proxy.server import TrialProxyHandle, host_now_ms, start_trial_proxy
from ..scan.models import ArtifactInventory
from .credential_capabilities import (
    CAPABILITY_REGISTRY,
    CredentialCapabilityKey,
    capability_key_for,
)
from .lease_bound import TEARDOWN_GRACE_MS, provisional_lease_bound_ms

PROXY_AUDIT_LOG_SOURCE = "proxy_audit_log"
PROXY_EXPORT_SOURCE = "proxy_export"
LEASE_ECHO_RECORD_SOURCE = "lease_echo_record"
ADAPTER_SELECTION_RECORD_SOURCE = "adapter_selection_record"
# The proxy manifest block deliberately gets no source name of its own: it lives inside the
# manifest source the scanner already pins.
PROXY_ARTIFACT_SOURCES = (
    PROXY_AUDIT_LOG_SOURCE, PROXY_EXPORT_SOURCE, LEASE_ECHO_RECORD_SOURCE,
    ADAPTER_SELECTION_RECORD_SOURCE,
)

AUDIT_LOG_FILENAME = "proxy-audit.jsonl"
EXPORT_FILENAME = "proxy-export.json"
LEASE_ECHO_FILENAME = "lease-echo.json"
ADAPTER_SELECTION_FILENAME = "adapter-selection.json"
ADAPTER_SELECTION_SCHEMA_VERSION = "cortex-bench-adapter-selection/1"
LEASE_ECHO_RECORD_SCHEMA_VERSION = "cortex-bench-lease-echo-record/1"

SPEC_FIELDS = frozenset({
    "credential_env", "bound_source_ip", "max_request_cost_usd",
    "input_cost_per_million_usd", "output_cost_per_million_usd",
})


@dataclass(frozen=True)
class TrialProxySpec:
    """The host facts a trial needs to arm its route.

    Non-secret by construction: the credential is *named*, never carried, so this value may travel
    through a Harbor agent configuration without putting a provider credential in one.
    """

    credential_env: str
    bound_source_ip: str
    max_request_cost_usd: Decimal
    input_cost_per_million_usd: Decimal
    output_cost_per_million_usd: Decimal


def parse_trial_proxy_spec(source: Mapping[str, object]) -> TrialProxySpec:
    rejected = sorted(set(source) - SPEC_FIELDS)
    if rejected:
        raise ValueError(f"trial proxy spec rejects fields {rejected}")
    missing = sorted(SPEC_FIELDS - set(source))
    if missing:
        raise ValueError(f"trial proxy spec requires fields {missing}")
    return TrialProxySpec(
        credential_env=_text(source, "credential_env"),
        bound_source_ip=_text(source, "bound_source_ip"),
        max_request_cost_usd=_decimal(source, "max_request_cost_usd"),
        input_cost_per_million_usd=_decimal(source, "input_cost_per_million_usd"),
        output_cost_per_million_usd=_decimal(source, "output_cost_per_million_usd"),
    )


@dataclass(frozen=True)
class TrialProxySession:
    """One armed trial route, with the host-side files it publishes."""

    handle: TrialProxyHandle
    upstream_base_url: str
    absolute_deadline: datetime
    provisional_bound_ms: int
    proxy_dir: Path

    @property
    def audit_log_path(self) -> Path:
        return self.proxy_dir / AUDIT_LOG_FILENAME

    @property
    def export_path(self) -> Path:
        return self.proxy_dir / EXPORT_FILENAME

    @property
    def lease_echo_path(self) -> Path:
        return self.proxy_dir / LEASE_ECHO_FILENAME

    @property
    def adapter_selection_path(self) -> Path:
        return self.proxy_dir / ADAPTER_SELECTION_FILENAME

    @property
    def artifact_sources(self) -> dict[str, Path]:
        return {
            PROXY_AUDIT_LOG_SOURCE: self.audit_log_path,
            PROXY_EXPORT_SOURCE: self.export_path,
            LEASE_ECHO_RECORD_SOURCE: self.lease_echo_path,
            ADAPTER_SELECTION_RECORD_SOURCE: self.adapter_selection_path,
        }

    def credential_block(self, seed_credential: Mapping[str, object]) -> dict[str, object]:
        """The four declared credential members: the two upstream-identity facts the caller knows,
        and the two only a live route can answer. The real credential is in neither."""
        declared = seed_credential.get("upstream_base_url")
        if declared != self.upstream_base_url:
            raise ValueError(
                f"trial seed names upstream {declared!r}; the armed route forwards to "
                f"{self.upstream_base_url!r}")
        return {
            "upstream_base_url": self.upstream_base_url,
            "route_identity_host": seed_credential["route_identity_host"],
            "proxy_base_url": self.handle.base_url,
            # A handle, not the provider credential: the dummy token is the container-visible
            # surface by design and the real one never enters the document.
            "dummy_token_ref": self.handle.dummy_token,
        }

    def write_accounting(self) -> tuple[Path, Path]:
        """Publish what the proxy observed, while its registers are still alive.

        Read order matters: the live counters go with the process, so both documents are written
        before the route is stopped.
        """
        lease_echo = self.handle.lease_echo_record
        export = self.handle.accounting_export
        _write_json(self.lease_echo_path, {
            "schema_version": LEASE_ECHO_RECORD_SCHEMA_VERSION,
            "trial_id": self.handle.trial_id,
            "lease_echo": lease_echo,
        })
        self.export_path.write_text(render_proxy_export(export), encoding="utf-8")
        return self.export_path, self.lease_echo_path


@dataclass(frozen=True)
class TrialRevocation:
    inventory: object
    export_path: Path
    lease_echo_path: Path


class CapabilityStateRefused(Exception):
    """A route was asked for on behalf of a capability row no authority admits."""


def _admitted_capability_key(capability_id: str) -> CredentialCapabilityKey:
    """The key an admitted row names, or a refusal.

    The registry is host-authoritative and is readable right here, while the compiler that enforces
    the same state reads only a projection of it and does not run until the container exists. So a
    launcher that armed on the id alone would open a real-credential route for a row the compiler
    goes on to refuse.
    """
    key = capability_key_for(capability_id)
    state = CAPABILITY_REGISTRY[key].state
    if state == "unsupported":
        raise CapabilityStateRefused(
            f"credential capability {capability_id!r} is {state}; a route is never armed for a "
            "capability row no authority admits")
    return key


def arm_trial_proxy(
    *, arm: Mapping[str, object], trial_id: str, upstream_base_url: str,
    spec: TrialProxySpec, proxy_dir: Path, trial_roots: Sequence[Path],
    environ: Mapping[str, str] | None = None,
    now_ms: Callable[[], int] = host_now_ms,
) -> TrialProxySession:
    """Arm the trial's credential route. Called before the container is created."""
    _require_contained(proxy_dir, trial_roots)
    capability_id = _text(arm, "credential_capability")
    # Before the credential is read, so a refused row never loads one.
    key = _admitted_capability_key(capability_id)
    credential = _host_credential(spec.credential_env, environ)
    # Selection is by exact capability key, and an unadapted route is never opened: this refusal
    # happens before anything is started or written.
    adapter = select_adapter(
        key, upstream_base_url=upstream_base_url, credential=credential,
        frozen_model=_text(arm, "model"),
    )
    budget_ms = _deadline_budget_ms(arm)
    bound_ms = provisional_lease_bound_ms(now_ms(), budget_ms)
    absolute_deadline = _epoch_datetime(bound_ms)
    handle = start_trial_proxy(
        trial_id=trial_id, upstream_base_url=upstream_base_url, adapter=adapter,
        bound_source_ip=spec.bound_source_ip,
        absolute_deadline=absolute_deadline,
        budget=_budget(arm, spec), log_path=proxy_dir / AUDIT_LOG_FILENAME,
        lease_terms=LeaseTerms(budget_ms=budget_ms, teardown_grace_ms=TEARDOWN_GRACE_MS),
        now_ms=now_ms,
    )
    session = TrialProxySession(
        handle=handle, upstream_base_url=upstream_base_url,
        absolute_deadline=absolute_deadline, provisional_bound_ms=bound_ms,
        proxy_dir=proxy_dir,
    )
    try:
        _write_json(session.adapter_selection_path, _adapter_selection_record(
            trial_id, adapter, capability_id, key))
    except BaseException:
        handle.stop()
        raise
    return session


def revoke_trial_proxy(
    session: TrialProxySession, *, capture_inventory: Callable[[], object],
) -> TrialRevocation:
    """The finally-ordered revoke: inventory capture, then the proxy export, then the stop.

    A stop that cannot prove its handlers are gone raises, and that failure is the trial's — it is
    never swallowed by the cleanup it happens to sit in. The reverse never happens either: an
    accounting write that fails takes the route down with it, because a live credential-injecting
    route is the worse of the two outcomes.
    """
    try:
        inventory = capture_inventory()
        export_path, lease_echo_path = session.write_accounting()
    finally:
        session.handle.stop()
    return TrialRevocation(inventory, export_path, lease_echo_path)


def capture_trial_inventory(
    *, sources: Mapping[str, Path], session: TrialProxySession | None,
    trial_roots: Sequence[Path],
) -> ArtifactInventory:
    """The inventory the launcher owns, with the proxy's host-side files declared **expected**, so
    that a missing one fails the scan instead of reading as a clean trial."""
    declared = dict(sources)
    if session is not None:
        declared.update(session.artifact_sources)
    return ArtifactInventory(declared, frozenset(declared), tuple(trial_roots))


def _adapter_selection_record(
    trial_id: str, adapter: ProviderAdapter, capability_id: str,
    key: CredentialCapabilityKey,
) -> dict[str, object]:
    """Which adapter carried this trial. Without it a capability row's evidence cannot be
    attributed to a key tuple."""
    return {
        "schema_version": ADAPTER_SELECTION_SCHEMA_VERSION,
        "trial_id": trial_id,
        "adapter_id": adapter.adapter_id,
        "capability_id": capability_id,
        "capability_key": asdict(key),
        "upstream_hosts": list(adapter.upstream_hosts),
        "proxy_schema_version": PROXY_SCHEMA_VERSION,
    }


def _host_credential(name: str, environ: Mapping[str, str] | None) -> str:
    values = os.environ if environ is None else environ
    credential = values.get(name)
    if not credential:
        raise ValueError(f"host credential {name} is not set")
    return credential


def _require_contained(proxy_dir: Path, trial_roots: Sequence[Path]) -> None:
    # The scanner refuses an inventory whose source escapes every trial root, so a proxy file
    # written outside one is a ValueError at scan time instead of a finding.
    if not trial_roots:
        raise ValueError("arming a trial proxy requires a trial root")
    absolute = Path(os.path.abspath(proxy_dir))
    roots = [Path(os.path.abspath(root)) for root in trial_roots]
    if not any(absolute.is_relative_to(root) for root in roots):
        raise ValueError(
            f"proxy artifacts must be written under a trial root; {proxy_dir} is under none")


def _budget(arm: Mapping[str, object], spec: TrialProxySpec) -> ProxyBudget:
    return ProxyBudget(
        max_cost_usd=_decimal(_limits(arm), "max_cost_usd"),
        max_request_cost_usd=spec.max_request_cost_usd,
        input_cost_per_million_usd=spec.input_cost_per_million_usd,
        output_cost_per_million_usd=spec.output_cost_per_million_usd,
    )


def _deadline_budget_ms(arm: Mapping[str, object]) -> int:
    seconds = _limits(arm).get("deadline_seconds")
    if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
        raise ValueError("arm limits require a positive deadline_seconds")
    return seconds * 1000


def _limits(arm: Mapping[str, object]) -> Mapping[str, object]:
    limits = arm.get("limits")
    if not isinstance(limits, Mapping):
        raise ValueError("arm requires limits")
    return limits


def _epoch_datetime(epoch_ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=epoch_ms)


def _text(values: Mapping[str, Any], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _decimal(values: Mapping[str, Any], key: str) -> Decimal:
    value = values.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a decimal string")
    try:
        return Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f"{key} must be a decimal string") from error


def _write_json(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
