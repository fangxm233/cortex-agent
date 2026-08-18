# input:  one campaign config path (or `-`), through the public cortex-bench CLI
# output: concurrent trial roots, one deterministic comparison report and a structured result
# pos:    Public campaign runner
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The driver owns exactly three policies the trial path does not: which trials run and in what
# order, how many run at once, and the resume rule. It delegates execution to `create_harbor_trial`,
# then validates Harbor completion without imposing a reward threshold; cost comes only from each
# admitted outer envelope, and reporting remains delegated to the existing comparison builder.
#
# Two rules make a campaign resumable and re-runnable without ever paying twice. A trial root that
# already carries a published envelope is READ, never re-armed and never written to; a trial root
# without one is a refusal, because a half-finished trial has no cost this driver may account for
# and no result it may report. Both are decided BEFORE anything is armed, and the refusal names
# every incomplete root at once — over a suite-sized campaign, learning them one run at a time is
# its own failure. Cost is read only from published envelopes: an arm's declared budget is a bound
# on what a trial may spend, never evidence of what it did spend.
#
# CONCURRENCY. Worker `k` holds network slot `k` for the whole campaign and pulls plans off a
# shared queue in declared order. A slot owns one subnet, one gateway and one container address, so
# at most one trial ever uses an address and there is no allocator to race. Outcomes are recorded
# by trial id and re-emitted in DECLARED order, so the result document and the comparison report
# stay byte-deterministic under any interleaving; each outcome carries its own start and finish
# instants, because declared order is no longer the order things happened in.
#
# FAILURE. A trial that fails is a fact about that trial: it is recorded with its reason and the
# campaign continues, because one flake must not cost eighty-eight other measurements. What stops
# a campaign is a host-level fault — a Docker network that leaked, or a slot whose subnet cannot be
# created — and even then in-flight trials are left to reach their own bounded end, since that is
# what runs the ordered teardown that revokes their credential routes and proves the revocation.

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
from pathlib import Path

from .campaign_config import (
    CampaignConfig,
    NetworkSlot,
    TrialPlan,
    load_campaign_config,
    parse_campaign_config,
)
from .host_finalization import OUTER_ENVELOPE_FILENAME, OUTER_ENVELOPE_SCHEMA_VERSION
from .launcher.comparison_report import build_comparison_report, render_comparison_report
from .launcher.trial_admission import create_harbor_trial

CAMPAIGN_RESULT_SCHEMA_VERSION = "cortex-bench-campaign-result/4"
COMPARISON_REPORT_FILENAME = "comparison-report.json"
PROXY_EXPORT_FILENAME = "proxy-export.json"
STATE_COMPLETED = "completed"
STATE_HOST_FAULT = "stopped-after-host-fault"
TRIAL_RAN = "ran"
TRIAL_SKIPPED = "skipped"
TRIAL_FAILED = "failed"
TRIAL_NOT_ARMED = "not-armed"

EPILOG = """Examples:
  cortex-bench run --config benchmark/campaigns/zero-paid-dry-run.yaml
  cortex-bench run --config campaign.yaml --dry-run
  cat campaign.yaml | cortex-bench run --config -

A campaign is resumable: re-running the same config skips every trial root that already
published its outer envelope, so a retry arms nothing and spends nothing.
"""
RUN_DESCRIPTION = """Run one campaign: every declared trial is armed through the production
trial path, up to `concurrency` of them at a time, each on its own slot of the declared address
pool. A trial that fails is recorded and the campaign continues; a host-level fault stops further
arming and leaves in-flight trials to end themselves."""


class CampaignError(RuntimeError):
    """A campaign could not be run to a reportable end."""


class HostFaultError(CampaignError):
    """The campaign's own host state is no longer sound, so no further trial may be armed.

    Distinct from a trial that failed: a failed trial is a measurement about that trial, while a
    leaked Docker network or an unusable slot subnet is a fact about the machine every remaining
    trial would run on.
    """


