# input:  campaign arm declarations and the committed bundle tree
# output: arm-to-bundle resolution, refusal and bundle-completeness proofs
# pos:    Contract tests for production arm resolution
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.production_arms import (
    PRODUCTION_ARM_BUNDLES,
    ProductionArmError,
    production_arm_bundle,
    production_arm_candidate,
    require_production_arm,
    resolve_production_arm,
)

CONTAINMENT_LIMITS = {
    "max_thread_starts": 0, "max_parent_questions": 0,
    "max_task_depth": 0, "max_tasks": 0,
}
EXECUTION_LIMITS = {
    "max_provider_requests": 200, "max_resident_agent_processes": 1,
    "max_cost_usd": "2.00", "deadline_seconds": 1800, "max_output_tokens": 65536,
}


def arm(orchestration: dict[str, object], **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "an-arm", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": orchestration,
        "limits": {**CONTAINMENT_LIMITS, **EXECUTION_LIMITS},
    }
    value.update(overrides)
    return value


def direct_arm(**overrides: object) -> dict[str, object]:
    return arm({"mode": "direct", "ask_manager": False}, **overrides)


def audit_retry_arm(**overrides: object) -> dict[str, object]:
    return arm(
        {"mode": "coder-review", "coder_review_variant": "audit-retry",
         "ask_manager": False},
        **overrides,
    )


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_direct_arm_resolves_to_the_committed_direct_bundle() -> None:
    bundle = require_production_arm(direct_arm())

    assert bundle.key == "direct-pi-deepseek"
    assert bundle.bundle_dir.name == "cortex-home"
    assert bundle.root_template == "benchmark-direct"
    assert bundle.profile_name == "benchmark-direct"
    assert bundle.evidence_mode == "direct"
    assert bundle.expected_roles == ("benchmark-direct",)
    assert bundle.manager_qa is None


def test_audit_retry_arm_resolves_to_its_own_bundle_template_and_roles() -> None:
    bundle = require_production_arm(audit_retry_arm())

    assert bundle.key == "coder-review-audit-retry-pi-deepseek"
    assert bundle.root_template == "benchmark-coder-review"
    assert bundle.profile_name == "benchmark-coder-review"
    assert bundle.evidence_mode == "coder-review"
    assert bundle.expected_roles == ("benchmark-coder", "benchmark-reviewer")
    assert bundle.manager_qa is None
    assert bundle.bundle_dir != require_production_arm(direct_arm()).bundle_dir


def test_a_candidate_whose_limits_do_not_match_its_declaration_is_refused() -> None:
    mismatched = audit_retry_arm()
    mismatched["limits"] = {**mismatched["limits"], "max_tasks": 3}

    assert production_arm_candidate(mismatched) is not None
    assert resolve_production_arm(mismatched) is None
    with pytest.raises(ProductionArmError, match="production launcher"):
        require_production_arm(mismatched)


def test_a_coder_review_variant_without_a_bundle_is_not_a_production_candidate() -> None:
    other = arm({
        "mode": "coder-review", "coder_review_variant": "reviewer-fix",
        "ask_manager": False,
    })

    assert production_arm_candidate(other) is None
    assert resolve_production_arm(other) is None


def test_a_non_pi_deepseek_arm_is_not_a_production_candidate() -> None:
    claude = direct_arm(backend="claude")

    assert production_arm_candidate(claude) is None
    assert resolve_production_arm(claude) is None


def test_an_unknown_bundle_key_is_refused() -> None:
    with pytest.raises(ProductionArmError, match="bundle"):
        production_arm_bundle("no-such-bundle")


def test_every_committed_bundle_ships_what_its_arm_declares() -> None:
    """The bundle is the arm: its root template, every agent that template names, a prompt file
    for each of those agents, and the profile the agents run under all live in the committed tree.
    """
    for bundle in PRODUCTION_ARM_BUNDLES:
        home = bundle.bundle_dir
        assert production_arm_bundle(bundle.key) is bundle
        template = read_json(
            home / f"config/thread-templates/templates/{bundle.root_template}.json")
        agents = template["agents"]
        assert isinstance(agents, list) and agents
        assert tuple(sorted(str(name) for name in agents)) == bundle.expected_roles
        profiles = read_json(home / "config/profiles.json")
        assert profiles["defaultProfile"] == bundle.profile_name
        assert bundle.profile_name in profiles["profiles"]
        assert read_json(home / "data/mode.json")["activeProfile"] == bundle.profile_name
        for name in agents:
            agent = read_json(home / f"config/thread-templates/agents/{name}.json")
            assert agent["profile"] == bundle.profile_name
            for field, kind in (("directive", "directives"), ("systemPrompt", "systemPrompts")):
                reference = str(agent[field])
                assert reference.startswith("file:")
                assert (home / "prompts" / kind / reference[len("file:"):]).is_file()
        for required in (
            "config/machines.json", "config/settings.json",
            "context/projects/general/TASKS.yaml", "data/schedules.json",
        ):
            assert (home / required).is_file()
