from pathlib import Path
from types import SimpleNamespace

import pytest

from cortex_bench_harness.launcher.production_arms import production_arm_bundle
from cortex_bench_harness.result_summary import build_result_summary

DIGEST = f"sha256:{'a' * 64}"
LIMITS = {
    "max_provider_requests": 500,
    "max_cost_usd": "2.00",
    "deadline_seconds": 1800,
    "max_output_tokens": 65536,
}


def summary_config(tmp_path: Path, *arms: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(
        campaign="summary-campaign",
        trials_dir=tmp_path,
        credential={"dummy_token_ref": "dummy-token"},
        proxy={"credential_env": "CORTEX_BENCH_TEST_CREDENTIAL"},
        cli_version="2026.8.6",
        arms=list(arms),
    )


def outcome(arm: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(
        plan=SimpleNamespace(
            trial_id="trial-01",
            arm=arm,
            arm_name=str(arm["name"]),
            task=SimpleNamespace(task_id="task-01", image_digest=DIGEST),
        ),
        envelope=None,
        outcome_state="terminal-success",
        verifier_rewards=None,
        score_status="available",
    )


def cortex_arm(**overrides: object) -> dict[str, object]:
    arm = {
        "schema_version": "cortex-benchmark-arm/3",
        "kind": "cortex",
        "name": "cortex-arm",
        "backend": "pi",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "bundle": "direct-pi-deepseek", "thinking": "off",
        "limits": dict(LIMITS),
    }
    arm.update(overrides)
    return arm


def vendor_arm(**overrides: object) -> dict[str, object]:
    arm = {
        "kind": "vendor-baseline",
        "name": "vendor-arm",
        "vendor_agent": "codex",
        "vendor_cli_version": "0.148.0",
        "provider": "openai-codex",
        "model": "gpt-5.6-sol",
        "credential_capability": "codex-subscription",
        "limits": dict(LIMITS),
    }
    arm.update(overrides)
    return arm


@pytest.mark.parametrize(("arm", "expected"), [
    (vendor_arm(thinking="xhigh"), "xhigh"),
    (vendor_arm(vendor_agent="pi", vendor_cli_version="0.82.1",
                credential_capability="pi-openai-codex-oauth", thinking="low"), "low"),
    (vendor_arm(vendor_agent="claude-code", vendor_cli_version="2.1.232",
                provider="anthropic", model="claude-opus-5",
                credential_capability="claude-subscription"), None),
])
def test_vendor_result_summary_projects_the_declared_thinking_when_present(
    tmp_path: Path, arm: dict[str, object], expected: str | None,
) -> None:
    summary = build_result_summary(summary_config(tmp_path, arm), [outcome(arm)])

    assert summary["schema_version"] == "cortex-bench-campaign-result-summary/5"
    assert summary["trials"][0]["thinking"] == expected


@pytest.mark.parametrize(("arm", "expected"), [
    (cortex_arm(), "off"),
    (cortex_arm(**production_arm_bundle("direct-pi-openai-codex").arm_fields()), "xhigh"),
])
def test_cortex_result_summary_projects_the_bundle_thinking(
    tmp_path: Path, arm: dict[str, object], expected: str,
) -> None:
    summary = build_result_summary(summary_config(tmp_path, arm), [outcome(arm)])

    assert summary["trials"][0]["thinking"] == expected


def test_the_summary_counts_each_arm_against_the_denominator_it_earned(
    tmp_path: Path,
) -> None:
    """A task the provider was down for is not a task the agent failed, so it is counted apart
    rather than averaged in as a zero."""
    arm = cortex_arm()
    scored = outcome(arm)
    scored.verifier_rewards = {"reward": 1.0}
    unavailable = outcome(arm)
    unavailable.score_status = "provider_unavailable"

    summary = build_result_summary(
        summary_config(tmp_path, arm), [scored, unavailable, outcome(arm)])

    assert summary["arms"] == [{
        "arm": "cortex-arm", "model": "deepseek-v4-flash", "thinking": "off",
        "tasks": 3, "reward_total": 1.0,
        "score_status": {"available": 2, "provider_unavailable": 1},
    }]


def test_the_summary_counts_unsent_requests_beside_the_ones_that_reached_the_provider(
    tmp_path: Path,
) -> None:
    arm = cortex_arm()
    scored = outcome(arm)
    scored.envelope = {"proxy_usage": {"requests": 4, "unsent_requests": 2}}

    counters = build_result_summary(
        summary_config(tmp_path, arm), [scored])["trials"][0]["counters"]

    assert (counters["requests"], counters["unsent_requests"]) == (4, 2)
