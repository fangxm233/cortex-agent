# input:  a capability id and, where the shipped key is incomplete, the member that fills it
# output: a test-local registry in which the named rows are admitted or refused
# pos:    Capability admission fixture
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The arming point refuses an unadmitted row, so without the admitting direction a test cannot
# reach the wiring behind the gate at all. The refusing direction exists for the mirror reason: a
# row's state is a determination that moves as evidence arrives, so a test that needs a refusal
# states it here rather than resting on whichever row happens to be unadmitted this week.
# It patches the two module namespaces that read the registry and never the registry object:
# raising a row is reserved to the gate that owns the raise checklist, and a test that mutated the
# shipped declaration would exercise a state no authority granted.

from dataclasses import replace
from types import MappingProxyType

import pytest

from cortex_bench_harness.launcher import credential_capabilities, trial_proxy
from cortex_bench_harness.launcher.credential_capabilities import (
    CAPABILITY_REGISTRY,
    CredentialCapability,
    CredentialCapabilityKey,
)

ADMITTED = "offline-contract-passed"
UNADMITTED = "unsupported"


def _install(monkeypatch: pytest.MonkeyPatch, rows: dict) -> None:
    registry = MappingProxyType(rows)
    monkeypatch.setattr(credential_capabilities, "CAPABILITY_REGISTRY", registry)
    monkeypatch.setattr(trial_proxy, "CAPABILITY_REGISTRY", registry)


def admit_capability(
    monkeypatch: pytest.MonkeyPatch, capability_id: str, *, protocol: str | None = None,
) -> CredentialCapabilityKey:
    """Admit one row for this test, optionally under a filled protocol member."""
    rows = dict(CAPABILITY_REGISTRY)
    key = next(key for key, row in rows.items() if row.id == capability_id)
    admitted = key if protocol is None else replace(key, protocol=protocol)
    del rows[key]
    rows[admitted] = CredentialCapability(capability_id, ADMITTED)
    _install(monkeypatch, rows)
    return admitted


def refuse_capability(
    monkeypatch: pytest.MonkeyPatch, capability_id: str,
) -> CredentialCapabilityKey:
    """Refuse one row for this test, leaving its key — and so adapter selection — untouched."""
    rows = dict(CAPABILITY_REGISTRY)
    key = next(key for key, row in rows.items() if row.id == capability_id)
    rows[key] = CredentialCapability(capability_id, UNADMITTED)
    _install(monkeypatch, rows)
    return key


def admit_every_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """Admit every row, so a test about adapter selection or wiring is not answered by the state
    gate before it reaches the behaviour it names."""
    _install(monkeypatch, {
        key: CredentialCapability(row.id, ADMITTED)
        for key, row in CAPABILITY_REGISTRY.items()
    })
