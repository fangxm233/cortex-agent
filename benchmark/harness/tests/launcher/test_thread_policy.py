# input:  a coder-review trial seed, the container-observed cwd and a start instant
# output: the launcher-composed benchmark thread-policy document and its agent-dir file
# pos:    Contract tests for the production producer of the thread-policy document
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The document names WHICH trial the in-trial thread is and WHERE its compiler input lives, and
# nothing else. Every role, prompt, tool list, plugin dir, MCP config, thread template and compiled
# policy is re-derived in the server process from `run_config_path`. Design section 16 (16.3.2)
# PW3, PW3-NEG, PW4 and PW5.

import copy
import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.arm_resolution import (
    ARM_RESOLUTION_CONTAINER_PATH,
    BENCHMARK_THREAD_POLICY_CONTAINER_PATH,
    BENCHMARK_THREAD_POLICY_SOURCE,
    CODER_REVIEW_CORTEX_HOME,
    CODER_REVIEW_TRIAL_ROOT,
    TRAJECTORY_CONTAINER_PATH,
    ContainerFacts,
    build_benchmark_thread_mcp_config,
    build_benchmark_thread_policy,
    compose_arm_resolution,
    parse_trial_seed,
    write_benchmark_thread_policy,
)

DIGEST = f"sha256:{'a' * 64}"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
FACTS = ContainerFacts(BUNDLE_ROOT, "/usr/local/bin/claude", "2.1.220 (Claude Code)")
INSTRUCTION = "Complete the terminal task."
WORKSPACE = "/app"
STARTED_EPOCH_MS = 1_700_000_000_000
VARIANTS = ("audit-retry", "reviewer-fix")
VARIANT_TEMPLATE = {
    "audit-retry": "benchmark-coder-review",
    "reviewer-fix": "benchmark-coder-review-fix",
}
# The ten members of `cortex-benchmark-thread-policy/2`, restated here rather than imported: the
# schema is `.strict()` on the reading side, so an eleventh member is a refusal and this list is
# what makes adding one a test failure on the writing side too.
POLICY_MEMBERS = {
    "schema_version", "canonical_instruction", "workspace_cwd", "run_config_path", "trial_root",
    "template", "profile_name", "root_run_id", "trajectory_root", "limits",
}

