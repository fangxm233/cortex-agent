# input:  one frozen credential capability key per trial
# output: the single adapter that carries it, or a start-time refusal
# pos:    Provider adapter registry and selection
# >>> If I am updated, update my header and folder CORTEX.md <<<

from types import MappingProxyType
from typing import TYPE_CHECKING, Callable, Mapping

from ..models import PROXY_SCHEMA_VERSION
from .anthropic import AnthropicMessagesApiKeyAdapter
from .base import (
    AdapterUnavailable,
    AdapterVersionMismatch,
    AuthInjectionUnavailable,
    Billable,
    BodyDecision,
    ProviderAdapter,
    RouteDecision,
)
from .openai_codex_responses import OpenAICodexResponsesOAuthAdapter

if TYPE_CHECKING:
    from ..launcher.credential_capabilities import CredentialCapabilityKey

UNKNOWN_MEMBER = "??"

AdapterFactory = Callable[[str | None, str | None, str | None], ProviderAdapter]

ADAPTER_REGISTRY: Mapping[tuple[str, ...], AdapterFactory] = MappingProxyType({
    ("claude", "anthropic", "anthropic-messages", "api-key-bearer", PROXY_SCHEMA_VERSION):
        AnthropicMessagesApiKeyAdapter,
    ("pi", "openai-codex", "openai-codex-responses", "oauth", PROXY_SCHEMA_VERSION):
        OpenAICodexResponsesOAuthAdapter,
})

__all__ = [
    "ADAPTER_REGISTRY",
    "UNKNOWN_MEMBER",
    "AdapterUnavailable",
    "AdapterVersionMismatch",
    "AuthInjectionUnavailable",
    "Billable",
    "BodyDecision",
    "OpenAICodexResponsesOAuthAdapter",
    "ProviderAdapter",
    "RouteDecision",
    "select_adapter",
]


def select_adapter(
    key: "CredentialCapabilityKey", *, upstream_base_url: str | None = None,
    credential: str | None = None, frozen_model: str | None = None,
) -> ProviderAdapter:
    members = (
        key.runner_or_backend, key.provider, key.protocol,
        key.credential_kind, key.proxy_adapter_version,
    )
    if UNKNOWN_MEMBER in members:
        raise AdapterUnavailable(
            f"capability key {members} has an unfilled {UNKNOWN_MEMBER} member; "
            "fill it from the installed package registry before starting a proxy")
    if key.proxy_adapter_version != PROXY_SCHEMA_VERSION:
        raise AdapterVersionMismatch(
            f"capability key declares {key.proxy_adapter_version}; "
            f"this proxy is {PROXY_SCHEMA_VERSION}")
    factory = ADAPTER_REGISTRY.get(members)
    if factory is None:
        raise AdapterUnavailable(
            f"no provider adapter for capability key {members}; "
            f"adapted keys: {sorted(ADAPTER_REGISTRY)}")
    adapter = factory(upstream_base_url, credential, frozen_model)
    if adapter.schema_version != key.proxy_adapter_version:
        raise AdapterVersionMismatch(
            f"adapter {adapter.adapter_id} is {adapter.schema_version}; "
            f"capability key declares {key.proxy_adapter_version}")
    return adapter
