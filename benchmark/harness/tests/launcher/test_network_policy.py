# input:  declared network blocks and a stubbed resolver
# output: proof that a declaration becomes exactly the policy it names, or is refused
# pos:    Trial network access boundary tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import pytest
from harbor.models.task.config import NetworkMode

from cortex_bench_harness.launcher import network_policy
from cortex_bench_harness.launcher.network_policy import (
    DenylistEntry,
    NetworkAccess,
    NetworkAccessError,
    denied_categories,
    denylist_addresses,
    network_record,
    parse_network_access,
    resolve_denylist,
)

PROXY = "trial-one.proxy.invalid"


def test_absent_block_is_open_so_a_silent_campaign_reaches_the_internet() -> None:
    access = parse_network_access(None)

    assert access == NetworkAccess(mode="open")
    assert access.startup_policy().network_mode is NetworkMode.PUBLIC
    assert access.effective_policy(PROXY).network_mode is NetworkMode.PUBLIC


def test_open_builds_no_sidecar_because_both_policies_are_public() -> None:
    # `_requires_egress_control` is "any policy is not PUBLIC", so both being PUBLIC is the whole
    # mechanism by which no egress sidecar is constructed.
    access = parse_network_access({"mode": "open"})

    assert access.startup_policy().network_mode is NetworkMode.PUBLIC
    assert access.effective_policy(PROXY).network_mode is NetworkMode.PUBLIC


def test_filtered_starts_denied_and_widens_to_the_allowlist_plus_the_proxy() -> None:
    access = parse_network_access({"mode": "filtered", "allowlist": ["example.com"]})

    startup = access.startup_policy()
    assert (startup.network_mode, startup.allowed_hosts) == (NetworkMode.ALLOWLIST, [])
    effective = access.effective_policy(PROXY)
    assert effective.allowed_hosts == ["example.com", PROXY]


def test_the_proxy_host_is_added_once_even_if_the_campaign_declares_it() -> None:
    access = parse_network_access({"mode": "filtered", "allowlist": [PROXY, "example.com"]})

    assert access.effective_policy(PROXY).allowed_hosts == ["example.com", PROXY]


def test_a_denylist_only_campaign_leaves_gost_open_and_relies_on_the_address_set() -> None:
    access = parse_network_access({"mode": "filtered", "denylist": ["example.com"]})

    # The sidecar is still built (startup is a non-PUBLIC policy) so there is a namespace to hold
    # the denylist table, but gost itself is told to stop filtering.
    assert access.startup_policy().network_mode is NetworkMode.ALLOWLIST
    assert access.effective_policy(PROXY).network_mode is NetworkMode.PUBLIC


def test_open_refuses_a_declared_list_rather_than_ignoring_it() -> None:
    for field in ("allowlist", "denylist"):
        with pytest.raises(NetworkAccessError, match="enforces nothing"):
            parse_network_access({"mode": "open", field: ["example.com"]})


def test_filtered_refuses_to_be_empty_because_it_would_deny_the_credential_route() -> None:
    with pytest.raises(NetworkAccessError, match="must declare an allowlist"):
        parse_network_access({"mode": "filtered"})


def test_unknown_fields_and_modes_are_refused() -> None:
    with pytest.raises(NetworkAccessError, match="unknown field"):
        parse_network_access({"mode": "open", "allow": []})
    with pytest.raises(NetworkAccessError, match="mode must be one of"):
        parse_network_access({"mode": "permissive"})
    with pytest.raises(NetworkAccessError, match="mode must be one of"):
        parse_network_access({})


@pytest.mark.parametrize("entry", [
    "https://example.com", "example.com:443", "example.com/path", "",
])
def test_entry_shapes_harbor_would_refuse_are_refused_here(entry: str) -> None:
    with pytest.raises(NetworkAccessError, match="allowlist is invalid"):
        parse_network_access({"mode": "filtered", "allowlist": [entry]})


def test_metadata_addresses_are_refused_in_either_list() -> None:
    for field in ("allowlist", "denylist"):
        with pytest.raises(NetworkAccessError, match="instance metadata"):
            parse_network_access({"mode": "filtered", field: ["169.254.169.254"]})


def test_a_wildcard_denylist_entry_is_refused_rather_than_silently_unenforced() -> None:
    with pytest.raises(NetworkAccessError, match="wildcard"):
        parse_network_access({"mode": "filtered", "denylist": ["*.example.com"]})


