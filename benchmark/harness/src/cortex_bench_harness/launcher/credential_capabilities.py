# input:  fixed provider protocol capability declarations
# output: host registry and non-secret compiler projection
# pos:    Host-authoritative credential capability registry
# >>> If I am updated, update my header and folder CORTEX.md <<<

from dataclasses import asdict, dataclass
from pathlib import Path
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
    evidence_sha256: str | None = None


def _key(
    runner: str,
    provider: str,
    protocol: str,
    credential_kind: str,
) -> CredentialCapabilityKey:
    return CredentialCapabilityKey(runner, provider, protocol, credential_kind)


CODEX_CLI_CAPABILITY_KEY = _key(
    "codex-cli", "openai-codex", "openai-codex-responses", "oauth",
)


CAPABILITY_REGISTRY: Mapping[CredentialCapabilityKey, CredentialCapability] = MappingProxyType({
    # `offline-contract-passed` means only that a synthetic upstream observed the frozen contract.
    # It does not authorize a paid run; trial_proxy.py requires live evidence separately.
    _key("claude", "anthropic", "anthropic-messages", "api-key-bearer"):
        CredentialCapability("claude-api-key", "offline-contract-passed"),
    _key("claude-code", "anthropic", "anthropic-messages", "subscription-oauth"):
        CredentialCapability(
            "claude-subscription", "live-handshake-passed",
            "68c7c62cdd57e3ebc5fdeb395e57eab76fe228ad4c33f7c1633ad5c8c7794987",
        ),
    _key("pi", "??", "??", "api-key"):
        CredentialCapability("pi-api-key", "unsupported"),
    # Exact DeepSeek transport row, promoted only after one bounded production-PI handshake.
    _key("pi", "deepseek", "openai-completions", "api-key"):
        CredentialCapability(
            "pi-deepseek-api-key", "live-handshake-passed",
            "f11e82fd0efecfda60490de953f3af39833cda1adce0e2b87e0f078bafa289d5",
        ),
    # This `??` is no longer the interlock it once was: the arming point now refuses an
    # unadmitted row outright, before it reads a credential, so this row fails closed by
    # mechanism rather than by an unfilled member. The protocol's value IS established from the
    # installed package's own registry and filling it is a fact-recording act, not a raise —
    # the row stays `unsupported` on grounds no member can fix: nothing writes the transport
    # pin the client needs, the second-host egress proof is Gate 10's, and revocation does not
    # reach the token-host leg.
    _key("pi", "openai-codex", "??", "oauth"):
        CredentialCapability("pi-openai-codex-oauth", "unsupported"),
    CODEX_CLI_CAPABILITY_KEY:
        CredentialCapability(
            "codex-subscription", "offline-contract-passed",
            "a3969d3ee461145f126aacfd5ba73b329df360259ed4d2bc550d0fb4ad0e67e0",
        ),
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
    _validate_evidence_binding(key, capability)
    row: dict[str, object] = {
        "id": capability.id, "state": capability.state, "key": asdict(key),
    }
    if capability.evidence_sha256 is not None:
        row["evidence_sha256"] = capability.evidence_sha256
    return row


def _validate_evidence_binding(
    key: CredentialCapabilityKey, capability: CredentialCapability,
) -> None:
    from .capability_evidence import (
        CAPABILITY_EVIDENCE_METADATA,
        validate_capability_evidence,
        validate_offline_supporting_artifacts,
    )
    metadata = CAPABILITY_EVIDENCE_METADATA.get(capability.id)
    required = capability.state == "live-handshake-passed" or (
        capability.state == "offline-contract-passed" and metadata is not None
    )
    if not required:
        return
    if metadata is None:
        raise ValueError(f"credential capability {capability.id} has no evidence metadata")
    digest = capability.evidence_sha256
    if digest is None:
        raise ValueError(f"credential capability {capability.id} requires evidence")
    path = _evidence_path(capability.id, capability.state)
    document = validate_capability_evidence(
        path, digest,
        capability_id=capability.id, key=key, state=capability.state,
        adapter_id=metadata.adapter_id,
    )
    if capability.state == "offline-contract-passed":
        validate_offline_supporting_artifacts(path.parent, document)


def _evidence_path(capability_id: str, state: CapabilityState) -> Path:
    return Path(__file__).with_name("evidence") / f"{capability_id}.{state}.json"


def project_credential_capabilities() -> list[dict[str, object]]:
    rows = sorted(CAPABILITY_REGISTRY.items(), key=lambda item: item[1].id)
    return [_project_row(key, capability) for key, capability in rows]
