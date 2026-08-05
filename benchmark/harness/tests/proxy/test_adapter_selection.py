# input:  credential capability keys and the frozen adapter registry
# output: exact-match, refusal, and version-refusal proofs for selection
# pos:    Adapter selection contract tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import pytest

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
