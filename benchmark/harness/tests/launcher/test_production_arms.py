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

EXECUTION_LIMITS = {
    "max_provider_requests": 200, "max_cost_usd": "2.00",
    "deadline_seconds": 1800, "max_output_tokens": 65536,
}


def arm(
    orchestration: dict[str, object],
    **overrides: object,
) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "an-arm", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": orchestration,
        "limits": dict(EXECUTION_LIMITS),
    }
    value.update(overrides)
    return value


def direct_arm(**overrides: object) -> dict[str, object]:
    return arm({"mode": "direct", "ask_manager": False}, **overrides)


def direct_codex_arm(**overrides: object) -> dict[str, object]:
    return arm(
        {"mode": "direct", "ask_manager": False},
        provider="openai-codex",
        model="gpt-5.6-sol",
        credential_capability="pi-openai-codex-oauth",
        **overrides,
    )


def audit_retry_arm(**overrides: object) -> dict[str, object]:
    return arm(
        {"mode": "coder-review", "coder_review_variant": "audit-retry",
         "ask_manager": False},
        **overrides,
    )


def reviewer_fix_arm(**overrides: object) -> dict[str, object]:
    return arm(
        {"mode": "coder-review", "coder_review_variant": "reviewer-fix",
         "ask_manager": False},
        **overrides,
    )


def manager_qa_off_arm(**overrides: object) -> dict[str, object]:
    return arm({"mode": "manager", "ask_manager": False}, **overrides)


def manager_qa_on_arm(**overrides: object) -> dict[str, object]:
    return arm({"mode": "manager", "ask_manager": True}, **overrides)


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
    assert bundle.thinking == "off"
    assert bundle.manager_qa is None


def test_direct_openai_codex_arm_resolves_to_its_committed_bundle() -> None:
    bundle = require_production_arm(direct_codex_arm())

    assert bundle.key == "direct-pi-openai-codex"
    assert bundle.bundle_dir.name == "cortex-home"
    assert bundle.root_template == "benchmark-direct"
    assert bundle.profile_name == "benchmark-direct"
    assert bundle.evidence_mode == "direct"
    assert bundle.expected_roles == ("benchmark-direct",)
    assert bundle.provider == "openai-codex"
    assert bundle.model == "gpt-5.6-sol"
    assert bundle.credential_capability == "pi-openai-codex-oauth"
    assert bundle.thinking == "xhigh"
    assert bundle.manager_qa is None
    assert bundle.bundle_dir != require_production_arm(direct_arm()).bundle_dir


def test_audit_retry_arm_resolves_to_its_own_bundle_template_and_roles() -> None:
    bundle = require_production_arm(audit_retry_arm())

    assert bundle.key == "coder-review-audit-retry-pi-deepseek"
    assert bundle.root_template == "benchmark-coder-review"
    assert bundle.profile_name == "benchmark-coder-review"
    assert bundle.evidence_mode == "coder-review"
    assert bundle.expected_roles == ("benchmark-coder", "benchmark-reviewer")
    assert bundle.manager_qa is None
    assert bundle.bundle_dir != require_production_arm(direct_arm()).bundle_dir


def test_reviewer_fix_arm_resolves_to_its_own_bundle_template_and_roles() -> None:
    bundle = require_production_arm(reviewer_fix_arm())

    assert bundle.key == "coder-review-reviewer-fix-pi-deepseek"
    assert bundle.root_template == "benchmark-coder-review-fix"
    assert bundle.profile_name == "benchmark-coder-review-fix"
    assert bundle.evidence_mode == "coder-review"
    assert bundle.expected_roles == ("benchmark-coder", "benchmark-fixer")
    assert bundle.manager_qa is None
    assert bundle.bundle_dir != require_production_arm(audit_retry_arm()).bundle_dir


def test_manager_qa_off_arm_resolves_to_its_own_bundle_template_and_role() -> None:
    bundle = require_production_arm(manager_qa_off_arm())

    assert bundle.key == "manager-qa-off-pi-deepseek"
    assert bundle.root_template == "benchmark-manager"
    assert bundle.profile_name == "benchmark-manager"
    assert bundle.evidence_mode == "manager"
    assert bundle.expected_roles == ("benchmark-manager",)
    assert bundle.manager_qa == "off"
    assert bundle.bundle_dir != require_production_arm(direct_arm()).bundle_dir


