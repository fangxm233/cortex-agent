# input:  parsed arm set, task selection, trial seed
# output: bound arm/seed selection, composability refusal, AgentConfig
# pos:    Host arm-selection and Harbor construction boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import MappingProxyType
from typing import Any, cast

from harbor.models.trial.config import AgentConfig

CORTEX_IMPORT_PATH = "cortex_bench_harness:CortexBenchAgent"
VENDOR_AGENTS = frozenset({"claude-code", "pi", "codex"})
VENDOR_CORTEX_FIELDS = frozenset({
    "artifact_inventory_spec", "backend", "coordinator", "orchestration",
    "plugin_dirs", "task_store",
})
IMAGE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
BACKEND_CLI_BINARIES = {"claude": "claude", "pi": "pi"}
# A backend composes only once its per-trial adapter is proven; until then it names the gate that
# owns the proof. Empty is not "everything is allowed": an undeclared backend has no CLI binary
# either, so it still refuses, with the generic wording below.
BACKEND_LIFTING_GATES: dict[str, str] = {}
# A mode composes once the gate that owns its role set has authored one; until then it names that
# gate. `coder-review` left this table when its two variant role sets landed; `manager` has not.
MODE_LIFTING_GATES = {"manager": "gate 6"}
COMPOSABLE_MODES = frozenset({"direct", "coder-review"})
CODER_REVIEW_MODE = "coder-review"
CODER_REVIEW_VARIANTS = frozenset({"audit-retry", "reviewer-fix"})


class ImageDigestUnpinnedError(ValueError):
    reason = "image_digest_unpinned"


class BackendUnsupportedForKindError(ValueError):
    reason = "backend_unsupported_for_kind"


class ArmCompositionUnsupportedError(ValueError):
    reason = "arm_composition_unsupported"


ArmDefinition = Mapping[str, object]
TaskDefinition = Mapping[str, object]


def _freeze(value: object) -> object:
    if isinstance(value, Mapping):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _arm_name(arm: Mapping[str, object]) -> str:
    name = arm.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError("every arm requires a non-empty name")
    return name


def select_arm(arms: Sequence[Mapping[str, object]], arm_name: str) -> ArmDefinition:
    names = [_arm_name(arm) for arm in arms]
    if len(names) != len(set(names)):
        raise ValueError("arm names must be unique")
    matches = [arm for arm in arms if _arm_name(arm) == arm_name]
    if len(matches) != 1:
        raise LookupError(f"arm not found: {arm_name}")
    return cast(ArmDefinition, _freeze(matches[0]))


def _task_id(task: Mapping[str, object]) -> str:
    task_id = task.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("every task requires a non-empty task_id")
    return task_id


def select_task(
    tasks: Sequence[Mapping[str, object]], task_id: str,
) -> TaskDefinition:
    identifiers = [_task_id(task) for task in tasks]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("task ids must be unique")
    matches = [task for task in tasks if _task_id(task) == task_id]
    if len(matches) != 1:
        raise LookupError(f"task not found: {task_id}")
    return cast(TaskDefinition, _freeze(matches[0]))


def require_pinned_image(image_ref: str, image_digest: str) -> tuple[str, str]:
    digest_valid = IMAGE_DIGEST.fullmatch(image_digest) is not None
    if not digest_valid or not image_ref.endswith(f"@{image_digest}"):
        raise ImageDigestUnpinnedError("task image reference must match its sha256 digest")
    return image_ref, image_digest


def _required_text(arm: ArmDefinition, field: str) -> str:
    value = arm.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"arm requires {field}")
    return value


def _common_config(
    arm: ArmDefinition,
    env: Mapping[str, str] | None,
    timeout: float | None,
    setup_timeout: float | None,
    max_timeout: float | None,
    allowed_hosts: Sequence[str],
) -> dict[str, Any]:
    return {
        "model_name": _required_text(arm, "model"),
        "env": dict(env or {}),
        "override_timeout_sec": timeout,
        "override_setup_timeout_sec": setup_timeout,
        "max_timeout_sec": max_timeout,
        "extra_allowed_hosts": list(allowed_hosts),
    }


def _orchestration_mode(arm: ArmDefinition) -> str:
    orchestration = arm.get("orchestration")
    if not isinstance(orchestration, Mapping):
        raise ValueError("cortex arms require orchestration")
    mode = orchestration.get("mode")
    if not isinstance(mode, str) or not mode:
        raise ValueError("cortex arms require orchestration.mode")
    return mode


def arm_backend(arm: ArmDefinition) -> str:
    """The backend that selects the arm's parent role surface and its guard tool namespace."""
    return _required_text(arm, "backend")


def arm_orchestration_mode(arm: ArmDefinition) -> str:
    """The orchestration mode that selects which role set the composer emits."""
    return _orchestration_mode(arm)


