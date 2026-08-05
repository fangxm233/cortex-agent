# input:  a coder-review trial seed for either variant on either backend
# output: the composed phase-A role set, thread assets and benchmark MCP declaration
# pos:    Contract tests for the Gate-3 variant role sets
# >>> If I am updated, update my header and folder CORTEX.md <<<

import copy
import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.arm_resolution import (
    ARM_RESOLUTION_SOURCE,
    BENCHMARK_THREAD_MCP_CONTAINER_PATH,
    BENCHMARK_THREAD_MCP_SOURCE,
    DIRECT_CLAUDE_DIRECTIVE,
    DIRECT_CLAUDE_PLUGIN_DIRS,
    DIRECT_CLAUDE_SYSTEM_PROMPT,
    DIRECT_PARENT_TOOLS,
    ContainerFacts,
    build_benchmark_thread_mcp_config,
    compose_arm_resolution,
    parse_trial_seed,
    write_benchmark_thread_mcp_config,
)

DIGEST = f"sha256:{'a' * 64}"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
FACTS = ContainerFacts(BUNDLE_ROOT, "/usr/local/bin/claude", "2.1.220 (Claude Code)")
VARIANTS = ("audit-retry", "reviewer-fix")
BACKENDS = ("claude", "pi")

# Design (14.2.4) freezes these; RB-TOOLS is the rule that produces the PI column. They are restated
# here rather than imported from the module under test, so a change to the module is a test failure
# rather than a silently agreeing pair.
CHILD_TOOLS = {
    "claude": {
        "benchmark-coder": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite", "Skill"],
        "benchmark-reviewer": ["Bash", "Read", "Glob", "Grep", "TodoWrite", "Skill"],
        "benchmark-fixer": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite", "Skill"],
    },
    "pi": {
        "benchmark-coder": ["bash", "read", "write", "edit", "glob", "grep", "todo_write", "skill"],
        "benchmark-reviewer": ["bash", "read", "glob", "grep", "todo_write", "skill"],
        "benchmark-fixer": ["bash", "read", "write", "edit", "glob", "grep", "todo_write", "skill"],
    },
}
VARIANT_CHILDREN = {
    "audit-retry": ["benchmark-coder", "benchmark-reviewer"],
    "reviewer-fix": ["benchmark-coder", "benchmark-fixer"],
}
VARIANT_TEMPLATE = {
    "audit-retry": "benchmark-coder-review",
    "reviewer-fix": "benchmark-coder-review-fix",
}

BASE_ARM: dict[str, object] = {
    "schema_version": "cortex-benchmark-arm/2",
    "kind": "cortex",
    "name": "cortex-coder-review",
    "backend": "claude",
    "provider": "anthropic",
    "model": "claude-sonnet",
    "credential_capability": "claude-api-key",
    "orchestration": {"mode": "direct", "ask_manager": False},
    "limits": {
        "max_thread_starts": 1,
        "max_parent_questions": 0,
        "max_task_depth": 0,
        "max_tasks": 0,
        "max_provider_requests": 8,
        "max_resident_agent_processes": 3,
        "max_cost_usd": "2.50",
        "deadline_seconds": 90,
    },
}


def seed(variant: str, backend: str = "claude") -> object:
    arm = copy.deepcopy(BASE_ARM)
    arm["backend"] = backend
    arm["name"] = f"cortex-{backend}-{variant}"
    arm["orchestration"] = {
        "mode": "coder-review", "coder_review_variant": variant, "ask_manager": False,
    }
    return parse_trial_seed({
        "arm": arm,
        "arm_path": f"arm://cortex-{backend}-{variant}",
        "trial_id": "trial-001",
        "root_run_id": f"trial-001.cortex-{backend}-{variant}",
        "task": {
            "task_id": "terminal-task",
            "image_ref": f"registry.invalid/task@{DIGEST}",
            "image_digest": DIGEST,
        },
        "profile_name": "benchmark",
        "paid_run": False,
        "credential": {
            "upstream_base_url": "https://api.anthropic.com",
            "route_identity_host": "api.anthropic.com",
            "proxy_base_url": "http://trial-proxy.invalid",
            "dummy_token_ref": "trial-token-handle",
        },
        "model_alias_policy": {"kind": "exact"},
    })


