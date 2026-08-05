# input:  credential capability keys and the frozen adapter registry
# output: exact-match, refusal, and version-refusal proofs for selection
# pos:    Adapter selection contract tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

from types import MappingProxyType

import pytest

import cortex_bench_harness.proxy.adapters as adapters
from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey
from cortex_bench_harness.proxy.adapters import (
    ADAPTER_REGISTRY,
    UNKNOWN_MEMBER,
    AdapterUnavailable,
    AdapterVersionMismatch,
    select_adapter,
)
from cortex_bench_harness.proxy.adapters.anthropic import AnthropicMessagesApiKeyAdapter
from cortex_bench_harness.proxy.models import PROXY_SCHEMA_VERSION

ROW_ONE = CredentialCapabilityKey(
    "claude", "anthropic", "anthropic-messages", "api-key-bearer",
)
SKEWED_VERSION = "cortex-bench-trial-proxy/999"


class VersionSkewedAdapter:
    """An adapter whose own `schema_version` disagrees with the key that selected it.

    No registered adapter disagrees, so the disagreement has to be constructed to be
    observed at all.
    """

    adapter_id = "version-skewed/stub"
    schema_version = SKEWED_VERSION
    upstream_hosts: tuple[str, ...] = ()

    def __init__(
        self, upstream_base_url: str | None = None, credential: str | None = None,
        frozen_model: str | None = None,
    ) -> None:
        self.frozen_model = frozen_model


def test_selects_row_one_adapter_for_the_exact_key() -> None:
    adapter = select_adapter(ROW_ONE)
    assert isinstance(adapter, AnthropicMessagesApiKeyAdapter)
    assert adapter.adapter_id == "anthropic-messages/api-key-bearer"
    assert adapter.schema_version == PROXY_SCHEMA_VERSION


def test_unregistered_key_raises_instead_of_falling_back() -> None:
    key = CredentialCapabilityKey(
        "claude", "anthropic", "anthropic-messages", "subscription-oauth",
    )
    with pytest.raises(AdapterUnavailable):
        select_adapter(key)


@pytest.mark.parametrize(
    "key",
    [
        CredentialCapabilityKey("claude", "anthropic", "anthropic-messages", "api-key"),
        CredentialCapabilityKey("claude", "anthropic", "anthropic-messages", "api-key-bearer-v2"),
        CredentialCapabilityKey("claude", "anthropic", "anthropic", "api-key-bearer"),
        CredentialCapabilityKey("claude-code", "anthropic", "anthropic-messages", "api-key-bearer"),
    ],
)
def test_partial_and_prefix_keys_never_match(key: CredentialCapabilityKey) -> None:
    with pytest.raises(AdapterUnavailable):
        select_adapter(key)


def test_unknown_member_key_never_matches() -> None:
    key = CredentialCapabilityKey("pi", UNKNOWN_MEMBER, UNKNOWN_MEMBER, "api-key")
    with pytest.raises(AdapterUnavailable):
        select_adapter(key)


def test_unknown_member_never_matches_even_beside_a_registered_row() -> None:
    key = CredentialCapabilityKey(
        "claude", "anthropic", UNKNOWN_MEMBER, "api-key-bearer",
    )
    with pytest.raises(AdapterUnavailable):
        select_adapter(key)


def test_the_unknown_member_guard_is_what_refuses_not_the_registry_miss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A `??` key also misses the registry, and that miss raises the same exception type
    # from a different branch — so `pytest.raises(AdapterUnavailable)` alone cannot say
    # which guard fired. Both halves below name the guard rather than the type.
    key = CredentialCapabilityKey(
        "claude", "anthropic", UNKNOWN_MEMBER, "api-key-bearer",
    )
    with pytest.raises(AdapterUnavailable) as refusal:
        select_adapter(key)
    assert f"unfilled {UNKNOWN_MEMBER} member" in str(refusal.value)
    assert "no provider adapter for capability key" not in str(refusal.value)

    members = (
        key.runner_or_backend, key.provider, key.protocol,
        key.credential_kind, key.proxy_adapter_version,
    )
    monkeypatch.setattr(adapters, "ADAPTER_REGISTRY", MappingProxyType({
        members: AnthropicMessagesApiKeyAdapter,
    }))
    with pytest.raises(AdapterUnavailable) as served:
        select_adapter(key)
    assert f"unfilled {UNKNOWN_MEMBER} member" in str(served.value)


def test_an_adapter_whose_own_schema_version_disagrees_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The key's version equals the running schema version, so the key-vs-constant check
    # cannot fire; only the post-construction cross-check against the adapter's own
    # `schema_version` can, and the refusal names the adapter to prove which one did.
    members = (
        ROW_ONE.runner_or_backend, ROW_ONE.provider, ROW_ONE.protocol,
        ROW_ONE.credential_kind, PROXY_SCHEMA_VERSION,
    )
    monkeypatch.setattr(adapters, "ADAPTER_REGISTRY", MappingProxyType({
        members: VersionSkewedAdapter,
    }))
    with pytest.raises(AdapterVersionMismatch) as refusal:
        select_adapter(ROW_ONE)
    assert VersionSkewedAdapter.adapter_id in str(refusal.value)
    assert SKEWED_VERSION in str(refusal.value)


def test_version_mismatch_is_a_start_time_refusal() -> None:
    key = CredentialCapabilityKey(
        "claude", "anthropic", "anthropic-messages", "api-key-bearer",
        "cortex-bench-trial-proxy/1",
    )
    with pytest.raises(AdapterVersionMismatch):
        select_adapter(key)


def test_registry_declares_no_unknown_member_and_one_schema_version() -> None:
    for members in ADAPTER_REGISTRY:
        assert UNKNOWN_MEMBER not in members
        assert members[4] == PROXY_SCHEMA_VERSION


def test_selection_binds_the_frozen_upstream_credential_and_model() -> None:
    adapter = select_adapter(
        ROW_ONE, upstream_base_url="http://127.0.0.1:9000",
        credential="synthetic-key", frozen_model="claude-synthetic-1",
    )
    assert adapter.upstream_hosts == ("127.0.0.1",)
    assert adapter.validate_body(
        "messages_beta", b'{"model":"claude-synthetic-1"}').allow is True


def test_unbound_adapter_declares_no_upstream_host() -> None:
    assert select_adapter(ROW_ONE).upstream_hosts == ()
