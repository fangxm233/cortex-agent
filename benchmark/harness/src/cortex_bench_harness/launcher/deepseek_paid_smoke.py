# input:  exact DeepSeek trial kwargs and aistatus gateway path
# output: one consume-once Harbor paid-smoke result
# pos:    Bounded DeepSeek paid-smoke launcher
# >>> If I am updated, update my header and folder CORTEX.md <<<

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml

from .host_credential_vault import HOST_CREDENTIAL_VAULT
from .trial_admission import create_harbor_trial

CAPABILITY_ID = "pi-deepseek-api-key"
MODEL = "deepseek-v4-flash"
UPSTREAM = "http://127.0.0.1:9880/m/deepseek/deepseek"
MAX_OUTPUT_TOKENS = 256
REQUEST_LIMIT_BYTES = 64 * 1024
RESPONSE_LIMIT_BYTES = 1024 * 1024
CREDENTIAL_TTL_SECONDS = 30.0


def load_deepseek_relay_credential(path: Path) -> str:
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    route = _mapping(_mapping(document, "deepseek"), "deepseek")
    keys = route.get("keys")
    if not isinstance(keys, list) or len(keys) != 1:
        raise ValueError("DeepSeek gateway route must carry exactly one key")
    credential = keys[0]
    if not isinstance(credential, str) or not credential:
        raise ValueError("DeepSeek gateway credential must be non-empty text")
    return credential


async def run_deepseek_paid_smoke(
    *, gateway_path: Path, trial_kwargs: Mapping[str, object],
) -> object:
    values = dict(trial_kwargs)
    _validate_contract(values)
    credential = load_deepseek_relay_credential(gateway_path)
    handle = HOST_CREDENTIAL_VAULT.store(
        credential, ttl_seconds=CREDENTIAL_TTL_SECONDS,
    )
    credential = ""
    try:
        trial = await create_harbor_trial(**values, credential_handle=handle)
        return await trial.run()
    finally:
        HOST_CREDENTIAL_VAULT.purge(handle)


def _validate_contract(values: Mapping[str, object]) -> None:
    arm = _mapping(values, "arm")
    seed = _mapping(values, "trial_seed")
    proxy = _mapping(values, "trial_proxy")
    limits = _mapping(arm, "limits")
    exact = {
        "kind": "cortex", "backend": "pi", "provider": "deepseek",
        "model": MODEL, "credential_capability": CAPABILITY_ID,
    }
    if any(arm.get(key) != value for key, value in exact.items()):
        raise ValueError("DeepSeek paid smoke contract identity differs")
    _validate_execution(arm, seed, limits)
    _validate_proxy(proxy, seed)


def _validate_execution(
    arm: Mapping[str, object], seed: Mapping[str, object],
    limits: Mapping[str, object],
) -> None:
    orchestration = _mapping(arm, "orchestration")
    exact = {
        "mode": "direct", "ask_manager": False,
    }
    if any(orchestration.get(key) != value for key, value in exact.items()):
        raise ValueError("DeepSeek paid smoke contract orchestration differs")
    limits_exact = {
        "max_provider_requests": 1, "max_thread_starts": 0,
        "max_resident_agent_processes": 1, "max_cost_usd": "0.05",
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
    proxy: Mapping[str, object], seed: Mapping[str, object],
) -> None:
    credential = _mapping(seed, "credential")
    exact = {
        "request_body_limit_bytes": REQUEST_LIMIT_BYTES,
        "response_body_limit_bytes": RESPONSE_LIMIT_BYTES,
        "max_request_cost_usd": "0.05",
    }
    if any(proxy.get(key) != value for key, value in exact.items()):
        raise ValueError("DeepSeek paid smoke contract proxy limits differ")
    if credential.get("upstream_base_url") != UPSTREAM:
        raise ValueError("DeepSeek paid smoke contract upstream differs")


def _mapping(values: object, key: str) -> Mapping[str, Any]:
    if not isinstance(values, Mapping):
        raise ValueError(f"DeepSeek paid smoke contract {key} must be a mapping")
    value = values.get(key)
    if not isinstance(value, Mapping):
        raise ValueError(f"DeepSeek paid smoke contract {key} must be a mapping")
    return value
