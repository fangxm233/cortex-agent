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
    _key("claude", "anthropic", "anthropic-messages", "api-key-bearer"):
        CredentialCapability("claude-api-key", "offline-contract-passed"),
    _key("claude", "anthropic", "anthropic-messages", "subscription-oauth"):
        CredentialCapability("claude-subscription", "unsupported"),
    _key("pi", "??", "??", "api-key"):
        CredentialCapability("pi-api-key", "unsupported"),
    _key("pi", "openai-codex", "??", "oauth"):
        CredentialCapability("pi-openai-codex-oauth", "unsupported"),
    _key("codex-cli", "openai", "??", "subscription"):
        CredentialCapability("codex-subscription", "unsupported"),
})


def _project_row(
    key: CredentialCapabilityKey,
    capability: CredentialCapability,
) -> dict[str, object]:
    return {"id": capability.id, "state": capability.state, "key": asdict(key)}


def project_credential_capabilities() -> list[dict[str, object]]:
    rows = sorted(CAPABILITY_REGISTRY.items(), key=lambda item: item[1].id)
    return [_project_row(key, capability) for key, capability in rows]
