# input:  exact paid trial inputs, synthetic gateway credential, fake Harbor trial
# output: contract refusal, opaque handoff, and cleanup proofs
# pos:    DeepSeek paid-smoke launcher contract tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher import deepseek_paid_smoke, run_deepseek_paid_smoke
from cortex_bench_harness.launcher.host_credential_vault import HOST_CREDENTIAL_VAULT

SECRET = "synthetic-relay-secret-UNIQUE"


def exact_inputs() -> dict[str, object]:
    arm = {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "cortex-deepseek-paid-smoke", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 1,
            "max_resident_agent_processes": 1, "max_cost_usd": "0.05",
            "deadline_seconds": 120, "max_output_tokens": 256,
        },
    }
    return {
        "arm": arm, "task_path": "/synthetic/task", "trials_dir": "/synthetic/trials",
        "manifest": {}, "trial_seed": {
            "arm": arm, "paid_run": True,
            "credential": {
                "upstream_base_url": "http://127.0.0.1:9880/m/deepseek/deepseek",
            },
        },
        "cli_version": "2026.8.10", "host_scan_policy": {},
        "trial_proxy": {
            "credential_env": "unused-by-vault", "bound_source_ip": "172.31.0.2",
            "request_body_limit_bytes": 64 * 1024,
            "response_body_limit_bytes": 1024 * 1024,
        },
    }


def write_gateway(path: Path) -> None:
    path.write_text(
        "deepseek:\n  deepseek:\n    base_url: https://relay.invalid\n"
        f"    keys:\n      - {SECRET}\n",
    )


def test_refuses_contract_drift_before_loading_a_credential(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    inputs = exact_inputs()
    inputs["arm"]["limits"]["max_provider_requests"] = 2
    called = False

    def forbidden_loader(_path: Path) -> str:
        nonlocal called
        called = True
        return SECRET

    monkeypatch.setattr(deepseek_paid_smoke, "load_deepseek_relay_credential", forbidden_loader)
    with pytest.raises(ValueError, match="contract"):
        asyncio.run(deepseek_paid_smoke.run_deepseek_paid_smoke(
            gateway_path=tmp_path / "missing.yaml", trial_kwargs=inputs,
        ))
    assert called is False


def test_refuses_deadline_drift_before_loading_a_credential(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    inputs = exact_inputs()
    inputs["arm"]["limits"]["deadline_seconds"] = 121
    called = False

    def forbidden_loader(_path: Path) -> str:
        nonlocal called
        called = True
        return SECRET

    monkeypatch.setattr(deepseek_paid_smoke, "load_deepseek_relay_credential", forbidden_loader)
    with pytest.raises(ValueError, match="contract"):
        asyncio.run(deepseek_paid_smoke.run_deepseek_paid_smoke(
            gateway_path=tmp_path / "missing.yaml", trial_kwargs=inputs,
        ))
    assert called is False


def test_launcher_public_surface_exports_the_exact_paid_entry() -> None:
    assert run_deepseek_paid_smoke is deepseek_paid_smoke.run_deepseek_paid_smoke


def test_hands_only_an_opaque_handle_to_harbor_and_purges_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = tmp_path / "gateway.yaml"
    write_gateway(gateway)
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
        gateway_path=gateway, trial_kwargs=exact_inputs(),
    ))

    encoded = json.dumps(captured, default=str, sort_keys=True)
    assert result == "completed"
    assert SECRET not in encoded
    assert captured["credential_handle"].startswith("vault-")
    assert HOST_CREDENTIAL_VAULT.pending_count == before


def test_purges_the_handle_when_trial_creation_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = tmp_path / "gateway.yaml"
    write_gateway(gateway)

    async def fail_create(**_kwargs: object) -> object:
        raise RuntimeError("synthetic create failure")

    before = HOST_CREDENTIAL_VAULT.pending_count
    monkeypatch.setattr(deepseek_paid_smoke, "create_harbor_trial", fail_create)
    with pytest.raises(RuntimeError, match="synthetic create failure"):
        asyncio.run(deepseek_paid_smoke.run_deepseek_paid_smoke(
            gateway_path=gateway, trial_kwargs=exact_inputs(),
        ))
    assert HOST_CREDENTIAL_VAULT.pending_count == before
