# input:  ordered comparison runs, contrasts, and Cortex telemetry
# output: frozen report pins, contrast classes, unavailable baselines
# pos:    Contract tests for comparable benchmark reporting
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json

import pytest

from cortex_bench_harness.launcher.comparison_report import (
    build_comparison_report,
    render_comparison_report,
)


DIGEST = f"sha256:{'a' * 64}"
LIMITS = {
    "max_thread_starts": 1,
    "max_parent_questions": 0,
    "max_task_depth": 1,
    "max_tasks": 2,
    "max_provider_requests": 8,
    "max_resident_agent_processes": 3,
    "max_cost_usd": "2.50",
    "deadline_seconds": 90,
}
UNAVAILABLE = {
    "status": "unavailable",
    "reason": "not_exposed_by_vendor_runner",
}


def arm(name: str, kind: str, selector: str) -> dict[str, object]:
    value: dict[str, object] = {
        "kind": kind,
        "name": name,
        "provider": "anthropic",
        "model": "claude-sonnet",
        "limits": LIMITS,
    }
    value["vendor_agent" if kind == "vendor-baseline" else "backend"] = selector
    return value


def run(
    run_id: str, arm_value: dict[str, object], cli_version: str,
    telemetry: object | None = None,
) -> dict[str, object]:
    value: dict[str, object] = {
        "run_id": run_id,
        "arm": arm_value,
        "task": {"task_id": "terminal-task", "image_digest": DIGEST},
        "cli_version": cli_version,
    }
    if telemetry is not None:
        value["cortex_telemetry"] = telemetry
    return value


def expected_run(
    run_id: str, name: str, kind: str, cli: str, telemetry: object,
) -> dict[str, object]:
    return {
        "run_id": run_id, "arm": name, "arm_kind": kind,
        "provider": "anthropic", "model": "claude-sonnet",
        "cli": {"name": cli, "version": "1.2.3"},
        "task": {"task_id": "terminal-task", "image_digest": DIGEST},
        "limits": {"wall_clock_seconds": 90, "provider_requests": 8,
                   "cost_usd": "2.50"},
        "cortex_telemetry": telemetry,
    }


def test_report_pins_inputs_order_and_difference_classes() -> None:
    available = {"status": "available", "value": {"thread_starts": 0}}
    comparisons = [
        {"left_arm": "pure-claude-code", "right_arm": "cortex-direct",
         "difference_class": "bundle-level"},
        {"left_arm": "cortex-direct", "right_arm": "cortex-manager",
         "difference_class": "orchestration"},
    ]
    report = build_comparison_report(
        campaign_id="campaign-001",
        runs=[run("run-vendor", arm("pure-claude-code", "vendor-baseline", "claude-code"), "1.2.3"),
              run("run-manager", arm("cortex-manager", "cortex", "claude"), "1.2.3", available),
              run("run-direct", arm("cortex-direct", "cortex", "claude"), "1.2.3", available)],
        comparisons=comparisons,
    )

    assert report == {
        "schema_version": "cortex-benchmark-comparison-report/1",
        "campaign_id": "campaign-001",
        "run_order": ["run-vendor", "run-manager", "run-direct"],
        "runs": [expected_run("run-vendor", "pure-claude-code", "vendor-baseline", "claude-code", UNAVAILABLE),
                 expected_run("run-manager", "cortex-manager", "cortex", "claude", available),
                 expected_run("run-direct", "cortex-direct", "cortex", "claude", available)],
        "comparisons": comparisons,
    }
    assert render_comparison_report(report) == json.dumps(
        report, indent=2, sort_keys=True,
    ) + "\n"


@pytest.mark.parametrize(("vendor", "provider", "model"), [
    ("claude-code", "anthropic", "claude-sonnet"),
    ("pi", "openai", "gpt-5"),
    ("codex", "openai", "gpt-5"),
])
def test_each_vendor_reports_native_cli_and_unavailable_cortex_telemetry(
    vendor: str, provider: str, model: str,
) -> None:
    vendor_arm = arm(f"pure-{vendor}", "vendor-baseline", vendor)
    vendor_arm.update({"provider": provider, "model": model})

    report = build_comparison_report(
        campaign_id="campaign-001",
        runs=[run(f"run-{vendor}", vendor_arm, "1.2.3")],
        comparisons=[],
    )

    assert report["runs"][0]["cli"] == {"name": vendor, "version": "1.2.3"}
    assert report["runs"][0]["cortex_telemetry"] == UNAVAILABLE


def test_vendor_comparison_cannot_be_labeled_as_orchestration() -> None:
    vendor = arm("pure-codex", "vendor-baseline", "codex")
    direct = arm("cortex-direct", "cortex", "claude")
    available = {"status": "available", "value": {"thread_starts": 0}}

    with pytest.raises(ValueError, match="bundle-level"):
        build_comparison_report(
            campaign_id="campaign-001",
            runs=[run("vendor", vendor, "1.2.3"),
                  run("direct", direct, "1.2.3", available)],
            comparisons=[
                {"left_arm": "pure-codex", "right_arm": "cortex-direct",
                 "difference_class": "orchestration"},
            ],
        )


@pytest.mark.parametrize(("path", "replacement"), [
    (("arm", "provider"), None),
    (("arm", "model"), ""),
    (("cli_version",), ""),
    (("task", "image_digest"), "latest"),
    (("arm", "limits", "deadline_seconds"), 0),
    (("arm", "limits", "max_provider_requests"), 0),
    (("arm", "limits", "max_cost_usd"), "0"),
])
def test_report_rejects_unpinned_comparison_inputs(
    path: tuple[str, ...], replacement: object,
) -> None:
    run_value = run(
        "direct", arm("cortex-direct", "cortex", "claude"), "1.2.3",
        {"status": "available", "value": {}},
    )
    target = run_value
    for key in path[:-1]:
        target = target[key]  # type: ignore[assignment,index]
    target[path[-1]] = replacement

    with pytest.raises(ValueError, match="pin"):
        build_comparison_report(
            campaign_id="campaign-001", runs=[run_value], comparisons=[],
        )