def arm_coder_review_variant(arm: ArmDefinition) -> str:
    """The variant that selects the third role slot and the whitelisted child template."""
    orchestration = arm.get("orchestration")
    variant = orchestration.get("coder_review_variant") if isinstance(orchestration, Mapping) else None
    if variant not in CODER_REVIEW_VARIANTS:
        raise ValueError(
            f"arm {_arm_name(arm)} requires orchestration.coder_review_variant"
            f" in {sorted(CODER_REVIEW_VARIANTS)}"
        )
    return cast(str, variant)


def backend_cli_binary(arm: ArmDefinition) -> str:
    backend = arm_backend(arm)
    binary = BACKEND_CLI_BINARIES.get(backend)
    if binary is None:
        gate = BACKEND_LIFTING_GATES.get(backend, "its owning gate")
        raise BackendUnsupportedForKindError(
            f"arm {_arm_name(arm)} backend {backend} is unsupported until {gate} lands"
        )
    return binary


def require_composable_arm(arm: ArmDefinition) -> None:
    if arm.get("kind") != "cortex":
        raise ValueError("Cortex composition requires a Cortex arm")
    backend = _required_text(arm, "backend")
    backend_cli_binary(arm)
    mode = _orchestration_mode(arm)
    if mode not in COMPOSABLE_MODES:
        gate = MODE_LIFTING_GATES.get(mode, "its owning gate")
        raise ArmCompositionUnsupportedError(
            f"arm {_arm_name(arm)} ({backend}, {mode}) composition is unsupported"
            f" until {gate} lands"
        )


def _cortex_kwargs(
    arm: ArmDefinition,
    artifact_dir: Path | str | None,
    manifest: Mapping[str, object] | None,
    trial_seed: Mapping[str, object] | None,
    version: str,
) -> dict[str, object]:
    if artifact_dir is None or manifest is None or trial_seed is None:
        raise ValueError("cortex arms require artifact_dir, manifest, and trial_seed")
    seed_arm = trial_seed.get("arm")
    if not isinstance(seed_arm, Mapping) or seed_arm != arm:
        raise ValueError("trial_seed.arm must equal the selected arm")
    return {
        "artifact_dir": artifact_dir,
        "manifest": dict(manifest),
        "trial_seed": dict(trial_seed),
        "version": version,
    }


def _cortex_config(
    arm: ArmDefinition,
    common: dict[str, Any],
    artifact_dir: Path | str | None,
    manifest: Mapping[str, object] | None,
    trial_seed: Mapping[str, object] | None,
    version: str,
) -> AgentConfig:
    require_composable_arm(arm)
    kwargs = _cortex_kwargs(arm, artifact_dir, manifest, trial_seed, version)
    return AgentConfig(import_path=CORTEX_IMPORT_PATH, kwargs=kwargs, **common)


def _vendor_model(arm: ArmDefinition, vendor_agent: str) -> str:
    model = _required_text(arm, "model")
    if vendor_agent != "pi":
        return model
    provider = _required_text(arm, "provider")
    return f"{provider}/{model}"


def _vendor_config(
    arm: ArmDefinition,
    common: dict[str, Any],
    version: str,
) -> AgentConfig:
    cortex_fields = sorted(VENDOR_CORTEX_FIELDS.intersection(arm))
    if cortex_fields:
        raise ValueError(
            f"vendor baseline cannot declare Cortex composition fields: {cortex_fields}"
        )
    vendor_agent = _required_text(arm, "vendor_agent")
    if vendor_agent not in VENDOR_AGENTS:
        raise ValueError(f"unsupported vendor agent: {vendor_agent}")
    common["model_name"] = _vendor_model(arm, vendor_agent)
    return AgentConfig(name=vendor_agent, kwargs={"version": version}, **common)


def build_agent_config(
    arm: ArmDefinition,
    *,
    cli_version: str,
    artifact_dir: Path | str | None = None,
    manifest: Mapping[str, object] | None = None,
    trial_seed: Mapping[str, object] | None = None,
    env: Mapping[str, str] | None = None,
    override_timeout_sec: float | None = None,
    override_setup_timeout_sec: float | None = None,
    max_timeout_sec: float | None = None,
    extra_allowed_hosts: Sequence[str] = (),
) -> AgentConfig:
    if not cli_version:
        raise ValueError("cli_version must be non-empty")
    common = _common_config(
        arm, env, override_timeout_sec, override_setup_timeout_sec,
        max_timeout_sec, extra_allowed_hosts,
    )
    if arm.get("kind") == "cortex":
        return _cortex_config(
            arm, common, artifact_dir, manifest, trial_seed, cli_version,
        )
    if arm.get("kind") == "vendor-baseline":
        return _vendor_config(arm, common, cli_version)
    raise ValueError("arm kind must be cortex or vendor-baseline")
