# input:  campaign config, terminal outcomes and proxy exports
# output: path-sanitized campaign result summary
# pos:    Public campaign delivery projection
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import math
import os
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Protocol

from .campaign_config import CampaignConfig, TrialPlan
from .launcher.production_arms import resolve_production_arm

RESULT_SUMMARY_FILENAME = "result-summary.json"
RESULT_SUMMARY_SCHEMA_VERSION = "cortex-bench-campaign-result-summary/4"
PROXY_EXPORT_FILENAME = "proxy-export.json"
_COUNTER_FIELDS = ("requests", "input_tokens", "output_tokens", "cached_tokens")
_REVOCATION_BOOLEAN_FIELDS = ("route_active", "listener_present", "serving_thread_alive")
_REVOCATION_COUNT_FIELDS = ("active_handlers", "body_handlers")


class SummaryOutcome(Protocol):
    plan: TrialPlan
    envelope: Mapping[str, object] | None
    outcome_state: str | None
    verifier_rewards: Mapping[str, int | float] | None
    score_status: str | None


def build_result_summary(
    config: CampaignConfig, outcomes: Sequence[SummaryOutcome],
) -> dict[str, object]:
    return {
        "schema_version": RESULT_SUMMARY_SCHEMA_VERSION,
        "campaign": config.campaign,
        "arms": _arm_matrix(config, outcomes),
        "trials": [_trial_summary(config, outcome) for outcome in outcomes],
    }


def _arm_matrix(
    config: CampaignConfig, outcomes: Sequence[SummaryOutcome],
) -> list[dict[str, object]]:
    """Per arm: how many tasks were scored, and how many were not and why.

    Six hundred trials is not a list a reader can hold. What they need first is the denominator
    each arm actually earned against, which is why `score_status` is counted rather than folded
    into the reward: a task where the provider was down is not a task the agent failed, and
    averaging it in as a zero is how a provider outage becomes a published capability claim.
    """
    matrix: dict[str, dict[str, object]] = {}
    for arm in config.arms:
        matrix[str(arm["name"])] = {
            "arm": arm["name"], "model": arm["model"], "thinking": _thinking(arm),
            "tasks": 0, "reward_total": 0.0, "score_status": {},
        }
    for outcome in outcomes:
        row = matrix.get(outcome.plan.arm_name)
        if row is None:
            continue
        row["tasks"] = int(row["tasks"]) + 1
        status = outcome.score_status or "unreported"
        counts = row["score_status"]
        assert isinstance(counts, dict)
        counts[status] = counts.get(status, 0) + 1
        row["reward_total"] = float(row["reward_total"]) + _reward_total(
            outcome.verifier_rewards)
    for row in matrix.values():
        row["score_status"] = dict(sorted(row["score_status"].items()))
    return list(matrix.values())


def _reward_total(rewards: Mapping[str, int | float] | None) -> float:
    if not rewards:
        return 0.0
    return float(sum(value for value in rewards.values() if isinstance(value, (int, float))))


def render_result_summary(summary: Mapping[str, object]) -> str:
    return json.dumps(summary, indent=2, sort_keys=True) + "\n"


def _trial_summary(
    config: CampaignConfig, outcome: SummaryOutcome,
) -> dict[str, object]:
    arm = outcome.plan.arm
    return {
        "trial_id": outcome.plan.trial_id,
        "task_id": outcome.plan.task.task_id,
        "terminal_state": outcome.outcome_state,
        "score_status": outcome.score_status,
        "verifier_rewards": _rewards(config, outcome.verifier_rewards),
        "counters": _counters(config.trials_dir, outcome),
        "leak_scan": _leak_scan(outcome.envelope),
        "revocation": _revocation(outcome.envelope),
        "cli": _cli_pin(config, arm),
        "model": arm["model"],
        "thinking": _thinking(arm),
        "image_digest": outcome.plan.task.image_digest,
    }


