# input:  selected Cortex arm, per-trial pins, capability registry
# output: exact ArmResolution emission and artifact declaration proofs
# pos:    Contract tests for the phase-A launcher document
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
    build_arm_resolution,
    write_arm_resolution,
)
from cortex_bench_harness.launcher.arms import select_arm

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


def test_rejects_a_credential_value_field_before_writing_projection() -> None:
    credential = {**CREDENTIAL, "real_credential": "sk-ant-must-not-enter"}
    value = replace(inputs(), credential=credential)

    with pytest.raises(ValueError, match="credential fields"):
        build_arm_resolution(value)