class TrialCleanupError(HostFaultError):
    """A trial and its mandatory network cleanup both failed."""

    def __init__(self, trial_error: Exception, cleanup_error: Exception) -> None:
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
    requests: int | None = None
    metered_requests: int | None = None
    armed: bool = False
    envelope: Mapping[str, object] | None = None
    envelope_path: Path | None = None
    envelope_sha256: str | None = None
    reason: str | None = None
    slot: int | None = None
    started_at: str | None = None
    finished_at: str | None = None

    @property
    def admission(self) -> Mapping[str, object] | None:
        """What the trial's own envelope said about being gradable, or None if it never ran."""
        admission = (self.envelope or {}).get("grader_admission")
        return admission if isinstance(admission, Mapping) else None

    @property
    def admitted(self) -> bool:
        return (self.admission or {}).get("admitted") is True

    def as_dict(self) -> dict[str, object]:
        record: dict[str, object] = {
            "trial_id": self.plan.trial_id, "arm": self.plan.arm_name,
            "task_id": self.plan.task.task_id, "state": self.state,
        }
        if self.requests is not None:
            record["requests"] = self.requests
        if self.metered_requests is not None:
            record["metered_requests"] = self.metered_requests
        if self.envelope_path is not None:
            record["outer_envelope_path"] = str(self.envelope_path)
        if self.admission is not None:
            record["grader_admission"] = dict(self.admission)
        if self.reason is not None:
            record["reason"] = self.reason
        # The schedule, not the declaration: trials are reported in declared order, so without
        # these three a reader cannot tell which of them actually overlapped.
        for field in ("slot", "started_at", "finished_at"):
            value = getattr(self, field)
            if value is not None:
                record[field] = value
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
    outcomes, fault = asyncio.run(_run_campaign(config, plans))
    report_path, report_sha256 = _write_comparison_report(config, outcomes)
    failed = sum(outcome.state in (TRIAL_FAILED, TRIAL_NOT_ARMED) for outcome in outcomes)
    document: dict[str, object] = {
        # `ok` answers "did this campaign produce the results it declared", which is what a caller
        # gates on. A host fault is not the only way to produce none of them: r5 ran to completion
        # with every trial failing and reported ok, so a caller reading the exit code saw success.
        "ok": fault is None and failed == 0,
        "schema_version": CAMPAIGN_RESULT_SCHEMA_VERSION,
        "campaign": config.campaign,
        "state": STATE_COMPLETED if fault is None else STATE_HOST_FAULT,
        "paid": config.paid, "trials_dir": str(config.trials_dir),
        "concurrency": config.concurrency,
        "trials_failed": failed,
        "provider_requests": _total(outcomes),
        "provider_requests_complete": _total_is_complete(outcomes),
        "cost_usd_note": (
            "Not reported here. The proxy meters requests and tokens, which it observes; turning "
            "those into money needs a price list, and the run's own cache-aware accounting is the "
            "thing that holds one."),
        "trials": [outcome.as_dict() for outcome in outcomes],
        "report_path": None if report_path is None else str(report_path),
        "report_sha256": report_sha256,
        "started_at": started_at, "ended_at": _timestamp(),
    }
    if fault is not None:
        document["fault"] = str(fault)
    return document


async def _run_campaign(
    config: CampaignConfig, plans: Sequence[TrialPlan],
) -> tuple[list[TrialOutcome], HostFaultError | None]:
    """Resume what already ran, then run the rest `concurrency` at a time."""
    schedule = _Schedule(config, plans)
    workers = [
        asyncio.create_task(schedule.work(slot))
        for slot in range(min(config.concurrency, schedule.pending))
    ]
    if workers:
        await asyncio.gather(*workers)
    return schedule.outcomes(), schedule.fault


class _Schedule:
    """One campaign's queue of unrun trials, its slot workers and what they produced.

    Every worker records; none of them raises. A trial's failure belongs in the result document
    beside the trials that succeeded, and a host fault has to stop the OTHER workers rather than
    unwind this one.
    """

    def __init__(self, config: CampaignConfig, plans: Sequence[TrialPlan]) -> None:
        self._config = config
        self._plans = tuple(plans)
        self._recorded: dict[str, TrialOutcome] = {}
        self._queue: asyncio.Queue[TrialPlan] = asyncio.Queue()
        self.fault: HostFaultError | None = None
        for plan, resumed in _partition(config, self._plans):
            if resumed is not None:
                self._recorded[plan.trial_id] = resumed
            else:
                self._queue.put_nowait(plan)

    @property
    def pending(self) -> int:
        return self._queue.qsize()

    def outcomes(self) -> list[TrialOutcome]:
        """Declared order, whatever order the workers finished in."""
        return [
            self._recorded.get(plan.trial_id, TrialOutcome(plan=plan, state=TRIAL_NOT_ARMED))
            for plan in self._plans
        ]

    async def work(self, slot_index: int) -> None:
        slot = self._config.slot(slot_index)
        while self.fault is None:
            try:
                plan = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            self._recorded[plan.trial_id] = await self._run_trial(plan, slot)

    async def _run_trial(self, plan: TrialPlan, slot: NetworkSlot) -> TrialOutcome:
        started_at = _timestamp()
        trial_root = self._config.trials_dir / plan.trial_id
        try:
            await _arm_trial(self._config, plan, slot)
        except HostFaultError as error:
            # The machine, not the trial: stop the other workers before they arm anything else.
            self.fault = self.fault or error
            return self._failed(plan, slot, error, started_at, trial_root)
        except CampaignError as error:
            return self._failed(plan, slot, error, started_at, trial_root)
        return _read_outcome(
            plan, trial_root, TRIAL_RAN, slot=slot.index, started_at=started_at,
            finished_at=_timestamp())

    def _failed(
        self, plan: TrialPlan, slot: NetworkSlot, error: Exception, started_at: str,
        trial_root: Path,
    ) -> TrialOutcome:
        """A trial that failed still spent whatever its proxy metered before it failed."""
        return TrialOutcome(
            plan=plan, state=TRIAL_FAILED, reason=str(error), slot=slot.index,
            started_at=started_at, finished_at=_timestamp(), armed=True,
            metered_requests=_metered_requests(trial_root))