def roles(variant: str, backend: str = "claude") -> dict[str, dict[str, object]]:
    document = compose_arm_resolution(seed(variant, backend), FACTS)
    return document["roles"]  # type: ignore[return-value]


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("backend", BACKENDS)
def test_the_role_map_holds_the_parent_and_exactly_the_variants_two_children(
    variant: str, backend: str,
) -> None:
    # RB3: three entries, and which three is determined by the whitelisted template, not chosen.
    assert sorted(roles(variant, backend)) == sorted(["parent"] + VARIANT_CHILDREN[variant])


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("backend", BACKENDS)
def test_the_parent_is_the_frozen_direct_surface_with_one_member_changed(
    variant: str, backend: str,
) -> None:
    parent = roles(variant, backend)["parent"]

    # RB1/RB2: every member is taken by citation to the shipped h.3 constants; the sole delta is the
    # MCP composition, and the config path that value forces.
    assert parent == {
        "system_prompt_path": f"{BUNDLE_ROOT}/{DIRECT_CLAUDE_SYSTEM_PROMPT}",
        "directive_path": f"{BUNDLE_ROOT}/{DIRECT_CLAUDE_DIRECTIVE}",
        "tools": list(DIRECT_PARENT_TOOLS[backend]),
        "plugin_dirs": [
            f"{BUNDLE_ROOT}/{directory}" for directory in DIRECT_CLAUDE_PLUGIN_DIRS
        ],
        "mcp_composition": "benchmark-thread-run",
        "mcp_config_paths": [str(BENCHMARK_THREAD_MCP_CONTAINER_PATH)],
        "disable_hooks": True,
    }
    assert len(parent["tools"]) == 9


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("backend", BACKENDS)
def test_each_child_carries_its_documents_tool_surface_in_its_backends_labels(
    variant: str, backend: str,
) -> None:
    composed = roles(variant, backend)
    for slot in VARIANT_CHILDREN[variant]:
        child = composed[slot]
        assert child["tools"] == CHILD_TOOLS[backend][slot], slot
        assert child["system_prompt_path"] == (
            f"{BUNDLE_ROOT}/defaults/prompts/systemPrompts/{slot}.md"
        )
        assert child["directive_path"] == f"{BUNDLE_ROOT}/defaults/prompts/directives/{slot}.md"
        assert child["plugin_dirs"] == []
        assert child["mcp_composition"] == "none"
        assert child["mcp_config_paths"] == []
        assert child["disable_hooks"] is True


@pytest.mark.parametrize("backend", BACKENDS)
def test_the_two_variants_differ_only_in_the_third_slots_identity_and_write_capability(
    backend: str,
) -> None:
    audit = roles("audit-retry", backend)
    fix = roles("reviewer-fix", backend)

    assert audit["parent"] == fix["parent"]
    assert audit["benchmark-coder"] == fix["benchmark-coder"]
    reviewer = audit["benchmark-reviewer"]["tools"]
    fixer = fix["benchmark-fixer"]["tools"]
    assert len(reviewer) == 6
    assert len(fixer) == 8
    # The reviewer's six are the fixer's eight minus exactly the two writing tools.
    assert set(fixer) - set(reviewer) == set(CHILD_TOOLS[backend]["benchmark-coder"]) - set(reviewer)
    assert len(set(fixer) - set(reviewer)) == 2


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("backend", BACKENDS)
def test_no_phase_a_role_authors_a_policy_guard(variant: str, backend: str) -> None:
    # RB5: the guard is derived by the compiler. A document that supplies one is refused outright by
    # the role schema, so a composer that authored one would fail every trial it composed.
    for slot, role in roles(variant, backend).items():
        assert "benchmark_policy_guard" not in role, slot


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("backend", BACKENDS)
def test_exactly_one_template_and_exactly_two_agents_are_declared(
    variant: str, backend: str,
) -> None:
    document = compose_arm_resolution(seed(variant, backend), FACTS)
    templates = f"{BUNDLE_ROOT}/defaults/config/thread-templates"

    assert document["thread_templates"] == {
        VARIANT_TEMPLATE[variant]: f"{templates}/templates/{VARIANT_TEMPLATE[variant]}.json",
    }
    assert document["thread_agents"] == {
        slot: f"{templates}/agents/{slot}.json" for slot in VARIANT_CHILDREN[variant]
    }


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_benchmark_mcp_config_is_a_declared_inventory_source(variant: str) -> None:
    # A new file under the trial roots that no inventory source names fails section 3.1(f) closed.
    document = compose_arm_resolution(seed(variant), FACTS)
    expected = document["artifact_inventory_spec"]["expected"]  # type: ignore[index]

    assert ARM_RESOLUTION_SOURCE in expected
    assert BENCHMARK_THREAD_MCP_SOURCE in expected


