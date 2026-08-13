# input:  one campaign config path (or `-`), through the public cortex-bench CLI
# output: serial trial roots, one deterministic comparison report and a structured result
# pos:    Public campaign runner
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The driver owns exactly three policies the trial path does not: trial order, the campaign-wide
# cost stop, and the resume rule. It delegates execution to `create_harbor_trial`, then validates
# Harbor completion without imposing a reward threshold; cost comes only from each admitted outer
# envelope, and reporting remains delegated to the existing comparison builder.
#
# Two rules make a campaign resumable and re-runnable without ever paying twice. A trial root that
# already carries a published envelope is READ, never re-armed and never written to; a trial root
# without one is a refusal, because a half-finished trial has no cost this driver may account for
# and no result it may report. Cost is read only from published envelopes: an arm's declared budget
# is a bound on what a trial may spend, never evidence of what it did spend.

import argparse
import asyncio
import hashlib
import json
import math
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .campaign_config import (
    CampaignConfig,
    TrialPlan,
    load_campaign_config,
    parse_campaign_config,
)
from .host_finalization import OUTER_ENVELOPE_FILENAME, OUTER_ENVELOPE_SCHEMA_VERSION
from .launcher.comparison_report import build_comparison_report, render_comparison_report
from .launcher.trial_admission import create_harbor_trial

CAMPAIGN_RESULT_SCHEMA_VERSION = "cortex-bench-campaign-result/1"
COMPARISON_REPORT_FILENAME = "comparison-report.json"
STATE_COMPLETED = "completed"
STATE_COST_CEILING_REACHED = "cost-ceiling-reached"

EPILOG = """Examples:
  cortex-bench run --config benchmark/campaigns/zero-paid-dry-run.yaml
  cortex-bench run --config campaign.yaml --dry-run
  cat campaign.yaml | cortex-bench run --config -

A campaign is resumable: re-running the same config skips every trial root that already
published its outer envelope, so a retry arms nothing and spends nothing.
"""
RUN_DESCRIPTION = """Run one campaign serially: each declared trial is armed through the
production trial path, the cost published in its outer envelope is added to the campaign
total, and no further trial is armed once that total reaches cost_ceiling_usd."""


class CampaignError(RuntimeError):
    """A campaign could not be run to a reportable end."""


class TrialCleanupError(CampaignError):
    """A trial and its mandatory network cleanup both failed."""

    def __init__(self, trial_error: CampaignError, cleanup_error: Exception) -> None:
        self.trial_error = trial_error
        self.cleanup_error = cleanup_error
        super().__init__(
            f"{trial_error}; Docker network cleanup also failed: {cleanup_error}")


class CliInputError(ValueError):
    pass


class StructuredArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CliInputError(f"{self.prog}: {message}")


class HelpFormatter(
    argparse.ArgumentDefaultsHelpFormatter,
    argparse.RawDescriptionHelpFormatter,
):
    pass


@dataclass(frozen=True)
class TrialOutcome:
    plan: TrialPlan
    state: str
    cost_usd: Decimal | None = None
    envelope: Mapping[str, object] | None = None
    envelope_path: Path | None = None
    envelope_sha256: str | None = None

    def as_dict(self) -> dict[str, object]:
        record: dict[str, object] = {
            "trial_id": self.plan.trial_id, "arm": self.plan.arm_name,
            "task_id": self.plan.task.task_id, "state": self.state,
        }
        if self.cost_usd is not None:
            record["cost_usd"] = str(self.cost_usd)
        if self.envelope_path is not None:
            record["outer_envelope_path"] = str(self.envelope_path)
        return record