def _partition(
    config: CampaignConfig, plans: Sequence[TrialPlan],
) -> list[tuple[TrialPlan, TrialOutcome | None]]:
    """Decide resume-or-arm for every trial before any of them is armed.

    Refusing every unfinished root at once matters at suite scale: an operator learns which roots
    to move aside in one message, rather than one campaign run per root.
    """
    partitioned: list[tuple[TrialPlan, TrialOutcome | None]] = []
    unfinished: list[Path] = []
    for plan in plans:
        trial_root = config.trials_dir / plan.trial_id
        if not trial_root.exists():
            partitioned.append((plan, None))
        elif (trial_root / "artifacts" / OUTER_ENVELOPE_FILENAME).exists():
            partitioned.append((plan, _read_outcome(plan, trial_root, TRIAL_SKIPPED)))
        else:
            unfinished.append(trial_root)
    if unfinished:
        raise CampaignError(
            f"{len(unfinished)} trial root(s) exist without a published "
            f"{OUTER_ENVELOPE_FILENAME}, so those trials did not finish: "
            f"{', '.join(str(root) for root in unfinished)}. Move them aside to re-run those "
            "trials; this driver never overwrites one")
    return partitioned


async def _arm_trial(config: CampaignConfig, plan: TrialPlan, slot: NetworkSlot) -> None:
    """One trial, through the production trial path and nothing else."""
    network_id = ""
    trial_error: CampaignError | None = None
    try:
        network_id = _create_trial_network(config, plan, slot)
        trial = await create_harbor_trial(
            arm=dict(plan.arm), task_path=plan.task.path, trials_dir=config.trials_dir,
            manifest=config.trial_manifest(plan), trial_seed=config.trial_seed(plan),
            cli_version=config.cli_version, host_scan_policy=dict(config.host_scan_policy),
            trial_proxy=config.slot_proxy(slot),
            agent_timeout_seconds=config.timeouts.get("agent_seconds"),
            verifier_timeout_seconds=config.timeouts.get("verifier_seconds"),
            network=config.network,
        )
        result = await trial.run()
        _require_completed_trial(plan, result)
    except HostFaultError:
        raise
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


