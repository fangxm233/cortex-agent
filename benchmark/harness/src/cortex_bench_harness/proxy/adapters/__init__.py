# input:  one frozen credential capability key per trial
# output: the single adapter that carries it, or a start-time refusal
# pos:    Provider adapter registry and selection
# >>> If I am updated, update my header and folder CORTEX.md <<<

from types import MappingProxyType
from typing import TYPE_CHECKING, Callable, Mapping

from ..models import PROXY_SCHEMA_VERSION
from .anthropic import (
    AnthropicMessagesApiKeyAdapter,
    AnthropicMessagesSubscriptionOAuthAdapter,
)
from .base import (
    AdapterUnavailable,
    AdapterVersionMismatch,
    AuthInjectionUnavailable,
    BodyDecision,
    ProviderAdapter,
    RouteDecision,
)
from .deepseek_chat_completions import DeepSeekChatCompletionsApiKeyAdapter
from .openai_codex_responses import OpenAICodexResponsesOAuthAdapter

if TYPE_CHECKING:
    from ..launcher.credential_capabilities import CredentialCapabilityKey

UNKNOWN_MEMBER = "??"

AdapterFactory = Callable[..., ProviderAdapter]

ADAPTER_REGISTRY: Mapping[tuple[str, ...], AdapterFactory] = MappingProxyType({
    ("claude", "anthropic", "anthropic-messages", "api-key-bearer", PROXY_SCHEMA_VERSION):
        AnthropicMessagesApiKeyAdapter,
    ("claude-code", "anthropic", "anthropic-messages", "subscription-oauth",
     PROXY_SCHEMA_VERSION): AnthropicMessagesSubscriptionOAuthAdapter,
    ("pi", "deepseek", "openai-completions", "api-key", PROXY_SCHEMA_VERSION):
        DeepSeekChatCompletionsApiKeyAdapter,
    ("pi", "openai-codex", "openai-codex-responses", "oauth", PROXY_SCHEMA_VERSION):
        OpenAICodexResponsesOAuthAdapter,
    ("codex-cli", "openai-codex", "openai-codex-responses", "oauth",
     PROXY_SCHEMA_VERSION): OpenAICodexResponsesOAuthAdapter,
})

# The adapters whose protocol carries a request-side completion cap, and which therefore take the
# trial's frozen cap. It is declared here rather than discovered by reflection, so which rows bind
# a cap is one readable fact. A row that is not listed enforces its output bound elsewhere — the
# cap is dropped at selection rather than silently rewritten into a protocol that has no field
# for it.
CAP_BINDING_ADAPTERS: frozenset[AdapterFactory] = frozenset({
    DeepSeekChatCompletionsApiKeyAdapter,
})
EXPIRY_BINDING_ADAPTERS: frozenset[AdapterFactory] = frozenset({
    OpenAICodexResponsesOAuthAdapter,
})
EXPIRY_VALIDATION_KEYS = frozenset({
    ("codex-cli", "openai-codex", "openai-codex-responses", "oauth", PROXY_SCHEMA_VERSION),
})

__all__ = [
    "ADAPTER_REGISTRY",
    "CAP_BINDING_ADAPTERS",
    "EXPIRY_BINDING_ADAPTERS",
    "UNKNOWN_MEMBER",
    "AdapterUnavailable",
    "AdapterVersionMismatch",
    "AuthInjectionUnavailable",
    "BodyDecision",
    "AnthropicMessagesSubscriptionOAuthAdapter",
    "DeepSeekChatCompletionsApiKeyAdapter",
    "OpenAICodexResponsesOAuthAdapter",
    "ProviderAdapter",
    "RouteDecision",
    "select_adapter",
]


def select_adapter(
    key: "CredentialCapabilityKey", *, upstream_base_url: str | None = None,
    credential: str | None = None, frozen_model: str | None = None,
    frozen_completion_cap: int | None = None, access_expires_at_ms: int | None = None,
) -> ProviderAdapter:
    members = (
        key.runner_or_backend, key.provider, key.protocol, key.credential_kind,
        key.proxy_adapter_version,
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
    adapter = _construct_adapter(
        factory, members, upstream_base_url, credential, frozen_model,
        frozen_completion_cap, access_expires_at_ms,
    )
    if adapter.schema_version != key.proxy_adapter_version:
        raise AdapterVersionMismatch(
            f"adapter {adapter.adapter_id} is {adapter.schema_version}; "
            f"capability key declares {key.proxy_adapter_version}")
    return adapter


def _construct_adapter(
    factory: AdapterFactory, members: tuple[str, ...], upstream_base_url: str | None,
    credential: str | None, frozen_model: str | None,
    frozen_completion_cap: int | None, access_expires_at_ms: int | None,
) -> ProviderAdapter:
    bindings: dict[str, object] = {}
    if factory in CAP_BINDING_ADAPTERS:
        bindings["frozen_completion_cap"] = frozen_completion_cap
    if factory in EXPIRY_BINDING_ADAPTERS:
        bindings["access_expires_at_ms"] = access_expires_at_ms
    if members in EXPIRY_VALIDATION_KEYS and (
        credential is not None or access_expires_at_ms is not None
    ):
        bindings["validate_access_expiry"] = True
    return factory(upstream_base_url, credential, frozen_model, **bindings)
