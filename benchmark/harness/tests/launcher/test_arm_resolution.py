# input:  trial seed, container facts, selected Cortex arm, capability registry
# output: seed parsing, frozen direct composition, and emission proofs
# pos:    Contract tests for the phase-A launcher composer
# >>> If I am updated, update my header and folder CORTEX.md <<<

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.arm_resolution import (
    ARM_RESOLUTION_CONTAINER_PATH,
    ARM_RESOLUTION_SOURCE,
    ArmResolutionInputs,
    ContainerFacts,
    build_arm_resolution,
    compose_arm_resolution,
    parse_trial_seed,
    write_arm_resolution,
)
from cortex_bench_harness.launcher.arms import (
    ArmCompositionUnsupportedError,
    BackendUnsupportedForKindError,
    select_arm,
)

DIGEST = f"sha256:{'a' * 64}"
BASE_ARM: dict[str, object] = {
    "schema_version": "cortex-benchmark-arm/2",
    "kind": "cortex",
    "name": "cortex-direct",
    "backend": "claude",
    "provider": "anthropic",
    "model": "claude-sonnet",
    "credential_capability": "claude-api-key",
    "orchestration": {"mode": "direct", "ask_manager": False},
    "limits": {
        "max_thread_starts": 0,
        "max_parent_questions": 0,
        "max_task_depth": 0,
        "max_tasks": 0,
        "max_provider_requests": 8,
        "max_resident_agent_processes": 3,
        "max_cost_usd": "2.50",
        "deadline_seconds": 90,
    },
}
TASK = {
    "task_id": "terminal-task",
    "image_ref": f"registry.invalid/task@{DIGEST}",
    "image_digest": DIGEST,
}
CREDENTIAL = {
    "upstream_base_url": "https://api.anthropic.com",
    "route_identity_host": "api.anthropic.com",
    "proxy_base_url": "http://trial-proxy.invalid",
    "dummy_token_ref": "trial-token-handle",
}
CLI_ARTIFACT = {"path": "/usr/local/bin/claude", "version": "1.2.3"}
ROLES = {
    "parent": {
        "system_prompt_path": "/logs/agent/parent-system.txt",
        "directive_path": "/logs/agent/parent-directive.txt",
        "tools": ["Read", "Write"],
        "plugin_dirs": [],
        "mcp_composition": "none",
        "mcp_config_paths": ["/cortex-home/config/mcp-config-empty.json"],
        "disable_hooks": True,
    },
}
EXPECTED_CAPABILITIES = [
    {
        "id": "claude-api-key",
        "state": "offline-contract-passed",
        "key": {
            "runner_or_backend": "claude",
            "provider": "anthropic",
            "protocol": "anthropic-messages",
            "credential_kind": "api-key-bearer",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "claude-subscription",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "claude",
            "provider": "anthropic",
            "protocol": "anthropic-messages",
            "credential_kind": "subscription-oauth",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "codex-subscription",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "codex-cli",
            "provider": "openai",
            "protocol": "??",
            "credential_kind": "subscription",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "pi-api-key",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "pi",
            "provider": "??",
            "protocol": "??",
            "credential_kind": "api-key",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "pi-openai-codex-oauth",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "pi",
            "provider": "openai-codex",
            "protocol": "??",
            "credential_kind": "oauth",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
]
EXPECTED_RESOLUTION = {
    "schema_version": "cortex-benchmark-arm-resolution/1",
    "arm": BASE_ARM,
    "arm_path": "arm://cortex-direct",
    "trial_id": "trial-001",
    "root_run_id": "trial-001.cortex-direct",
    "task": TASK,
    "profile_name": "benchmark",
    "paid_run": False,
    "credential_capabilities": EXPECTED_CAPABILITIES,
    "credential": CREDENTIAL,
    "cli_artifact": CLI_ARTIFACT,
    "model_alias_policy": {"kind": "exact"},
    "roles": ROLES,
    "thread_templates": {},
    "thread_agents": {},
    "artifact_inventory_spec": {"expected": [ARM_RESOLUTION_SOURCE]},
}


def arm(kind: str = "cortex") -> dict[str, object]:
    value = copy.deepcopy(BASE_ARM)
    value["kind"] = kind
    if kind == "vendor-baseline":
        value.pop("backend")
        value.pop("orchestration")
        value["vendor_agent"] = "claude-code"
    return value


def inputs(kind: str = "cortex") -> ArmResolutionInputs:
    return ArmResolutionInputs(
        arm=arm(kind), arm_path="arm://cortex-direct",
        trial_id="trial-001", root_run_id="trial-001.cortex-direct",
        task=TASK, profile_name="benchmark", paid_run=False,
        credential=CREDENTIAL, cli_artifact=CLI_ARTIFACT,
        model_alias_policy={"kind": "exact"}, roles=ROLES,
        thread_templates={}, thread_agents={},
        artifact_inventory_spec={"expected": [ARM_RESOLUTION_SOURCE]},
    )


def test_builds_exact_non_secret_arm_resolution() -> None:
    document = build_arm_resolution(inputs())

    assert document == EXPECTED_RESOLUTION
    encoded_capabilities = json.dumps(document["credential_capabilities"])
    assert "Bearer " not in encoded_capabilities
    assert "sk-ant-" not in encoded_capabilities


def test_accepts_the_immutable_arm_returned_by_selection() -> None:
    selected = select_arm([arm()], "cortex-direct")
    document = build_arm_resolution(replace(inputs(), arm=selected))

    assert document["arm"] == BASE_ARM


def test_writes_utf8_json_to_the_fixed_agent_filename(tmp_path: Path) -> None:
    document = build_arm_resolution(inputs())

    output = write_arm_resolution(tmp_path, document)

    assert output == tmp_path / ARM_RESOLUTION_CONTAINER_PATH.name
    assert json.loads(output.read_text()) == document
    assert output.read_bytes().endswith(b"\n")


def test_rejects_baselines_and_inventory_without_its_own_source() -> None:
    with pytest.raises(ValueError, match="Cortex"):
        build_arm_resolution(inputs("vendor-baseline"))

    value = replace(inputs(), artifact_inventory_spec={"expected": ["stdout"]})
    with pytest.raises(ValueError, match=ARM_RESOLUTION_SOURCE):
        build_arm_resolution(value)


BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
FACTS = ContainerFacts(BUNDLE_ROOT, "/usr/local/bin/claude", "1.2.3 (Claude Code)")
FORBIDDEN_TOOLS = frozenset({
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskStop", "WebFetch", "WebSearch",
})


def seed_document(kind: str = "cortex") -> dict[str, object]:
    return {
        "arm": arm(kind), "arm_path": "arm://cortex-direct", "trial_id": "trial-001",
        "root_run_id": "trial-001.cortex-direct", "task": copy.deepcopy(TASK),
        "profile_name": "benchmark", "paid_run": False,
        "credential": copy.deepcopy(CREDENTIAL), "model_alias_policy": {"kind": "exact"},
    }


def test_composes_the_frozen_direct_parent_from_container_facts() -> None:
    document = compose_arm_resolution(parse_trial_seed(seed_document()), FACTS)

    assert document == {
        **EXPECTED_RESOLUTION,
        "cli_artifact": {"path": "/usr/local/bin/claude", "version": "1.2.3 (Claude Code)"},
        "roles": {"parent": {
            "system_prompt_path": f"{BUNDLE_ROOT}/defaults/prompts/systemPrompts/direct.md",
            "directive_path": f"{BUNDLE_ROOT}/defaults/prompts/directives/executor.md",
            "tools": ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill",
                      "TodoWrite", "Write"],
            "plugin_dirs": [
                f"{BUNDLE_ROOT}/defaults/plugins/cortex-common",
                f"{BUNDLE_ROOT}/defaults/plugins/cortex-coder",
            ],
            "mcp_composition": "none", "mcp_config_paths": [], "disable_hooks": True,
        }},
    }
    parent = document["roles"]["parent"]  # type: ignore[index]
    assert not FORBIDDEN_TOOLS & set(parent["tools"])
    assert "benchmark_policy_guard" not in parent


def test_parse_trial_seed_refuses_every_launcher_owned_member() -> None:
    for member in (
        "schema_version", "credential_capabilities", "cli_artifact", "roles",
        "thread_templates", "thread_agents", "artifact_inventory_spec",
    ):
        with pytest.raises(ValueError, match=member):
            parse_trial_seed({**seed_document(), member: {}})

    with pytest.raises(ValueError, match="trial_id"):
        parse_trial_seed({key: value for key, value in seed_document().items()
                          if key != "trial_id"})


def test_parse_trial_seed_snapshots_the_caller_mapping() -> None:
    source = seed_document()
    seed = parse_trial_seed(source)

    source["arm"]["name"] = "mutated-after-construction"  # type: ignore[index]
    source["task"]["task_id"] = "mutated-after-construction"  # type: ignore[index]
    document = compose_arm_resolution(seed, FACTS)

    assert document["arm"] == BASE_ARM
    assert document["task"] == TASK


def test_parse_trial_seed_carries_the_optional_host_authorisations() -> None:
    seed = parse_trial_seed({
        **seed_document(), "expected_asset_hashes": {"arm:cortex-direct": "a" * 64},
        "pi_benchmark_capability_proven": False,
    })

    document = compose_arm_resolution(seed, FACTS)

    assert document["expected_asset_hashes"] == {"arm:cortex-direct": "a" * 64}
    assert document["pi_benchmark_capability_proven"] is False


def test_composition_fails_closed_for_every_other_combination() -> None:
    coder_review = copy.deepcopy(seed_document())
    coder_review["arm"] = {**BASE_ARM, "orchestration": {
        "mode": "coder-review", "coder_review_variant": "audit-retry", "ask_manager": False,
    }}
    undeclared_backend = copy.deepcopy(seed_document())
    undeclared_backend["arm"] = {**BASE_ARM, "backend": "unknown-backend"}

    with pytest.raises(ArmCompositionUnsupportedError, match="gate 3"):
        compose_arm_resolution(parse_trial_seed(coder_review), FACTS)
    with pytest.raises(BackendUnsupportedForKindError, match="its owning gate"):
        compose_arm_resolution(parse_trial_seed(undeclared_backend), FACTS)


def test_composition_admits_a_pi_backed_direct_arm() -> None:
    pi_backend = copy.deepcopy(seed_document())
    pi_backend["arm"] = {**BASE_ARM, "backend": "pi"}

    document = compose_arm_resolution(parse_trial_seed(pi_backend), FACTS)

    assert document["arm"]["backend"] == "pi"


def test_rejects_a_credential_value_field_before_writing_projection() -> None:
    credential = {**CREDENTIAL, "real_credential": "sk-ant-must-not-enter"}
    value = replace(inputs(), credential=credential)

    with pytest.raises(ValueError, match="credential fields"):
        build_arm_resolution(value)