def _create_trial_network(
    config: CampaignConfig, plan: TrialPlan, slot: NetworkSlot,
) -> str:
    """This trial's own network, on the subnet its concurrency slot owns.

    Host-level on failure: a slot whose declared subnet cannot be created is a fact about the
    machine and its address space, and every later trial on that slot would meet it again.
    """
    name = f"{plan.trial_id}__env_default"
    command = [
        "docker", "network", "create", "--driver", "bridge",
        "--subnet", slot.subnet, "--gateway", slot.gateway, name,
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode != 0 or not result.stdout.strip():
        raise HostFaultError(
            f"trial {plan.trial_id} could not create Docker network {name} on slot "
            f"{slot.index} ({slot.subnet}): "
            f"{result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def _remove_trial_network(network_id: str) -> None:
    """Host-level on failure: an un-removed network is leaked host state, and its subnet is a
    slot the campaign can no longer use."""
    result = subprocess.run(
        ["docker", "network", "rm", network_id], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise HostFaultError(
            f"could not remove Docker network {network_id}: "
            f"{result.stderr.strip() or result.stdout.strip()}")


def _read_outcome(
    plan: TrialPlan, trial_root: Path, state: str, *, slot: int | None = None,
    started_at: str | None = None, finished_at: str | None = None,
) -> TrialOutcome:
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
    # A published trial's envelope carries the very figure its proxy metered, validated on the way
    # through finalization, so it is the accounting record for that trial and the raw export is
    # only needed for a trial that never got to publish one.
    requests = _envelope_requests(plan, path, envelope)
    return TrialOutcome(
        plan=plan, state=state, requests=requests,
        metered_requests=requests, armed=True,
        envelope=envelope, envelope_path=path,
        envelope_sha256=hashlib.sha256(payload).hexdigest(),
        slot=slot, started_at=started_at, finished_at=finished_at,
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
    """A resumed root is trusted only for the trial it says it is.

    Admission used to be checked here too, and a non-admitted envelope ended the campaign. It is
    now read and carried instead: an inner run that failed is a result about the agent, and the
    reward beside it came from the authentic verifier scoring what the agent actually left
    behind. What still ends a campaign is a harness fault, which never reaches this function —
    it raises during finalization and publishes no envelope at all.
    """
    identity = envelope.get("identity")
    identity = identity if isinstance(identity, Mapping) else {}
    declared = (identity.get("trial_id"), identity.get("arm_name"))
    if declared != (plan.trial_id, plan.arm_name):
        raise CampaignError(
            f"{path} identifies trial {declared[0]!r} on arm {declared[1]!r}, but this campaign "
            f"expects {plan.trial_id!r} on {plan.arm_name!r}")
    admission = envelope.get("grader_admission")
    admitted = admission.get("admitted") if isinstance(admission, Mapping) else None
    if not isinstance(admitted, bool):
        raise CampaignError(
            f"trial {plan.trial_id} published {path} with grader_admission.admitted "
            f"{admitted!r}; an envelope must state whether its result is gradable")


def _envelope_requests(
    plan: TrialPlan, path: Path, envelope: Mapping[str, object],
) -> int:
    usage = envelope.get("proxy_usage")
    value = usage.get("requests") if isinstance(usage, Mapping) else None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CampaignError(
            f"trial {plan.trial_id} published {path} without a proxy_usage.requests "
            "count, so its provider traffic cannot be accounted")
    return value


def _metered_requests(trial_root: Path) -> int | None:
    """What the host's own proxy metered for one trial, whatever became of the trial.

    Read from the proxy export rather than from the outer envelope, because the envelope only
    exists for a trial that was published: the r5 campaign summed envelopes, none of its three
    trials published one, and so it reported spending nothing while $0.70 of provider traffic had
    already gone through its meters. Spend happens at the proxy, before anything decides whether
    the result is gradable, so it has to be accounted from the proxy.
    """
    try:
        export = json.loads(
            (trial_root / "artifacts" / "proxy" / PROXY_EXPORT_FILENAME).read_bytes())
    except (OSError, ValueError):
        return None
    if not isinstance(export, Mapping):
        return None
    field = export.get("requests")
    if not isinstance(field, Mapping) or field.get("status") != "available":
        return None
    value = field.get("value")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _total(outcomes: Sequence[TrialOutcome]) -> int:
    return sum(
        outcome.metered_requests
        for outcome in outcomes if outcome.metered_requests is not None
    )


def _total_is_complete(outcomes: Sequence[TrialOutcome]) -> bool:
    """Whether every trial that was armed contributed a figure to the total.

    A trial that was never armed spent nothing and cannot make the total incomplete; a trial that
    ran and left no readable meter makes the total a floor rather than a sum, and the document has
    to say so instead of letting the missing number read as zero.
    """
    return all(
        outcome.metered_requests is not None for outcome in outcomes if outcome.armed
    )


def _write_comparison_report(
    config: CampaignConfig, outcomes: Sequence[TrialOutcome],
) -> tuple[Path | None, str | None]:
    """The report over every trial that published an envelope, or nothing when none did.

    A campaign whose trials all failed has no runs to compare, and that is a result to report
    rather than a crash on the way to reporting it.
    """
    runs = [_report_run(config, outcome) for outcome in outcomes if outcome.envelope is not None]
    if not runs:
        return None, None
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
            "requests": usage.get("requests"),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "outer_envelope_sha256": outcome.envelope_sha256,
        },
        "grader_admission": dict(outcome.admission) if outcome.admission else None,
    }


def _dry_run_document(
    config: CampaignConfig, plans: Sequence[TrialPlan],
) -> dict[str, object]:
    return {
        "ok": True, "dry_run": True, "schema_version": CAMPAIGN_RESULT_SCHEMA_VERSION,
        "campaign": config.campaign, "paid": config.paid,
        "trials_dir": str(config.trials_dir),
        "concurrency": config.concurrency,
        "slots": [
            {"slot": slot.index, "subnet": slot.subnet, "gateway": slot.gateway,
             "container_ip": slot.container_ip}
            for slot in (config.slot(index) for index in range(config.concurrency))
        ],
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
    """A host fault still publishes its result: the report is the evidence of what did run.

    Only the exit code says the campaign did not complete.
    """
    print(json.dumps(document, sort_keys=True), flush=True)
    return 0 if document.get("ok") else 1