def test_manager_qa_on_arm_differs_only_by_its_question_tool_gate() -> None:
    off = require_production_arm(manager_qa_off_arm())
    on = require_production_arm(manager_qa_on_arm())

    assert on.key == "manager-qa-on-pi-deepseek"
    assert on.root_template == off.root_template == "benchmark-manager"
    assert on.profile_name == off.profile_name == "benchmark-manager"
    assert on.evidence_mode == off.evidence_mode == "manager"
    assert on.expected_roles == off.expected_roles == ("benchmark-manager",)
    assert on.manager_qa == "on"

    off_files = {
        path.relative_to(off.bundle_dir): path.read_bytes()
        for path in off.bundle_dir.rglob("*") if path.is_file()
    }
    on_files = {
        path.relative_to(on.bundle_dir): path.read_bytes()
        for path in on.bundle_dir.rglob("*") if path.is_file()
    }
    assert on_files.keys() == off_files.keys()
    changed = {path for path in on_files if on_files[path] != off_files[path]}
    agent_path = Path("config/thread-templates/agents/benchmark-manager.json")
    assert changed == {agent_path}

    off_agent = read_json(off.bundle_dir / agent_path)
    on_agent = read_json(on.bundle_dir / agent_path)
    assert on_agent["mcpToolAllowlist"] == [*off_agent["mcpToolAllowlist"], "ask_manager"]
    ignored = {"description", "mcpToolAllowlist"}
    assert {key: value for key, value in on_agent.items() if key not in ignored} == {
        key: value for key, value in off_agent.items() if key not in ignored
    }


def test_manager_arm_declares_a_task_root_and_the_one_path_it_needs_writable() -> None:
    """The second injection kind: work enters as a task the production dispatcher runs, which
    means the sealed home cannot keep the whole context tree read-only.
    """
    manager = require_production_arm(manager_qa_off_arm())

    assert manager.injection == "task-root"
    assert manager.writable_home_paths == ("context/projects/general",)
    for thread_root in (direct_arm(), audit_retry_arm(), reviewer_fix_arm()):
        bundle = require_production_arm(thread_root)
        assert bundle.injection == "thread-root"
        assert bundle.writable_home_paths == ()


def test_manager_arm_confinement_is_recorded_with_a_closed_endpoint_set() -> None:
    manager = require_production_arm(manager_qa_off_arm())

    assert manager.confinement_record() == {
        "injection": "task-root",
        "webhook_endpoints": ["POST /webhook/thread-op"],
        "writable_home_paths": ["context/projects/general"],
    }
    assert require_production_arm(manager_qa_on_arm()).confinement_record() == {
        "injection": "task-root",
        "webhook_endpoints": [
            "POST /webhook/thread-op", "POST /webhook/manager-qa",
        ],
        "writable_home_paths": ["context/projects/general"],
    }
    assert require_production_arm(direct_arm()).confinement_record() == {
        "injection": "thread-root",
        "webhook_endpoints": ["POST /webhook/thread-op"],
        "writable_home_paths": [],
    }


def test_manager_bundle_gates_ask_manager_out_of_its_agent_tool_surface() -> None:
    """Plan section 4 C2: Q&A off is the per-tool MCP gate, not a whole-server removal — the
    agent keeps a real MCP surface so the omission is the arm's only capability difference.
    """
    bundle = require_production_arm(manager_qa_off_arm())
    agent = read_json(
        bundle.bundle_dir / "config/thread-templates/agents/benchmark-manager.json")

    allowlist = agent["mcpToolAllowlist"]
    assert isinstance(allowlist, list) and allowlist
    assert "ask_manager" not in allowlist
    assert agent["mcpComposition"] == "thread-control"


def test_a_coder_review_variant_without_a_bundle_is_not_a_production_candidate() -> None:
    other = arm({
        "mode": "coder-review", "coder_review_variant": "reviewer-advise",
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
        assert profiles["profiles"][bundle.profile_name]["thinking"] == bundle.thinking
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
