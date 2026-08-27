# input:  a campaign that declares OAuth refresh material and a host that holds it
# output: proof the refresh token reaches the adapter and nothing else
# pos:    Codex OAuth refresh binding tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The Codex adapter has been able to refresh an access token since it was written. Nothing fed it
# the refresh material, so a Codex campaign was bounded by one access token's lifetime -- which is
# why the runner demanded that every pending Codex trial fit in a single concurrent wave, and why
# a 623-trial suite armed zero routes. These tests pin the seam that feeds it, and the two things
# the seam must not do: carry the secret in a value that travels to Harbor, or hand refresh
# material to an adapter that cannot use it.

import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.credential_capabilities import capability_key_for
from cortex_bench_harness.launcher.trial_proxy import (
    parse_trial_proxy_spec,
    arm_trial_proxy,
)
from cortex_bench_harness.proxy.adapters import AdapterUnavailable, select_adapter
from test_trial_proxy_wiring import (
    CREDENTIAL_ENV,
    TRIAL_ID,
    closed_upstream,
    codex_token,
    codex_vendor_arm,
    proxy_spec,
)

REFRESH_ENV = "CORTEX_BENCH_TEST_REFRESH"
REFRESH_TOKEN = "rt-synthetic-refresh-never-in-an-artifact"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
EXPIRY_MS = 1_900_000_000_000
REFRESH_FIELDS = {
    "refresh_credential_env": REFRESH_ENV,
    "token_endpoint_url": TOKEN_ENDPOINT,
    "oauth_client_id": CLIENT_ID,
}


def refreshing_spec(**overrides: object) -> dict[str, object]:
    return proxy_spec(
        access_expires_at_ms=EXPIRY_MS, **{**REFRESH_FIELDS, **overrides})


def arm(tmp_path: Path, spec: dict[str, object], environ: dict[str, str]):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    return arm_trial_proxy(
        arm=codex_vendor_arm(), trial_id=TRIAL_ID, upstream_base_url=closed_upstream(),
        spec=parse_trial_proxy_spec(spec), proxy_dir=artifacts / "proxy",
        trial_roots=(artifacts,), environ=environ, now_ms=lambda: 1_700_000_000_000,
    )


def host_environment() -> dict[str, str]:
    return {CREDENTIAL_ENV: codex_token(EXPIRY_MS), REFRESH_ENV: REFRESH_TOKEN}


def test_the_spec_names_the_refresh_token_and_never_carries_it() -> None:
    """This value travels to Harbor as an agent configuration, so it holds names, not secrets."""
    spec = parse_trial_proxy_spec(refreshing_spec())

    assert spec.can_refresh is True
    assert spec.refresh_credential_env == REFRESH_ENV
    assert REFRESH_TOKEN not in json.dumps(refreshing_spec())


def test_a_spec_with_no_refresh_material_still_parses(tmp_path: Path) -> None:
    assert parse_trial_proxy_spec(proxy_spec()).can_refresh is False


@pytest.mark.parametrize("dropped", sorted(REFRESH_FIELDS))
def test_two_of_the_three_refresh_fields_is_refused(dropped: str) -> None:
    """Two of three fails at the first expiry, hours into a run that already spent its envelope."""
    spec = {key: value for key, value in refreshing_spec().items() if key != dropped}

    with pytest.raises(ValueError, match="OAuth refresh requires all of"):
        parse_trial_proxy_spec(spec)


@pytest.mark.parametrize(
    "url", ["http://auth.openai.com/oauth/token", "https://auth.openai.com", "not-a-url"])
def test_a_token_endpoint_that_is_not_an_https_url_with_a_path_is_refused(url: str) -> None:
    with pytest.raises(ValueError, match="token_endpoint_url"):
        parse_trial_proxy_spec(refreshing_spec(token_endpoint_url=url))


def test_the_armed_route_holds_the_refresh_token_and_the_container_holds_a_dummy(
    tmp_path: Path,
) -> None:
    session = arm(tmp_path, refreshing_spec(), host_environment())
    try:
        dummy = session.handle.dummy_token
        selection = session.adapter_selection_path.read_text(encoding="utf-8")
    finally:
        session.handle.stop()

    assert dummy and REFRESH_TOKEN not in dummy
    # The adapter's own record of what it is says nothing about the secret it was handed.
    assert REFRESH_TOKEN not in selection


def test_a_declared_refresh_credential_the_host_does_not_hold_is_refused(
    tmp_path: Path,
) -> None:
    environ = {CREDENTIAL_ENV: codex_token(EXPIRY_MS)}

    with pytest.raises(ValueError, match=REFRESH_ENV):
        arm(tmp_path, refreshing_spec(), environ)


def test_an_adapter_that_cannot_refresh_is_never_handed_refresh_material() -> None:
    """Handing it over and having it ignored is the silent version of this failure."""
    key = capability_key_for("pi-deepseek-api-key")

    with pytest.raises(AdapterUnavailable, match="takes no refresh material"):
        select_adapter(
            key, upstream_base_url="http://127.0.0.1:9/x", credential="sk-test",
            frozen_model="deepseek-v4-flash", frozen_completion_cap=1024,
            refresh_token=REFRESH_TOKEN, client_id=CLIENT_ID,
            token_endpoint_url=TOKEN_ENDPOINT,
        )
