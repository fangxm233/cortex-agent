# input:  selected Cortex arm, per-trial pins, capability projection
# output: phase-A ArmResolution JSON document and agent-dir file
# pos:    Host emitter for the benchmark compiler input
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath

from harbor.models.trial.paths import EnvironmentPaths

from .credential_capabilities import project_credential_capabilities

ARM_RESOLUTION_SCHEMA_VERSION = "cortex-benchmark-arm-resolution/1"
ARM_RESOLUTION_SOURCE = "arm_resolution"
ARM_RESOLUTION_FILENAME = "arm-resolution.json"
ARM_RESOLUTION_CONTAINER_PATH: PurePosixPath = (
    EnvironmentPaths().agent_dir / ARM_RESOLUTION_FILENAME
)


@dataclass(frozen=True)
class ArmResolutionInputs:
    arm: Mapping[str, object]
    arm_path: str
    trial_id: str
    root_run_id: str
    task: Mapping[str, object]
    profile_name: str
    paid_run: bool
    credential: Mapping[str, object]
    cli_artifact: Mapping[str, object]
    model_alias_policy: object
    roles: Mapping[str, object]
    thread_templates: Mapping[str, str]
    thread_agents: Mapping[str, str]
    artifact_inventory_spec: object
    expected_asset_hashes: Mapping[str, str] | None = None
    pi_benchmark_capability_proven: bool | None = None


def _plain_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {str(key): _plain_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json(item) for item in value]
    return value


def _json_copy(value: object) -> object:
    return json.loads(json.dumps(_plain_json(value)))


def _require_fields(
    value: Mapping[str, object], expected: frozenset[str], label: str,
) -> None:
    if set(value) != expected:
        raise ValueError(f"ArmResolution {label} fields must be exactly {sorted(expected)}")


def _validate_inputs(inputs: ArmResolutionInputs) -> None:
    if inputs.arm.get("kind") != "cortex":
        raise ValueError("ArmResolution is emitted only for Cortex arms")
    _require_fields(
        inputs.task, frozenset({"task_id", "image_ref", "image_digest"}), "task",
    )
    _require_fields(inputs.credential, frozenset({
        "upstream_base_url", "route_identity_host", "proxy_base_url", "dummy_token_ref",
    }), "credential")
    _require_fields(inputs.cli_artifact, frozenset({"path", "version"}), "cli_artifact")
    expected = (
        inputs.artifact_inventory_spec.get("expected")
        if isinstance(inputs.artifact_inventory_spec, Mapping) else None
    )
    if not isinstance(expected, list) or ARM_RESOLUTION_SOURCE not in expected:
        raise ValueError(f"artifact inventory must declare {ARM_RESOLUTION_SOURCE}")


def _base_document(inputs: ArmResolutionInputs) -> dict[str, object]:
    return {
        "schema_version": ARM_RESOLUTION_SCHEMA_VERSION,
        "arm": inputs.arm,
        "arm_path": inputs.arm_path,
        "trial_id": inputs.trial_id,
        "root_run_id": inputs.root_run_id,
        "task": inputs.task,
        "profile_name": inputs.profile_name,
        "paid_run": inputs.paid_run,
        "credential_capabilities": project_credential_capabilities(),
        "credential": inputs.credential,
        "cli_artifact": inputs.cli_artifact,
        "model_alias_policy": inputs.model_alias_policy,
        "roles": inputs.roles,
        "thread_templates": inputs.thread_templates,
        "thread_agents": inputs.thread_agents,
        "artifact_inventory_spec": inputs.artifact_inventory_spec,
    }


def build_arm_resolution(inputs: ArmResolutionInputs) -> dict[str, object]:
    _validate_inputs(inputs)
    document = _base_document(inputs)
    if inputs.expected_asset_hashes is not None:
        document["expected_asset_hashes"] = inputs.expected_asset_hashes
    if inputs.pi_benchmark_capability_proven is not None:
        document["pi_benchmark_capability_proven"] = inputs.pi_benchmark_capability_proven
    copied = _json_copy(document)
    assert isinstance(copied, dict)
    return copied


def write_arm_resolution(
    agent_dir: Path, document: Mapping[str, object],
) -> Path:
    output = agent_dir / ARM_RESOLUTION_FILENAME
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return output