def test_a_wildcard_allowlist_entry_is_accepted_because_gost_enforces_it() -> None:
    access = parse_network_access({"mode": "filtered", "allowlist": ["*.example.com"]})

    assert access.allowlist == ("*.example.com",)


def test_lists_must_be_lists_of_strings_and_may_not_repeat() -> None:
    with pytest.raises(NetworkAccessError, match="must be a list"):
        parse_network_access({"mode": "filtered", "allowlist": "example.com"})
    with pytest.raises(NetworkAccessError, match="must be strings"):
        parse_network_access({"mode": "filtered", "allowlist": [7]})
    with pytest.raises(NetworkAccessError, match="repeats"):
        parse_network_access({"mode": "filtered", "denylist": ["a.example.com", "a.example.com"]})


def test_literal_addresses_and_ranges_resolve_to_themselves_without_dns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(*args: object, **kwargs: object) -> object:
        raise AssertionError("a literal address must not be looked up")

    monkeypatch.setattr(network_policy.socket, "getaddrinfo", refuse)
    access = parse_network_access(
        {"mode": "filtered", "denylist": ["192.0.2.1", "198.51.100.0/24", "2001:db8::1"]})

    resolved = resolve_denylist(access)

    assert [entry.resolved for entry in resolved] == [
        ("192.0.2.1",), ("198.51.100.0/24",), ("2001:db8::1",)]
    assert denylist_addresses(resolved) == (["192.0.2.1", "198.51.100.0/24"], ["2001:db8::1"])


def test_a_hostname_is_snapshotted_to_every_address_it_answers_with(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(network_policy.socket, "getaddrinfo", lambda *a, **k: [
        (0, 0, 0, "", ("192.0.2.9", 0)),
        (0, 0, 0, "", ("192.0.2.8", 0)),
        (0, 0, 0, "", ("2001:db8::5", 0, 0, 0)),
    ])
    access = parse_network_access({"mode": "filtered", "denylist": ["example.com"]})

    resolved = resolve_denylist(access)

    assert resolved == (
        DenylistEntry(host="example.com", resolved=("192.0.2.8", "192.0.2.9", "2001:db8::5")),
    )
    assert denylist_addresses(resolved) == (["192.0.2.8", "192.0.2.9"], ["2001:db8::5"])


def test_a_name_that_does_not_resolve_is_kept_with_an_empty_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unresolvable(*args: object, **kwargs: object) -> object:
        raise network_policy.socket.gaierror("no such host")

    monkeypatch.setattr(network_policy.socket, "getaddrinfo", unresolvable)
    access = parse_network_access({"mode": "filtered", "denylist": ["nope.invalid"]})

    assert resolve_denylist(access) == (DenylistEntry(host="nope.invalid", resolved=()),)


def test_open_evidence_does_not_claim_the_public_network_is_denied() -> None:
    access = parse_network_access({"mode": "open"})
    record = network_record(
        access, access.startup_policy(), access.effective_policy(PROXY), ())

    assert record["mode"] == "open"
    assert record["default"] == "allow"
    assert "public-network" not in record["denied"]
    assert "arbitrary-egress" not in record["denied"]
    # Credential isolation does not depend on the network mode and is still claimed.
    assert "direct-provider" in record["denied"]
    assert record["denylist"]["enforcement"] == "none"


def test_filtered_evidence_states_the_denylist_caveat_in_the_document() -> None:
    access = parse_network_access(
        {"mode": "filtered", "allowlist": ["example.com"], "denylist": ["192.0.2.1"]})
    record = network_record(
        access, access.startup_policy(), access.effective_policy(PROXY),
        resolve_denylist(access))

    assert record["default"] == "deny"
    assert "public-network" in record["denied"]
    assert record["allowlist"]["declared"] == ["example.com"]
    assert record["denylist"]["entries"] == [{
        "host": "192.0.2.1", "resolved": ["192.0.2.1"],
        "enforcement": "best-effort-dns-snapshot",
    }]
    assert "DNS rotation" in record["denylist"]["caveat"]


def test_denied_categories_track_the_effective_policy_not_the_declaration() -> None:
    access = parse_network_access({"mode": "filtered", "denylist": ["192.0.2.1"]})

    # Declared `filtered`, but a denylist-only trial runs under PUBLIC, so the two egress
    # categories must not be claimed.
    assert "public-network" not in denied_categories(access.effective_policy(PROXY))