def build_parser() -> argparse.ArgumentParser:
    parser = StructuredArgumentParser(
        prog="cortex-bench",
        description="Run a declared Cortex benchmark campaign.",
        epilog=EPILOG, formatter_class=HelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", metavar="run")
    run_parser = subparsers.add_parser(
        "run", prog="cortex-bench run", description=RUN_DESCRIPTION,
        help="Run one campaign from a config file",
        epilog=EPILOG, formatter_class=HelpFormatter,
    )
    run_parser.add_argument(
        "--config", required=True,
        help="Campaign YAML path, or - to read the document from stdin",
    )
    run_parser.add_argument(
        "--dry-run", action="store_true",
        help="Validate the config and report the trials that would be armed, arming none",
    )
    return parser


def read_campaign_config(source: str) -> CampaignConfig:
    """Read the campaign document from a path or, for `-`, from stdin against the cwd."""
    if source == "-":
        return parse_campaign_config(
            sys.stdin.read(), base_dir=Path.cwd(), source="<stdin>")
    return load_campaign_config(source)


def run(arguments: argparse.Namespace) -> dict[str, object]:
    config = read_campaign_config(arguments.config)
    plans = config.trials()
    if arguments.dry_run:
        return _dry_run_document(config, plans)
    started_at = _timestamp()
    outcomes, state = asyncio.run(_run_campaign(config, plans))
    report_path, report_sha256 = _write_comparison_report(config, outcomes)
    return {
        "ok": True, "schema_version": CAMPAIGN_RESULT_SCHEMA_VERSION,
        "campaign": config.campaign, "state": state, "paid": config.paid,
        "trials_dir": str(config.trials_dir),
        "cost_ceiling_usd": config.cost_ceiling_text,
        "cost_usd": str(_total(outcomes)),
        "trials": [outcome.as_dict() for outcome in outcomes],
        "report_path": str(report_path), "report_sha256": report_sha256,
        "started_at": started_at, "ended_at": _timestamp(),
    }


async def _run_campaign(
    config: CampaignConfig, plans: Sequence[TrialPlan],
) -> tuple[list[TrialOutcome], str]:
    outcomes: list[TrialOutcome] = []
    for index, plan in enumerate(plans):
        trial_root = config.trials_dir / plan.trial_id
        if trial_root.exists():
            outcomes.append(_resume(plan, trial_root))
            continue
        if _total(outcomes) >= config.cost_ceiling_usd:
            outcomes.extend(
                TrialOutcome(plan=remaining, state="not-armed") for remaining in plans[index:])
            return outcomes, STATE_COST_CEILING_REACHED
        await _arm_trial(config, plan)
        outcomes.append(_read_outcome(plan, trial_root, "ran"))
    return outcomes, STATE_COMPLETED


async def _arm_trial(config: CampaignConfig, plan: TrialPlan) -> None:
    """One trial, through the production trial path and nothing else."""
    network_id = ""
    trial_error: CampaignError | None = None
    try:
        network_id = _create_trial_network(config, plan)
        trial = await create_harbor_trial(
            arm=dict(plan.arm), task_path=plan.task.path, trials_dir=config.trials_dir,
            manifest=config.trial_manifest(plan), trial_seed=config.trial_seed(plan),
            cli_version=config.cli_version, host_scan_policy=dict(config.host_scan_policy),
            trial_proxy=dict(config.proxy),
        )
        result = await trial.run()
        _require_completed_trial(plan, result)
    except CampaignError as error:
        trial_error = error
    except Exception as error:
        trial_error = CampaignError(f"trial {plan.trial_id} failed: {error}")
        trial_error.__cause__ = error
    if network_id:
        try:
            _remove_trial_network(network_id)
        except Exception as cleanup_error:
            if trial_error is not None:
                raise TrialCleanupError(trial_error, cleanup_error) from trial_error
            raise
    if trial_error is not None:
        raise trial_error


def _require_completed_trial(plan: TrialPlan, result: object) -> None:
    exception = getattr(result, "exception_info", None)
    if exception is not None:
        kind = getattr(exception, "exception_type", type(exception).__name__)
        message = getattr(exception, "exception_message", str(exception))
        raise CampaignError(f"trial {plan.trial_id} failed: {kind}: {message}")
    verifier = getattr(result, "verifier_result", None)
    if verifier is None:
        raise CampaignError(f"trial {plan.trial_id} published no verifier result")
    _require_finite_rewards(plan, getattr(verifier, "rewards", None))


def _require_finite_rewards(plan: TrialPlan, rewards: object) -> None:
    if not isinstance(rewards, Mapping) or not rewards:
        raise CampaignError(f"trial {plan.trial_id} published no verifier rewards")
    if any(
        not isinstance(value, (int, float)) or isinstance(value, bool)
        or not math.isfinite(value)
        for value in rewards.values()
    ):
        raise CampaignError(
            f"trial {plan.trial_id} published a non-finite or non-numeric verifier reward")


def _create_trial_network(config: CampaignConfig, plan: TrialPlan) -> str:
    name = f"{plan.trial_id}__env_default"
    command = [
        "docker", "network", "create", "--driver", "bridge",
        "--subnet", str(config.docker_network["subnet"]),
        "--gateway", str(config.docker_network["gateway"]), name,
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode != 0 or not result.stdout.strip():
        raise CampaignError(
            f"trial {plan.trial_id} could not create Docker network {name}: "
            f"{result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def _remove_trial_network(network_id: str) -> None:
    result = subprocess.run(
        ["docker", "network", "rm", network_id], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise CampaignError(
            f"could not remove Docker network {network_id}: "
            f"{result.stderr.strip() or result.stdout.strip()}")


def _resume(plan: TrialPlan, trial_root: Path) -> TrialOutcome:
    """An existing trial root is evidence, not workspace: read it, never write into it."""
    if not (trial_root / "artifacts" / OUTER_ENVELOPE_FILENAME).exists():
        raise CampaignError(
            f"trial root {trial_root} exists without a published "
            f"{OUTER_ENVELOPE_FILENAME}: trial {plan.trial_id} did not finish. Move that "
            "root aside to re-run the trial; this driver never overwrites one")
    return _read_outcome(plan, trial_root, "skipped")


def _read_outcome(plan: TrialPlan, trial_root: Path, state: str) -> TrialOutcome:
    _require_published_success(plan, trial_root)
    path = trial_root / "artifacts" / OUTER_ENVELOPE_FILENAME
    try:
        payload = path.read_bytes()
        envelope = json.loads(payload)
    except (OSError, ValueError) as error:
        raise CampaignError(
            f"trial {plan.trial_id} published an unreadable {path}: {error}") from error
    if not isinstance(envelope, Mapping):
        raise CampaignError(f"trial {plan.trial_id} published a non-mapping {path}")
    if envelope.get("schema_version") != OUTER_ENVELOPE_SCHEMA_VERSION:
        raise CampaignError(
            f"trial {plan.trial_id} published {path} with schema_version "
            f"{envelope.get('schema_version')!r}; this driver reads "
            f"{OUTER_ENVELOPE_SCHEMA_VERSION}")
    _validate_identity(plan, path, envelope)
    return TrialOutcome(
        plan=plan, state=state, cost_usd=_envelope_cost(plan, path, envelope),
        envelope=envelope, envelope_path=path,
        envelope_sha256=hashlib.sha256(payload).hexdigest(),
    )


def _require_published_success(plan: TrialPlan, trial_root: Path) -> None:
    path = trial_root / "result.json"
    try:
        result = json.loads(path.read_bytes())
    except (OSError, ValueError) as error:
        raise CampaignError(
            f"trial {plan.trial_id} published no readable Harbor result {path}: {error}") from error
    if not isinstance(result, Mapping):
        raise CampaignError(f"trial {plan.trial_id} published a non-mapping {path}")
    exception = result.get("exception_info")
    if exception is not None:
        kind = exception.get("exception_type") if isinstance(exception, Mapping) else "unknown"
        message = exception.get("exception_message") if isinstance(exception, Mapping) else exception
        raise CampaignError(f"trial {plan.trial_id} failed: {kind}: {message}")
    verifier = result.get("verifier_result")
    rewards = verifier.get("rewards") if isinstance(verifier, Mapping) else None
    _require_finite_rewards(plan, rewards)


def _validate_identity(
    plan: TrialPlan, path: Path, envelope: Mapping[str, object],
) -> None:
    """A resumed root is trusted only for the trial it says it is, and only if it was admitted."""
    identity = envelope.get("identity")
    identity = identity if isinstance(identity, Mapping) else {}
    declared = (identity.get("trial_id"), identity.get("arm_name"))
    if declared != (plan.trial_id, plan.arm_name):
        raise CampaignError(
            f"{path} identifies trial {declared[0]!r} on arm {declared[1]!r}, but this campaign "
            f"expects {plan.trial_id!r} on {plan.arm_name!r}")
    admission = envelope.get("grader_admission")
    admitted = admission.get("admitted") if isinstance(admission, Mapping) else None
    if admitted is not True:
        raise CampaignError(
            f"trial {plan.trial_id} published {path} with grader_admission.admitted "
            f"{admitted!r}; only an admitted trial is counted or reported")


def _envelope_cost(
    plan: TrialPlan, path: Path, envelope: Mapping[str, object],
) -> Decimal:
    usage = envelope.get("proxy_usage")
    value = usage.get("cost_usd") if isinstance(usage, Mapping) else None
    if not isinstance(value, str):
        raise CampaignError(
            f"trial {plan.trial_id} published {path} without a proxy_usage.cost_usd "
            "decimal string, so its spend cannot be accounted")
    try:
        cost = Decimal(value)
    except InvalidOperation as error:
        raise CampaignError(
            f"trial {plan.trial_id} published proxy_usage.cost_usd {value!r}, "
            "which is not a decimal") from error
    if not cost.is_finite() or cost < 0:
        raise CampaignError(
            f"trial {plan.trial_id} published a negative or non-finite "
            f"proxy_usage.cost_usd {value!r}")
    return cost


def _total(outcomes: Sequence[TrialOutcome]) -> Decimal:
    return sum(
        (outcome.cost_usd for outcome in outcomes if outcome.cost_usd is not None),
        Decimal(0),
    )


def _write_comparison_report(
    config: CampaignConfig, outcomes: Sequence[TrialOutcome],
) -> tuple[Path, str]:
    runs = [_report_run(config, outcome) for outcome in outcomes if outcome.envelope is not None]
    report = build_comparison_report(
        campaign_id=config.campaign, runs=runs, comparisons=[dict(item) for item in _reported(
            config.comparisons, runs)],
    )
    payload = render_comparison_report(report).encode()
    path = config.trials_dir / COMPARISON_REPORT_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path, hashlib.sha256(payload).hexdigest()


def _reported(
    comparisons: Sequence[Mapping[str, object]], runs: Sequence[Mapping[str, object]],
) -> list[Mapping[str, object]]:
    """A comparison whose arm never ran is dropped rather than reported as a contrast."""
    reported = {str(run["arm"]["name"]) for run in runs}
    return [
        comparison for comparison in comparisons
        if {comparison["left_arm"], comparison["right_arm"]} <= reported
    ]


def _report_run(config: CampaignConfig, outcome: TrialOutcome) -> dict[str, object]:
    envelope = outcome.envelope or {}
    usage = envelope.get("proxy_usage")
    usage = usage if isinstance(usage, Mapping) else {}
    identity = envelope.get("identity")
    identity = identity if isinstance(identity, Mapping) else {}
    return {
        "run_id": outcome.plan.trial_id, "arm": dict(outcome.plan.arm),
        "cli_version": config.cli_version,
        "task": {"task_id": outcome.plan.task.task_id,
                 "image_digest": outcome.plan.task.image_digest},
        "cortex_telemetry": {
            "trial_id": outcome.plan.trial_id,
            "root_run_id": identity.get("root_run_id"),
            "cost_usd": usage.get("cost_usd"), "requests": usage.get("requests"),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "outer_envelope_sha256": outcome.envelope_sha256,
        },
    }


def _dry_run_document(
    config: CampaignConfig, plans: Sequence[TrialPlan],
) -> dict[str, object]:
    return {
        "ok": True, "dry_run": True, "schema_version": CAMPAIGN_RESULT_SCHEMA_VERSION,
        "campaign": config.campaign, "paid": config.paid,
        "trials_dir": str(config.trials_dir),
        "cost_ceiling_usd": config.cost_ceiling_text,
        "report_path": str(config.trials_dir / COMPARISON_REPORT_FILENAME),
        "trials": [
            {"trial_id": plan.trial_id, "arm": plan.arm_name,
             "task_id": plan.task.task_id,
             "state": "would-skip" if (config.trials_dir / plan.trial_id).exists()
                      else "would-arm"}
            for plan in plans
        ],
    }


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    if arguments.command is None:
        raise CliInputError("cortex-bench: no command given. Available commands: run")
    return arguments


def main(argv: Sequence[str] | None = None) -> int:
    try:
        return _emit(run(_parse(argv)))
    # ValueError covers the CLI, config and comparison-report refusals; every one of them is an
    # operator-fixable input, so it is reported as structured output rather than a traceback.
    except (ValueError, CampaignError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1


def _emit(document: Mapping[str, object]) -> int:
    print(json.dumps(document, sort_keys=True), flush=True)
    return 0
