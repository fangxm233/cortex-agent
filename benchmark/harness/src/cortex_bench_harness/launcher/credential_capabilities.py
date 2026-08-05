# input:  fixed provider protocol capability declarations
# output: host registry and non-secret compiler projection
# pos:    Host-authoritative credential capability registry
# >>> If I am updated, update my header and folder CORTEX.md <<<

from dataclasses import asdict, dataclass
from types import MappingProxyType
from typing import Literal, Mapping

from ..proxy.models import PROXY_SCHEMA_VERSION

CAPABILITY_STATES = frozenset({
    "unsupported", "offline-contract-passed", "live-handshake-passed",
})
CapabilityState = Literal[
    "unsupported", "offline-contract-passed", "live-handshake-passed",
]


@dataclass(frozen=True)
class CredentialCapabilityKey:
    runner_or_backend: str
    provider: str
    protocol: str
    credential_kind: str
    proxy_adapter_version: str = PROXY_SCHEMA_VERSION


@dataclass(frozen=True)
class CredentialCapability:
    id: str
    state: CapabilityState


def _key(
    runner: str,
    provider: str,
    protocol: str,
    credential_kind: str,
) -> CredentialCapabilityKey:
    return CredentialCapabilityKey(runner, provider, protocol, credential_kind)


CAPABILITY_REGISTRY: Mapping[CredentialCapabilityKey, CredentialCapability] = MappingProxyType({
    # The only row proven under proxy schema /2. It was lowered to `unsupported` when the schema
    # bump re-keyed every row, because evidence gathered under the previous version does not carry
    # across it, and restored only after each of the adapter-seam paths it rests on — selection,
    # the route/body/auth/usage/limit failure branches, the offline containment properties and the
    # upstream-host rules — was shown to have a test that FAILS when the behaviour is removed.
    # That is the bar: 24 mutations, 24 killed. Five of them survived on the first pass and were
    # real gaps, so this state is not a formality and must not be carried across the next bump.
    # `offline-contract-passed` means the boundary holds against a synthetic upstream. It does NOT
    # authorise a paid run — see the arming-point note in trial_proxy.py.
    _key("claude", "anthropic", "anthropic-messages", "api-key-bearer"):
        CredentialCapability("claude-api-key", "offline-contract-passed"),
    _key("claude", "anthropic", "anthropic-messages", "subscription-oauth"):
        CredentialCapability("claude-subscription", "unsupported"),
    _key("pi", "??", "??", "api-key"):
        CredentialCapability("pi-api-key", "unsupported"),
    # This `??` is no longer the interlock it once was: the arming point now refuses an
    # unadmitted row outright, before it reads a credential, so this row fails closed by
    # mechanism rather than by an unfilled member. The protocol's value IS established from the
    # installed package's own registry and filling it is a fact-recording act, not a raise —
    # the row stays `unsupported` on grounds no member can fix: nothing writes the transport
    # pin the client needs, the second-host egress proof is Gate 10's, and revocation does not
    # reach the token-host leg.
    _key("pi", "openai-codex", "??", "oauth"):
        CredentialCapability("pi-openai-codex-oauth", "unsupported"),
    _key("codex-cli", "openai", "??", "subscription"):
        CredentialCapability("codex-subscription", "unsupported"),
})


def capability_key_for(capability_id: str) -> CredentialCapabilityKey:
    """The key an arm's `credential_capability` id names.

    Adapter selection is by exact key; the id is only how an arm points at one. An id no row
    declares is a refusal, because a trial may not run on a capability the host never registered.
    """
    matches = [
        key for key, capability in CAPABILITY_REGISTRY.items()
        if capability.id == capability_id
    ]
    if len(matches) != 1:
        raise LookupError(f"no credential capability is registered as {capability_id!r}")
    return matches[0]


def _project_row(
    key: CredentialCapabilityKey,
    capability: CredentialCapability,
) -> dict[str, object]:
    return {"id": capability.id, "state": capability.state, "key": asdict(key)}


def project_credential_capabilities() -> list[dict[str, object]]:
    rows = sorted(CAPABILITY_REGISTRY.items(), key=lambda item: item[1].id)
    return [_project_row(key, capability) for key, capability in rows]
