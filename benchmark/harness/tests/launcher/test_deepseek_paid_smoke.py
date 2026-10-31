import asyncio
import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher import deepseek_paid_smoke
from cortex_bench_harness.launcher.deepseek_upstream import DeepSeekUpstream
from cortex_bench_harness.launcher.host_credential_vault import HOST_CREDENTIAL_VAULT

SECRET = "synthetic-relay-secret-UNIQUE"
RELAY = "https://relay.invalid"
UPSTREAM = DeepSeekUpstream(RELAY, SECRET)


def exact_inputs() -> dict[str, object]:
    arm = {
        "schema_version": "cortex-benchmark-arm/4", "kind": "cortex",
        "name": "cortex-deepseek-paid-smoke", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "bundle": "direct-pi-deepseek", "connection": None, "thinking": "off",
        "limits": {
            "max_provider_requests": 1, "max_cost_usd": "0.05",
            "deadline_seconds": 120, "max_output_tokens": 256,
        },
    }
    return {
        "arm": arm, "task_path": "/synthetic/task", "trials_dir": "/synthetic/trials",
        "manifest": {}, "trial_seed": {
            "arm": arm, "paid_run": True,
            "credential": {
                "upstream_base_url": RELAY,
            },
        },
        "cli_version": "2026.8.10", "host_scan_policy": {},
        "trial_proxy": {
            "credential_env": "unused-by-vault", "bound_source_ip": "172.31.0.2",
            "request_body_limit_bytes": 64 * 1024,
            "response_body_limit_bytes": 1024 * 1024,
        },
    }


def refuse_before_storing_the_credential(
    monkeypatch: pytest.MonkeyPatch, inputs: dict[str, object], message: str,
) -> None:
    async def forbidden_create(**_kwargs: object) -> object:
        raise AssertionError("a trial was created for a refused contract")

    before = HOST_CREDENTIAL_VAULT.pending_count
    monkeypatch.setattr(deepseek_paid_smoke, "create_harbor_trial", forbidden_create)
    with pytest.raises(ValueError, match=message):
        asyncio.run(deepseek_paid_smoke.run_deepseek_paid_smoke(
            upstream=UPSTREAM, trial_kwargs=inputs,
        ))
    assert HOST_CREDENTIAL_VAULT.pending_count == before


def test_refuses_contract_drift_before_storing_the_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    inputs = exact_inputs()
    inputs["arm"]["limits"]["max_provider_requests"] = 2
    refuse_before_storing_the_credential(monkeypatch, inputs, "contract")


def test_refuses_deadline_drift_before_storing_the_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    inputs = exact_inputs()
    inputs["arm"]["limits"]["deadline_seconds"] = 121
    refuse_before_storing_the_credential(monkeypatch, inputs, "contract")


def test_refuses_a_proxy_upstream_other_than_the_one_the_credential_belongs_to(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inputs = exact_inputs()
    inputs["trial_seed"]["credential"]["upstream_base_url"] = "https://api.deepseek.com"
    refuse_before_storing_the_credential(monkeypatch, inputs, "upstream differs")


def test_hands_only_an_opaque_handle_to_harbor_and_purges_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeTrial:
        async def run(self) -> str:
            return "completed"

    async def fake_create(**kwargs: object) -> FakeTrial:
        captured.update(kwargs)
        return FakeTrial()

    before = HOST_CREDENTIAL_VAULT.pending_count
    monkeypatch.setattr(deepseek_paid_smoke, "create_harbor_trial", fake_create)
    result = asyncio.run(deepseek_paid_smoke.run_deepseek_paid_smoke(
        upstream=UPSTREAM, trial_kwargs=exact_inputs(),
    ))

    encoded = json.dumps(captured, default=str, sort_keys=True)
    assert result == "completed"
    assert SECRET not in encoded
    assert captured["credential_handle"].startswith("vault-")
    assert HOST_CREDENTIAL_VAULT.pending_count == before


def test_purges_the_handle_when_trial_creation_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_create(**_kwargs: object) -> object:
        raise RuntimeError("synthetic create failure")

    before = HOST_CREDENTIAL_VAULT.pending_count
    monkeypatch.setattr(deepseek_paid_smoke, "create_harbor_trial", fail_create)
    with pytest.raises(RuntimeError, match="synthetic create failure"):
        asyncio.run(deepseek_paid_smoke.run_deepseek_paid_smoke(
            upstream=UPSTREAM, trial_kwargs=exact_inputs(),
        ))
    assert HOST_CREDENTIAL_VAULT.pending_count == before
