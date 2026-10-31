from collections.abc import Mapping
from typing import Any

from .deepseek_upstream import DeepSeekUpstream
from .host_credential_vault import HOST_CREDENTIAL_VAULT
from .trial_admission import create_harbor_trial

BUNDLE = "direct-pi-deepseek"
CAPABILITY_ID = "pi-deepseek-api-key"
MODEL = "deepseek-v4-flash"
MAX_OUTPUT_TOKENS = 256
REQUEST_LIMIT_BYTES = 64 * 1024
RESPONSE_LIMIT_BYTES = 1024 * 1024
CREDENTIAL_TTL_SECONDS = 30.0


async def run_deepseek_paid_smoke(
    *, upstream: DeepSeekUpstream, trial_kwargs: Mapping[str, object],
) -> object:
    """The one paid request, sent by the trial proxy to `upstream` with its credential."""
    values = dict(trial_kwargs)
    _validate_contract(values, upstream.base_url)
    handle = HOST_CREDENTIAL_VAULT.store(
        upstream.credential, ttl_seconds=CREDENTIAL_TTL_SECONDS,
    )
    try:
        trial = await create_harbor_trial(**values, credential_handle=handle)
        return await trial.run()
    finally:
        HOST_CREDENTIAL_VAULT.purge(handle)


def _validate_contract(values: Mapping[str, object], upstream: str) -> None:
    arm = _mapping(values, "arm")
    seed = _mapping(values, "trial_seed")
    proxy = _mapping(values, "trial_proxy")
    limits = _mapping(arm, "limits")
    exact = {
        "kind": "cortex", "bundle": BUNDLE, "backend": "pi", "provider": "deepseek",
        "model": MODEL, "credential_capability": CAPABILITY_ID,
    }
    if any(arm.get(key) != value for key, value in exact.items()):
        raise ValueError("DeepSeek paid smoke contract identity differs")
    _validate_execution(arm, seed, limits)
    _validate_proxy(proxy, seed, upstream)


def _validate_execution(
    arm: Mapping[str, object], seed: Mapping[str, object],
    limits: Mapping[str, object],
) -> None:
    limits_exact = {
        "max_provider_requests": 1, "max_cost_usd": "0.05",
        "deadline_seconds": 120,
        # The completion cap is a declared per-trial limit rather than an adapter constant, so
        # this one-shot contract has to name the value it was approved for like any other run.
        "max_output_tokens": MAX_OUTPUT_TOKENS,
    }
    if any(limits.get(key) != value for key, value in limits_exact.items()):
        raise ValueError("DeepSeek paid smoke contract limits differ")
    if seed.get("paid_run") is not True or seed.get("arm") != arm:
        raise ValueError("DeepSeek paid smoke contract seed differs")


def _validate_proxy(
    proxy: Mapping[str, object], seed: Mapping[str, object], upstream: str,
) -> None:
    credential = _mapping(seed, "credential")
    exact = {
        "request_body_limit_bytes": REQUEST_LIMIT_BYTES,
        "response_body_limit_bytes": RESPONSE_LIMIT_BYTES,
    }
    if any(proxy.get(key) != value for key, value in exact.items()):
        raise ValueError("DeepSeek paid smoke contract proxy limits differ")
    # The proxy must forward to the upstream the credential belongs to.
    if credential.get("upstream_base_url") != upstream:
        raise ValueError("DeepSeek paid smoke contract upstream differs from the credential's")


def _mapping(values: object, key: str) -> Mapping[str, Any]:
    if not isinstance(values, Mapping):
        raise ValueError(f"DeepSeek paid smoke contract {key} must be a mapping")
    value = values.get(key)
    if not isinstance(value, Mapping):
        raise ValueError(f"DeepSeek paid smoke contract {key} must be a mapping")
    return value
