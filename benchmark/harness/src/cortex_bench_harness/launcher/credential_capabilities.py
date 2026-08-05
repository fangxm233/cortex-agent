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
    # Every row is `unsupported` under proxy schema /2. That is a determination, not a
    # placeholder. The claude/api-key row was LOWERED from `offline-contract-passed`, for two
    # reasons that are worth keeping next to the value: evidence gathered under a different
    # proxy schema version does not carry across the bump, which re-keyed all five rows; and
    # the adapter-seam paths (selection, the route/body/auth/usage/limit failure branches, the
    # offline containment properties and the upstream-host rules) have no evidence that their
    # tests fail when the behaviour is removed. The one test there that was checked that way
    # turned out to pass vacuously. Raising a row is reserved to the gate that owns the raise
    # checklist, and is an all-or-nothing act — a row is never raised on all-but-one.
    _key("claude", "anthropic", "anthropic-messages", "api-key-bearer"):
        CredentialCapability("claude-api-key", "unsupported"),
    _key("claude", "anthropic", "anthropic-messages", "subscription-oauth"):
        CredentialCapability("claude-subscription", "unsupported"),
    _key("pi", "??", "??", "api-key"):
        CredentialCapability("pi-api-key", "unsupported"),
    # DO NOT FILL THIS `??` YET, even though its value is now established from the installed
    # package's own registry. An adapter IS registered for the filled form of this key, and
    # nothing on the arming path consults `state` — so filling it would make a row declared
    # `unsupported` arm a live credential route. The `??` is currently the only thing holding
    # that shut, by accident rather than by design. Land a state check at the arming point
    # first; then fill this, and the interlock is a mechanism instead of a typo.
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