def test_the_declared_mcp_file_exposes_only_the_benchmark_thread_server(tmp_path: Path) -> None:
    # The compile is code 19 unless the composition exposes exactly this one server.
    config = build_benchmark_thread_mcp_config(BUNDLE_ROOT)
    assert list(config["mcpServers"]) == ["cortex-benchmark-thread"]
    # EV-ENV: the file's name is the shipped constant's basename (config-generator.ts:19), and the
    # entry must carry the coordinator's CORTEX_HOME so the spawned server reads the same store
    # root as the agent-run that admitted the trial.
    assert BENCHMARK_THREAD_MCP_CONTAINER_PATH.name == "mcp-config-benchmark-thread.json"
    assert config["mcpServers"]["cortex-benchmark-thread"] == {
        "command": "node",
        "args": [f"{BUNDLE_ROOT}/dist/domain/mcp/benchmark-thread-server.js"],
        "cwd": BUNDLE_ROOT,
        "env": {
            "CORTEX_HOME": f"{BENCHMARK_THREAD_MCP_CONTAINER_PATH.parent}/trial-home/cortex-home",
        },
    }

    output = write_benchmark_thread_mcp_config(tmp_path, BUNDLE_ROOT)

    assert output == tmp_path / BENCHMARK_THREAD_MCP_CONTAINER_PATH.name
    assert json.loads(output.read_text()) == config
    assert output.read_bytes().endswith(b"\n")


def test_a_coder_review_arm_without_a_known_variant_refuses_rather_than_guessing() -> None:
    unknown = seed("audit-retry")
    arm = copy.deepcopy(dict(unknown.arm))
    arm["orchestration"] = {"mode": "coder-review", "ask_manager": False}
    from dataclasses import replace

    with pytest.raises(ValueError, match="coder_review_variant"):
        compose_arm_resolution(replace(unknown, arm=arm), FACTS)


def test_direct_arms_keep_the_frozen_h3_composition_untouched() -> None:
    # RB1: lifting row 2 may not disturb (h.3). A direct parent still exposes no MCP surface and
    # still declares exactly the one inventory source it always did.
    direct = copy.deepcopy(BASE_ARM)
    direct["limits"] = {**BASE_ARM["limits"], "max_thread_starts": 0}  # type: ignore[dict-item]
    document = compose_arm_resolution(parse_trial_seed({
        "arm": direct, "arm_path": "arm://cortex-direct", "trial_id": "trial-001",
        "root_run_id": "trial-001.cortex-direct",
        "task": {
            "task_id": "terminal-task",
            "image_ref": f"registry.invalid/task@{DIGEST}",
            "image_digest": DIGEST,
        },
        "profile_name": "benchmark", "paid_run": False,
        "credential": {
            "upstream_base_url": "https://api.anthropic.com",
            "route_identity_host": "api.anthropic.com",
            "proxy_base_url": "http://trial-proxy.invalid",
            "dummy_token_ref": "trial-token-handle",
        },
        "model_alias_policy": {"kind": "exact"},
    }), FACTS)

    assert list(document["roles"]) == ["parent"]  # type: ignore[arg-type]
    assert document["roles"]["parent"]["mcp_composition"] == "none"  # type: ignore[index]
    assert document["roles"]["parent"]["mcp_config_paths"] == []  # type: ignore[index]
    assert document["thread_templates"] == {}
    assert document["thread_agents"] == {}
    assert document["artifact_inventory_spec"] == {"expected": [ARM_RESOLUTION_SOURCE]}
