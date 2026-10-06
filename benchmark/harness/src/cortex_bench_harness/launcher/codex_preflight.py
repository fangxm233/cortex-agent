#
# Whether the host's Codex OAuth login can carry a campaign's Codex trials, decided before any of
# them is armed. Which arms are Codex arms is not decided here: an arm names a credential
# capability, `require_capability_admission` admits it exactly as the trial path will, and an arm
# runs on the host's Codex token when its admitted key is one of the two Codex rows.
#
# What is left is the token's lifetime. A campaign that declares OAuth refresh material outlives
# any one access token, and its trials share one host-side holder so a rotated refresh token is
# the one every later refresh presents. A campaign that declares none is bounded by the access
# token it starts with, so each trial is checked against it at the moment it would be armed.

import os
from collections.abc import Mapping

from ..proxy.adapters.openai_codex_responses import (
    CodexTokenHolder,
    extract_access_expiry_ms,
)
from .credential_capabilities import (
    CODEX_CLI_CAPABILITY_KEY,
    PI_OPENAI_CODEX_CAPABILITY_KEY,
    capability_key_for,
)

CODEX_CAPABILITY_KEYS = frozenset({PI_OPENAI_CODEX_CAPABILITY_KEY, CODEX_CLI_CAPABILITY_KEY})
CLOCK_SKEW_MARGIN_MS = 60_000
REFRESH_FIELDS = ("refresh_credential_env", "token_endpoint_url", "oauth_client_id")


class CodexPreflightRefused(ValueError):
    """The host's Codex token cannot carry the campaign; nothing was armed."""


def runs_on_codex_token(arm: Mapping[str, object]) -> bool:
    """Whether an admitted arm's route injects the host's Codex OAuth token."""
    return capability_key_for(str(arm["credential_capability"])) in CODEX_CAPABILITY_KEYS


def can_refresh(proxy: Mapping[str, object]) -> bool:
    """Whether the campaign's routes can mint a new access token when this one expires."""
    return all(field in proxy for field in REFRESH_FIELDS)


def access_expiry_ms(
    proxy: Mapping[str, object], *, now_ms: int, environ: Mapping[str, str] | None = None,
) -> int:
    """The host access token's expiry, read from the token itself.

    Refused when the token is absent or unreadable, when it has already expired and nothing can
    refresh it, and when refresh is declared but the host does not hold the refresh token.
    """
    values = os.environ if environ is None else environ
    name = str(proxy["credential_env"])
    credential = values.get(name)
    if not credential:
        raise CodexPreflightRefused(f"host credential {name} is not set for Codex preflight")
    try:
        expiry_ms = extract_access_expiry_ms(credential)
    except ValueError as error:
        raise CodexPreflightRefused(
            f"Codex token expiry preflight refused the campaign: {error}") from error
    if can_refresh(proxy):
        _refresh_token(proxy, values)
    elif expiry_ms <= now_ms:
        raise CodexPreflightRefused(
            "Codex token is expired and this campaign declares no OAuth refresh material; "
            "no route was armed and no refresh was attempted")
    return expiry_ms


def trial_refusal(expires_at_ms: int, *, now_ms: int, window_ms: int) -> str | None:
    """Why a trial that cannot refresh may not start on this token, or None.

    The token has to outlive the trial's whole window -- network, setup, lease, teardown -- plus
    the clock skew between this host and the provider.
    """
    required_ms = now_ms + window_ms + CLOCK_SKEW_MARGIN_MS
    if expires_at_ms >= required_ms:
        return None
    return (
        "Codex access token expires in "
        f"{max(expires_at_ms - now_ms, 0) // 1000}s, which does not cover this trial's setup, "
        f"lease, teardown and clock skew ({(required_ms - now_ms) // 1000}s). Refresh the host "
        "token and re-run: this trial was not armed and spent nothing")


def shared_token_holder(
    proxy: Mapping[str, object], *, expires_at_ms: int,
    environ: Mapping[str, str] | None = None,
) -> CodexTokenHolder:
    """The one holder of the host login that every trial of a refreshing campaign uses."""
    values = os.environ if environ is None else environ
    return CodexTokenHolder(
        values[str(proxy["credential_env"])], access_expires_at_ms=expires_at_ms,
        refresh_token=_refresh_token(proxy, values),
        client_id=str(proxy["oauth_client_id"]),
        token_endpoint_url=str(proxy["token_endpoint_url"]),
    )


def _refresh_token(proxy: Mapping[str, object], environ: Mapping[str, str]) -> str:
    name = str(proxy["refresh_credential_env"])
    refresh = environ.get(name, "").strip()
    if not refresh:
        raise CodexPreflightRefused(
            f"Codex refresh credential {name} is not set on this host; unset the OAuth refresh "
            "fields or export the token")
    return refresh