def _rewards(
    config: CampaignConfig, rewards: Mapping[str, int | float] | None,
) -> dict[str, int | float] | None:
    if rewards is None:
        return None
    credentials = _credential_values(config)
    occupied = set(rewards)
    projected: dict[str, int | float] = {}
    for ordinal, (name, value) in enumerate(rewards.items(), start=1):
        key = name
        if _unsafe_reward_name(name, credentials):
            key = _redacted_reward_key(ordinal, occupied | set(projected))
        projected[key] = value
    return projected


def _credential_values(config: CampaignConfig) -> tuple[str, ...]:
    dummy = config.credential.get("dummy_token_ref")
    environment_name = config.proxy.get("credential_env")
    credential = os.environ.get(environment_name) if isinstance(environment_name, str) else None
    return tuple(value for value in (dummy, credential) if isinstance(value, str) and value)


def _unsafe_reward_name(name: str, credentials: Sequence[str]) -> bool:
    return (
        PurePosixPath(name).is_absolute()
        or PureWindowsPath(name).is_absolute()
        or any(credential in name for credential in credentials)
    )


def _redacted_reward_key(ordinal: int, occupied: set[str]) -> str:
    candidate = f"redacted-reward-{ordinal}"
    while candidate in occupied:
        candidate += "-redacted"
    return candidate


def _cli_pin(
    config: CampaignConfig, arm: Mapping[str, object],
) -> dict[str, object]:
    if arm.get("kind") == "vendor-baseline":
        return {"name": arm["vendor_agent"], "version": arm["vendor_cli_version"]}
    return {"name": arm["backend"], "version": config.cli_version}


def _thinking(arm: Mapping[str, object]) -> str | None:
    if arm.get("kind") == "vendor-baseline":
        value = arm.get("thinking")
        return value if isinstance(value, str) else None
    bundle = resolve_production_arm(arm)
    return None if bundle is None else bundle.thinking


def _counters(
    trials_dir: Path, outcome: SummaryOutcome,
) -> dict[str, object]:
    usage = _envelope_section(outcome.envelope, "proxy_usage")
    if usage is None:
        usage = _proxy_export(trials_dir, outcome.plan.trial_id)
    return {field: _counter(usage.get(field)) for field in _COUNTER_FIELDS}


def _counter(value: object) -> object:
    number = _nonnegative_number(value)
    if number is not None:
        return number
    if not isinstance(value, Mapping):
        return None
    status = value.get("status")
    projector = _COUNTER_STATUS_PROJECTORS.get(status) if isinstance(status, str) else None
    return None if projector is None else projector(value)


def _available_counter(value: Mapping[str, object]) -> dict[str, object] | None:
    number = _nonnegative_number(value.get("value"))
    return None if number is None else {"status": "available", "value": number}


def _unavailable_counter(_value: Mapping[str, object]) -> dict[str, object]:
    return {"status": "unavailable"}


_COUNTER_STATUS_PROJECTORS = {
    "available": _available_counter,
    "unavailable": _unavailable_counter,
}


def _nonnegative_number(value: object) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if value >= 0 and math.isfinite(value) else None


def _proxy_export(trials_dir: Path, trial_id: str) -> Mapping[str, object]:
    path = trials_dir / trial_id / "artifacts" / "proxy" / PROXY_EXPORT_FILENAME
    try:
        document = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return {}
    return document if isinstance(document, Mapping) else {}


def _leak_scan(envelope: Mapping[str, object] | None) -> dict[str, bool | None]:
    scan = _envelope_section(envelope, "leak_scan") or {}
    return {"ok": _boolean(scan.get("ok")), "clean": _boolean(scan.get("clean"))}


def _revocation(envelope: Mapping[str, object] | None) -> dict[str, object]:
    source = _envelope_section(envelope, "revocation") or {}
    booleans = {field: _boolean(source.get(field)) for field in _REVOCATION_BOOLEAN_FIELDS}
    counts = {field: _nonnegative_integer(source.get(field)) for field in _REVOCATION_COUNT_FIELDS}
    return {**booleans, **counts}


def _envelope_section(
    envelope: Mapping[str, object] | None, field: str,
) -> Mapping[str, object] | None:
    value = None if envelope is None else envelope.get(field)
    return value if isinstance(value, Mapping) else None


def _boolean(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _nonnegative_integer(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value