BASE_ARM: dict[str, object] = {
    "schema_version": "cortex-benchmark-arm/2",
    "kind": "cortex",
    "name": "cortex-coder-review",
    "backend": "claude",
    "provider": "anthropic",
    "model": "claude-sonnet",
    "credential_capability": "claude-api-key",
    "orchestration": {"mode": "coder-review", "coder_review_variant": "audit-retry",
                      "ask_manager": False},
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


def arm(variant: str = "audit-retry", mode: str = "coder-review") -> dict[str, object]:
    value = copy.deepcopy(BASE_ARM)
    orchestration: dict[str, object] = {"mode": mode, "ask_manager": False}
    if mode == "coder-review":
        orchestration["coder_review_variant"] = variant
    value["orchestration"] = orchestration
    return value


def seed(variant: str = "audit-retry", mode: str = "coder-review") -> object:
    return parse_trial_seed({
        "arm": arm(variant, mode),
        "arm_path": "arm://cortex-coder-review",
        "trial_id": "trial-001",
        "root_run_id": "trial-001.cortex-coder-review",
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


def policy(variant: str = "audit-retry") -> dict[str, object]:
    return build_benchmark_thread_policy(
        arm(variant),
        canonical_instruction=INSTRUCTION,
        workspace_cwd=WORKSPACE,
        profile_name="benchmark",
        root_run_id="trial-001.cortex-coder-review",
        started_epoch_ms=STARTED_EPOCH_MS,
    )


def test_the_document_names_the_arm_resolution_as_its_compiler_input() -> None:
    # PW4: the server re-compiles from this path, so it must be the same document the parent's
    # `agent-run` was given — the value the shipped argv already carries as `--run-config`.
    document = policy()

    assert document["schema_version"] == "cortex-benchmark-thread-policy/2"
    assert document["run_config_path"] == str(ARM_RESOLUTION_CONTAINER_PATH)


def test_the_trial_root_contains_the_store_the_server_reads() -> None:
    # WL12's containment assertion is made over this member: the thread artifact must resolve
    # inside it, and the artifact lives under the server's own CORTEX_HOME.
    document = policy()

    assert document["trial_root"] == str(CODER_REVIEW_TRIAL_ROOT)
    assert str(CODER_REVIEW_CORTEX_HOME).startswith(f"{CODER_REVIEW_TRIAL_ROOT}/")
    assert document["trajectory_root"] == str(TRAJECTORY_CONTAINER_PATH)


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_template_is_the_variants_own_and_the_call_budget_is_one(variant: str) -> None:
    document = policy(variant)

    assert document["template"] == VARIANT_TEMPLATE[variant]
    assert document["limits"]["max_calls"] == 1  # type: ignore[index]


def test_the_limits_are_the_arms_own_bounds_resolved_to_an_instant() -> None:
    # The launcher knows no thread-specific budget: the arm's bounds are the only authority it has,
    # and the thread cannot exceed the trial that contains it. The deadline is an instant because
    # the reading side compares it against the clock, not against a duration.
    document = policy()

    assert document["limits"] == {  # type: ignore[comparison-overlap]
        "max_calls": 1,
        "max_steps": 8,
        "max_cost_usd": 2.50,
        "deadline_epoch_ms": STARTED_EPOCH_MS + 90_000,
    }


def test_the_document_carries_nothing_the_production_path_composes() -> None:
    # PW3-NEG as a property of the producer, not only of the reader.
    document = policy()

    assert set(document) == POLICY_MEMBERS
    serialized = json.dumps(document)
    for composed in ("system_prompt", "directive", "tools", "plugin_dir", "mcp_config",
                     "thread_template", "thread_agent", "role"):
        assert composed not in serialized


def test_a_direct_arm_has_no_thread_policy_at_all() -> None:
    with pytest.raises(ValueError, match="coder-review"):
        build_benchmark_thread_policy(
            arm(mode="direct"),
            canonical_instruction=INSTRUCTION,
            workspace_cwd=WORKSPACE,
            profile_name="benchmark",
            root_run_id="trial-001.cortex-direct",
            started_epoch_ms=STARTED_EPOCH_MS,
        )


def test_a_relative_workspace_refuses_rather_than_reaching_the_reader() -> None:
    # The reading schema refuses a relative path; refusing here names the producer instead of
    # leaving a trial to fail at MCP server start.
    with pytest.raises(ValueError, match="absolute"):
        build_benchmark_thread_policy(
            arm(),
            canonical_instruction=INSTRUCTION,
            workspace_cwd="app",
            profile_name="benchmark",
            root_run_id="trial-001.cortex-coder-review",
            started_epoch_ms=STARTED_EPOCH_MS,
        )


def test_the_written_file_sits_beside_the_resolution_and_is_read_only(tmp_path: Path) -> None:
    document = policy()

    output = write_benchmark_thread_policy(tmp_path, document)

    assert output == tmp_path / BENCHMARK_THREAD_POLICY_CONTAINER_PATH.name
    assert BENCHMARK_THREAD_POLICY_CONTAINER_PATH.parent == ARM_RESOLUTION_CONTAINER_PATH.parent
    assert json.loads(output.read_text()) == document
    # `readPolicyFile` refuses a writable document: the trial reads its own policy, never edits it.
    assert output.stat().st_mode & 0o222 == 0


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_thread_policy_is_a_declared_inventory_source(variant: str) -> None:
    # Section 3.1(f) fails closed on an undeclared file under a trial root, at scan time — later
    # and worse than a startup refusal.
    document = compose_arm_resolution(seed(variant), FACTS)
    expected = document["artifact_inventory_spec"]["expected"]  # type: ignore[index]

    assert BENCHMARK_THREAD_POLICY_SOURCE in expected


def test_a_direct_arm_declares_no_thread_policy_source() -> None:
    document = compose_arm_resolution(seed(mode="direct"), FACTS)
    expected = document["artifact_inventory_spec"]["expected"]  # type: ignore[index]

    assert BENCHMARK_THREAD_POLICY_SOURCE not in expected


def test_the_mcp_env_block_carries_the_policy_path_as_well_as_the_store_root() -> None:
    # PW5. Claude's stdio transport filters the MCP child's environment to a six-name allowlist,
    # and neither of these two names is in it — the config's own `env` block is the only channel
    # that reaches the server process at all.
    config = build_benchmark_thread_mcp_config(BUNDLE_ROOT)

    assert config["mcpServers"]["cortex-benchmark-thread"]["env"] == {  # type: ignore[index]
        "CORTEX_HOME": str(CODER_REVIEW_CORTEX_HOME),
        "CORTEX_BENCHMARK_THREAD_POLICY_PATH": str(BENCHMARK_THREAD_POLICY_CONTAINER_PATH),
    }
