# input:  ordered campaign runs, arm/task pins, contrast declarations
# output: deterministic comparison report with explicit telemetry states
# pos:    Host-side comparison provenance and classification builder
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation

from .arms import IMAGE_DIGEST, VENDOR_AGENTS

COMPARISON_REPORT_SCHEMA_VERSION = "cortex-benchmark-comparison-report/1"
DIFFERENCE_CLASSES = frozenset({"bundle-level", "orchestration"})
VENDOR_TELEMETRY_UNAVAILABLE = {
    "status": "unavailable",
    "reason": "not_exposed_by_vendor_runner",
}


def _text(source: Mapping[str, object], field: str, label: str) -> str:
    value = source.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"comparison report must pin {label}.{field}")
    return value


def _positive_int(source: Mapping[str, object], field: str) -> int:
    value = source.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"comparison report must pin a positive limits.{field}")
    return value


def _positive_cost(source: Mapping[str, object]) -> str:
    value = source.get("max_cost_usd")
    if not isinstance(value, str) or not value:
        raise ValueError("comparison report must pin limits.max_cost_usd")
    try:
        parsed = Decimal(value)
    except InvalidOperation as error:
        raise ValueError("comparison report must pin limits.max_cost_usd") from error
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError("comparison report must pin a positive limits.max_cost_usd")
    return value


def _arm_cli(arm: Mapping[str, object], kind: str) -> str:
    if kind == "vendor-baseline":
        cli = _text(arm, "vendor_agent", "arm")
        if cli not in VENDOR_AGENTS:
            raise ValueError(f"unsupported vendor agent: {cli}")
        return cli
    if kind == "cortex":
        return _text(arm, "backend", "arm")
    raise ValueError("comparison report arm kind must be cortex or vendor-baseline")


def _limits(arm: Mapping[str, object]) -> dict[str, object]:
    source = arm.get("limits")
    if not isinstance(source, Mapping):
        raise ValueError("comparison report must pin arm.limits")
    return {
        "wall_clock_seconds": _positive_int(source, "deadline_seconds"),
        "provider_requests": _positive_int(source, "max_provider_requests"),
        "cost_usd": _positive_cost(source),
    }


def _task(run: Mapping[str, object]) -> dict[str, str]:
    source = run.get("task")
    if not isinstance(source, Mapping):
        raise ValueError("comparison report must pin run.task")
    digest = _text(source, "image_digest", "task")
    if IMAGE_DIGEST.fullmatch(digest) is None:
        raise ValueError("comparison report must pin task.image_digest to sha256")
    return {"task_id": _text(source, "task_id", "task"), "image_digest": digest}


def _telemetry(run: Mapping[str, object], kind: str) -> object:
    telemetry = run.get("cortex_telemetry")
    if kind == "vendor-baseline":
        if telemetry is not None:
            raise ValueError("vendor baseline Cortex telemetry must be unavailable")
        return dict(VENDOR_TELEMETRY_UNAVAILABLE)
    if not isinstance(telemetry, Mapping):
        raise ValueError("Cortex runs must provide cortex_telemetry")
    return json.loads(json.dumps(telemetry))


def _build_run(run: Mapping[str, object]) -> dict[str, object]:
    arm = run.get("arm")
    if not isinstance(arm, Mapping):
        raise ValueError("comparison report must pin run.arm")
    kind = _text(arm, "kind", "arm")
    return {
        "run_id": _text(run, "run_id", "run"),
        "arm": _text(arm, "name", "arm"),
        "arm_kind": kind,
        "provider": _text(arm, "provider", "arm"),
        "model": _text(arm, "model", "arm"),
        "cli": {"name": _arm_cli(arm, kind),
                "version": _text(run, "cli_version", "run")},
        "task": _task(run),
        "limits": _limits(arm),
        "cortex_telemetry": _telemetry(run, kind),
    }


def _arm_kinds(runs: Sequence[Mapping[str, object]]) -> dict[str, str]:
    kinds: dict[str, str] = {}
    for run in runs:
        arm_name = str(run["arm"])
        kind = str(run["arm_kind"])
        if arm_name in kinds and kinds[arm_name] != kind:
            raise ValueError(f"comparison arm kind changed within campaign: {arm_name}")
        kinds[arm_name] = kind
    return kinds


def _comparison(
    source: Mapping[str, object], arm_kinds: Mapping[str, str],
) -> dict[str, str]:
    left = _text(source, "left_arm", "comparison")
    right = _text(source, "right_arm", "comparison")
    difference = _text(source, "difference_class", "comparison")
    if left not in arm_kinds or right not in arm_kinds:
        raise ValueError("comparison report comparisons must reference reported arms")
    if difference not in DIFFERENCE_CLASSES:
        raise ValueError("comparison difference_class must be pinned")
    if "vendor-baseline" in {arm_kinds[left], arm_kinds[right]} and difference != "bundle-level":
        raise ValueError("comparisons containing a vendor baseline must be bundle-level")
    return {"left_arm": left, "right_arm": right, "difference_class": difference}


def build_comparison_report(
    *, campaign_id: str, runs: Sequence[Mapping[str, object]],
    comparisons: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    if not campaign_id:
        raise ValueError("comparison report must pin campaign_id")
    built_runs = [_build_run(run) for run in runs]
    if not built_runs:
        raise ValueError("comparison report must pin at least one run")
    run_order = [str(run["run_id"]) for run in built_runs]
    if len(run_order) != len(set(run_order)):
        raise ValueError("comparison report run_id values must be unique")
    arm_kinds = _arm_kinds(built_runs)
    return {
        "schema_version": COMPARISON_REPORT_SCHEMA_VERSION,
        "campaign_id": campaign_id,
        "run_order": run_order,
        "runs": built_runs,
        "comparisons": [_comparison(item, arm_kinds) for item in comparisons],
    }


def render_comparison_report(report: Mapping[str, object]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
