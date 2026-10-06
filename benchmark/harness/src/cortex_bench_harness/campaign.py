#
# The driver owns exactly three policies the trial path does not: which trials run and in what
# order, how many run at once, and the resume rule. It delegates execution to `create_harbor_trial`,
# then reads Harbor's result and the host envelope into one terminal outcome. Reporting remains
# delegated to the comparison builder.
#
# RESUME. Every existing root is classified BEFORE anything is armed. A terminal root -- success,
# failure or security failure, anything that published an outer envelope -- is read without being
# written again, so a re-run spends nothing on it. A harness-incomplete root (a trial that died
# before it could publish) is moved aside to a sibling named `<trial>.harness-incomplete-<UTC>` --
# renamed, never deleted, since it is the only evidence of what that attempt spent -- and only
# that trial is armed again. What every set-aside attempt metered stays in the campaign's
# request total, and one with no readable meter marks that total incomplete. `--dry-run` makes
# the same classification and reports it.
#
# CONCURRENCY. Worker `k` holds network slot `k` for the whole campaign and pulls plans off a
# shared queue in declared order. A slot owns one subnet, one gateway and one container address, so
# at most one trial ever uses an address and there is no allocator to race. Outcomes are recorded
# by trial id and re-emitted in DECLARED order, so the result document and the comparison report
# stay byte-deterministic under any interleaving; each outcome carries its own start and finish
# instants, because declared order is no longer the order things happened in. Docker calls block
# for up to 30 s, so they run in a worker thread rather than on the loop every trial shares.
#
# FAILURE. A trial that fails is a fact about that trial: it is recorded with its reason and the
# campaign continues, because one flake must not cost eighty-eight other measurements -- and that
# includes a defect in this driver while it handles one trial. What stops a campaign is a
# host-level fault -- a Docker network that leaked, or a slot whose subnet cannot be created --
# and even then in-flight trials are left to reach their own bounded end, since that is what runs
# the ordered teardown that revokes their credential routes and proves the revocation.

import argparse
import asyncio
import contextlib
import hashlib
import json
import sys
import time
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

from .campaign_config import (
    CampaignConfig,
    NetworkSlot,
    TrialPlan,
    load_campaign_config,
    parse_campaign_config,
)
from .campaign_progress import PROGRESS_FILENAME, CampaignProgress, _timestamp
from .external_corpus import ExternalCorpusError, stage_task_input
from .host_finalization import OUTER_ENVELOPE_FILENAME
from .launcher import codex_preflight
from .launcher.codex_preflight import CodexPreflightRefused
from .launcher.comparison_report import build_comparison_report, render_comparison_report
from .launcher.host_credential_vault import HOST_TOKEN_HOLDERS
from .launcher.lease_bound import SETUP_TIMEOUT_MS, TEARDOWN_GRACE_MS
from .launcher.trial_admission import create_harbor_trial
from .launcher.trial_admission_io import cpuset_for_slot
from .launcher.trial_proxy import CapabilityStateRefused, require_capability_admission
from .result_summary import (
    PROXY_EXPORT_FILENAME,
    RESULT_SUMMARY_FILENAME,
    build_result_summary,
    render_result_summary,
)
from .outcome import (
    HARNESS_INCOMPLETE,
    SCORE_AVAILABLE,
    SCORE_UNAVAILABLE,
    TrialOutcomeReader,
)
from .trial_network import (
    NETWORK_CREATE_TIMEOUT_MS,
    TrialNetworkError,
    create_trial_network,
    remove_trial_network,
)

CAMPAIGN_RESULT_SCHEMA_VERSION = "cortex-bench-campaign-result/6"
CAMPAIGN_RESULT_FILENAME = "campaign-result.json"
COMPARISON_REPORT_FILENAME = "comparison-report.json"
STATE_COMPLETED = "completed"
STATE_HOST_FAULT = "stopped-after-host-fault"
TRIAL_RAN = "ran"
TRIAL_SKIPPED = "skipped"
TRIAL_FAILED = "failed"
TRIAL_NOT_ARMED = "not-armed"
MOVED_ASIDE_MARKER = "harness-incomplete"
# Every blocking host call a trial makes from the event loop goes through this, so a Docker CLI
# that takes its full timeout stalls one trial rather than every trial in flight.
_off_loop = asyncio.to_thread

EPILOG = """Examples:
  cortex-bench run --config benchmark/campaigns/zero-paid-dry-run.yaml
  cortex-bench run --config campaign.yaml --dry-run
  cat campaign.yaml | cortex-bench run --config -

A campaign is resumable. Re-running the same config reads every terminal trial root, including
failures that published an outer envelope, and arms nothing for them. A trial root left
harness-incomplete is moved aside to <trial>.harness-incomplete-<UTC> (never deleted) and only that
trial is armed again. --dry-run reports which of the three each trial would get.
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


class TrialNetworkUnavailable(HostFaultError):
    """A trial's network could not be created, so nothing of that trial was armed."""


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
    #: Whether anything of this trial was armed, and so whether it may have spent. A trial refused
    #: before its network existed, or never reached, spent nothing.
    armed: bool = False
    envelope: Mapping[str, object] | None = None
    envelope_path: Path | None = None
    envelope_sha256: str | None = None
    outcome_state: str | None = None
    verifier_rewards: Mapping[str, int | float] | None = None
    score_status: str | None = None
    reason: str | None = None
    slot: int | None = None
    started_at: str | None = None
    finished_at: str | None = None
    #: The harness-incomplete root an earlier run left, which this run moved aside.
    moved_aside: Mapping[str, object] | None = None
    #: Every set-aside root of this trial on disk -- this run's move and any earlier one -- with
    #: what its proxy metered. Those attempts reached the provider, so their spend is the
    #: campaign's spend even though nothing of them is graded.
    set_aside_attempts: tuple[Mapping[str, object], ...] = ()

    def as_dict(self) -> dict[str, object]:
        record: dict[str, object] = {
            "trial_id": self.plan.trial_id, "arm": self.plan.arm_name,
            "task_id": self.plan.task.task_id, "state": self.state,
        }
        if self.plan.trial_id_was_shortened:
            # A shortened id is still the whole identity; the reader should be able to see the
            # campaign-task-arm triple it was cut from without recomputing the hash.
            record["declared_trial_id"] = self.plan.declared_trial_id
        if self.requests is not None:
            record["requests"] = self.requests
        if self.metered_requests is not None:
            record["metered_requests"] = self.metered_requests
        if self.envelope_path is not None:
            record["outer_envelope_path"] = str(self.envelope_path)
        if self.outcome_state is not None:
            record["outcome_state"] = self.outcome_state
            record["verifier_rewards"] = (
                None if self.verifier_rewards is None else dict(self.verifier_rewards))
            record["score_status"] = self.score_status
        if self.reason is not None:
            record["reason"] = self.reason
        if self.moved_aside is not None:
            record["moved_aside"] = dict(self.moved_aside)
        if self.set_aside_attempts:
            record["set_aside_attempts"] = [dict(attempt) for attempt in self.set_aside_attempts]
        # The schedule, not the declaration: trials are reported in declared order, so without
        # these three a reader cannot tell which of them actually overlapped.
        for field in ("slot", "started_at", "finished_at"):
            value = getattr(self, field)
            if value is not None:
                record[field] = value
        return record


@dataclass(frozen=True)
class _Resume:
    """What the campaign does with one declared trial, decided before anything is armed."""

    plan: TrialPlan
    #: A terminal root, read as it is and never armed again.
    terminal: TrialOutcome | None = None
    #: Why an existing root is harness-incomplete: it is moved aside and the trial armed again.
    incomplete: str | None = None

    @property
    def arms(self) -> bool:
        return self.terminal is None


@dataclass(frozen=True)
class _Preflight:
    """The credential checks a campaign passes before it arms anything."""

    refusal: str | None = None
    codex_trials: int = 0
    codex_expires_at_ms: int | None = None
    codex_can_refresh: bool = False

    def report(self) -> dict[str, object]:
        report: dict[str, object] = {
            "status": "refused" if self.refusal else "passed",
            "codex_trials": self.codex_trials,
        }
        if self.refusal:
            report["reason"] = self.refusal
        if self.codex_expires_at_ms is not None:
            report["codex_access_expires_at"] = datetime.fromtimestamp(
                self.codex_expires_at_ms / 1000, UTC).isoformat().replace("+00:00", "Z")
            report["codex_can_refresh"] = self.codex_can_refresh
        return report


@dataclass(frozen=True)
class _CodexAccess:
    """What each Codex route is armed with: the host token's expiry, and the handle of the shared
    token holder when the campaign can refresh."""

    expires_at_ms: int
    can_refresh: bool
    token_holder: str | None = None


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
        help=("Validate the config, run the credential preflight, and report what the run would "
              "do with each trial root, arming and writing nothing"),
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
    resumes = _resume(config, config.trials())
    preflight = _preflight(config, [resume.plan for resume in resumes if resume.arms])
    if arguments.dry_run:
        return _dry_run_document(config, resumes, preflight)
    if preflight.refusal is not None:
        raise CampaignError(preflight.refusal)
    started_at = _timestamp()
    task_inputs = _stage_task_inputs(config)
    moved = _move_incomplete_roots_aside(config, resumes)
    attempts = _set_aside_attempts(config, resumes)
    with _codex_access(config, preflight) as codex:
        outcomes, fault = asyncio.run(_run_campaign(config, resumes, moved, task_inputs, codex))
    outcomes = [
        replace(outcome, set_aside_attempts=attempts[outcome.plan.trial_id])
        if outcome.plan.trial_id in attempts else outcome
        for outcome in outcomes
    ]
    report_path, report_sha256 = _write_comparison_report(config, outcomes)
    failed = sum(outcome.state in (TRIAL_FAILED, TRIAL_NOT_ARMED) for outcome in outcomes)
    document: dict[str, object] = {
        "ok": fault is None and failed == 0,
        "schema_version": CAMPAIGN_RESULT_SCHEMA_VERSION, "campaign": config.campaign,
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
    _write_delivery_artifacts(config, outcomes, document)
    return document


def _stage_task_inputs(config: CampaignConfig) -> dict[str, Path]:
    """Give every task the Harbor input directory it will be admitted from.

    A committed task is already that directory and is used where it lies. An external corpus task
    is not: it carries its own Dockerfile, README and solution, and it names its image by tag. It
    is staged once per campaign — not once per trial, since the directory is read-only input that
    every arm shares — into a sibling of `trials_dir`, which is deliberately NOT inside it:
    admission refuses a task input that overlaps the trials root, because that is how one trial
    would end up reading another's output.
    """
    staged: dict[str, Path] = {}
    root = config.trials_dir.parent / f"{config.campaign}-task-inputs"
    for task in config.tasks:
        if task.origin != "external":
            staged[task.task_id] = task.path
            continue
        try:
            staged[task.task_id] = stage_task_input(
                task.path, root / task.task_id, task.image_ref)
        except (ExternalCorpusError, OSError) as error:
            raise HostFaultError(
                f"cannot stage external task {task.task_id} from {task.path}: {error}") from error
    return staged


async def _run_campaign(
    config: CampaignConfig, resumes: Sequence[_Resume],
    moved: Mapping[str, Mapping[str, object]], task_inputs: Mapping[str, Path],
    codex: _CodexAccess | None,
) -> tuple[list[TrialOutcome], HostFaultError | None]:
    """Report what already ran, then run the rest `concurrency` at a time."""
    schedule = _Schedule(config, resumes, moved, task_inputs, codex)
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

    def __init__(
        self, config: CampaignConfig, resumes: Sequence[_Resume],
        moved: Mapping[str, Mapping[str, object]], task_inputs: Mapping[str, Path],
        codex: _CodexAccess | None,
    ) -> None:
        self._config = config
        self._plans = tuple(resume.plan for resume in resumes)
        self._moved = dict(moved)
        self._task_inputs = dict(task_inputs)
        self._codex = codex
        self._recorded: dict[str, TrialOutcome] = {}
        self._queue: asyncio.Queue[TrialPlan] = asyncio.Queue()
        self.fault: HostFaultError | None = None
        self._progress = CampaignProgress(
            config.trials_dir / PROGRESS_FILENAME, config.campaign, _timestamp())
        for resume in resumes:
            plan = resume.plan
            self._progress.declare(
                plan.trial_id, plan.task.task_id, plan.arm_name, not resume.arms)
            if resume.terminal is not None:
                self._recorded[plan.trial_id] = resume.terminal
            else:
                self._queue.put_nowait(plan)
        self._progress.flush()

    @property
    def pending(self) -> int:
        return self._queue.qsize()

    def outcomes(self) -> list[TrialOutcome]:
        """Declared order, whatever order the workers finished in."""
        outcomes = [
            self._recorded.get(plan.trial_id, TrialOutcome(plan=plan, state=TRIAL_NOT_ARMED))
            for plan in self._plans
        ]
        return [
            replace(outcome, moved_aside=self._moved[outcome.plan.trial_id])
            if outcome.plan.trial_id in self._moved else outcome
            for outcome in outcomes
        ]

    async def work(self, slot_index: int) -> None:
        slot = self._config.slot(slot_index)
        while self.fault is None:
            try:
                plan = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            started_at = _timestamp()
            try:
                self._progress.started(plan.trial_id, slot.index, started_at)
                outcome = await self._trial(plan, slot, started_at)
            except Exception as error:
                # A defect in this driver while it handled one trial is that trial's failure. It
                # must not unwind the worker, which would cancel the other trials mid-teardown.
                outcome = self._failed(
                    plan, slot, CampaignError(
                        f"trial {plan.trial_id} failed in the campaign driver: {error!r}"),
                    started_at, armed=True)
            self._recorded[plan.trial_id] = self._record(outcome)

    async def _trial(
        self, plan: TrialPlan, slot: NetworkSlot, started_at: str,
    ) -> TrialOutcome:
        refusal = _codex_trial_refusal(self._config, plan, self._codex)
        if refusal is not None:
            return self._failed(plan, slot, CampaignError(refusal), started_at, armed=False)
        try:
            await _arm_trial(
                self._config, plan, slot, self._codex, self._task_inputs[plan.task.task_id])
        except TrialNetworkUnavailable as error:
            self.fault = self.fault or error
            return self._failed(plan, slot, error, started_at, armed=False)
        except HostFaultError as error:
            # The machine, not the trial: stop the other workers before they arm anything else.
            self.fault = self.fault or error
            return self._failed(plan, slot, error, started_at, armed=True)
        except CampaignError as error:
            return self._failed(plan, slot, error, started_at, armed=True)
        return _read_outcome(
            plan, self._config.trials_dir / plan.trial_id, TRIAL_RAN, slot=slot.index,
            started_at=started_at, finished_at=_timestamp())

    def _record(self, outcome: TrialOutcome) -> TrialOutcome:
        try:
            self._progress.finished(
                outcome.plan.trial_id,
                failed=outcome.state in (TRIAL_FAILED, TRIAL_NOT_ARMED),
                score_status=outcome.score_status, reason=outcome.reason,
                finished_at=outcome.finished_at or _timestamp(),
            )
        except Exception:
            # The progress file is a view for a human; the outcome is the record.
            pass
        return outcome

    def _failed(
        self, plan: TrialPlan, slot: NetworkSlot, error: Exception, started_at: str,
        *, armed: bool,
    ) -> TrialOutcome:
        """A trial that failed still spent whatever its proxy metered before it failed."""
        trial_root = self._config.trials_dir / plan.trial_id
        return TrialOutcome(
            plan=plan, state=TRIAL_FAILED, outcome_state=HARNESS_INCOMPLETE,
            verifier_rewards=None, score_status=SCORE_UNAVAILABLE,
            reason=str(error), slot=slot.index, started_at=started_at,
            finished_at=_timestamp(), armed=armed,
            metered_requests=_metered_requests(trial_root) if armed else None)


def _resume(config: CampaignConfig, plans: Sequence[TrialPlan]) -> list[_Resume]:
    """Classify every declared trial's existing root, reading and writing nothing else."""
    resumes: list[_Resume] = []
    for plan in plans:
        trial_root = config.trials_dir / plan.trial_id
        if not (trial_root.exists() or trial_root.is_symlink()):
            resumes.append(_Resume(plan))
            continue
        outcome = _read_outcome(plan, trial_root, TRIAL_SKIPPED)
        if outcome.outcome_state == HARNESS_INCOMPLETE:
            resumes.append(_Resume(plan, incomplete=outcome.reason or "harness-incomplete"))
        else:
            resumes.append(_Resume(plan, terminal=outcome))
    return resumes


def _move_incomplete_roots_aside(
    config: CampaignConfig, resumes: Sequence[_Resume],
) -> dict[str, dict[str, object]]:
    """Rename every harness-incomplete root out of its trial's way, before anything is armed.

    Renamed and never deleted: the root is the only record of what that attempt metered. A root
    that cannot be moved stops the campaign here, while nothing has been armed yet.
    """
    moved: dict[str, dict[str, object]] = {}
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    for resume in resumes:
        if resume.incomplete is None:
            continue
        trial_root = config.trials_dir / resume.plan.trial_id
        try:
            target = _move_aside(trial_root, stamp)
        except OSError as error:
            raise CampaignError(
                f"cannot move harness-incomplete trial root {trial_root} aside: {error}"
            ) from error
        moved[resume.plan.trial_id] = {"path": str(target), "reason": resume.incomplete}
    return moved


def _set_aside_attempts(
    config: CampaignConfig, resumes: Sequence[_Resume],
) -> dict[str, tuple[dict[str, object], ...]]:
    """Every set-aside root on disk, by trial, with what its proxy metered (None if unreadable).

    Found by name rather than remembered from the move, so a re-run after the trial finally
    published still counts the attempts an earlier run set aside.
    """
    try:
        names = sorted(entry.name for entry in config.trials_dir.iterdir())
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise CampaignError(
            f"cannot list {config.trials_dir} for set-aside trial roots: {error}") from error
    attempts: dict[str, tuple[dict[str, object], ...]] = {}
    for resume in resumes:
        prefix = f"{resume.plan.trial_id}.{MOVED_ASIDE_MARKER}-"
        found = tuple(
            {"path": str(config.trials_dir / name),
             "metered_requests": _metered_requests(config.trials_dir / name)}
            for name in names if name.startswith(prefix)
        )
        if found:
            attempts[resume.plan.trial_id] = found
    return attempts


def _move_aside(trial_root: Path, stamp: str) -> Path:
    base = f"{trial_root.name}.{MOVED_ASIDE_MARKER}-{stamp}"
    target = trial_root.with_name(base)
    attempt = 1
    while target.exists() or target.is_symlink():
        attempt += 1
        target = trial_root.with_name(f"{base}-{attempt}")
    trial_root.rename(target)
    return target


def _preflight(config: CampaignConfig, pending: Sequence[TrialPlan]) -> _Preflight:
    """Admit every pending arm's credential capability exactly as the trial path will, then ask
    whether the host's Codex token can carry the Codex trials among them.

    The token's lifetime no longer bounds the campaign as a whole: a refreshing route has no
    wall-clock budget, and a non-refreshing trial is checked against the token at the moment it
    would be armed (`_codex_trial_refusal`), so the trials before it keep their results.
    """
    arms = {plan.arm_name: plan.arm for plan in pending}
    for name, arm in arms.items():
        try:
            require_capability_admission(arm, paid_run=config.paid)
        except (CapabilityStateRefused, LookupError, ValueError) as error:
            return _Preflight(refusal=f"arm {name} cannot be admitted: {error}")
    codex = [plan for plan in pending if codex_preflight.runs_on_codex_token(plan.arm)]
    if not codex:
        return _Preflight()
    can_refresh = codex_preflight.can_refresh(config.proxy)
    try:
        expires_at_ms = codex_preflight.access_expiry_ms(config.proxy, now_ms=_now_ms())
    except CodexPreflightRefused as error:
        return _Preflight(
            refusal=str(error), codex_trials=len(codex), codex_can_refresh=can_refresh)
    return _Preflight(
        codex_trials=len(codex), codex_expires_at_ms=expires_at_ms,
        codex_can_refresh=can_refresh)


@contextlib.contextmanager
def _codex_access(
    config: CampaignConfig, preflight: _Preflight,
) -> Iterator[_CodexAccess | None]:
    """The Codex routes' shared access for the length of the campaign, cleared when it ends."""
    if preflight.codex_expires_at_ms is None:
        yield None
        return
    if not preflight.codex_can_refresh:
        yield _CodexAccess(preflight.codex_expires_at_ms, can_refresh=False)
        return
    try:
        holder = codex_preflight.shared_token_holder(
            config.proxy, expires_at_ms=preflight.codex_expires_at_ms)
    except ValueError as error:
        raise CampaignError(f"Codex token holder could not be built: {error}") from error
    handle = HOST_TOKEN_HOLDERS.register(holder)
    try:
        yield _CodexAccess(preflight.codex_expires_at_ms, can_refresh=True, token_holder=handle)
    finally:
        HOST_TOKEN_HOLDERS.release(handle)


def _codex_trial_refusal(
    config: CampaignConfig, plan: TrialPlan, codex: _CodexAccess | None,
) -> str | None:
    """Why this one trial cannot be armed on the current token, or None.

    A trial is refused rather than the campaign, so the trials that already ran keep their
    results and a re-run after the operator refreshes the token arms only what is left.
    """
    if codex is None or codex.can_refresh or not codex_preflight.runs_on_codex_token(plan.arm):
        return None
    return codex_preflight.trial_refusal(
        codex.expires_at_ms, now_ms=_now_ms(), window_ms=_trial_window_ms(config, plan))


def _trial_window_ms(config: CampaignConfig, plan: TrialPlan) -> int:
    """From network creation to the end of teardown: how long one trial holds its route."""
    return (
        NETWORK_CREATE_TIMEOUT_MS + SETUP_TIMEOUT_MS + _declared_lease_ms(config, plan)
        + TEARDOWN_GRACE_MS
    )


def _declared_lease_ms(config: CampaignConfig, plan: TrialPlan) -> int:
    limits = plan.arm["limits"]
    assert isinstance(limits, Mapping)
    deadline_seconds = int(limits["deadline_seconds"])
    agent_seconds = config.timeouts.get("agent_seconds", deadline_seconds)
    return min(deadline_seconds, agent_seconds) * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _arm_trial(
    config: CampaignConfig, plan: TrialPlan, slot: NetworkSlot,
    codex: _CodexAccess | None, task_path: Path,
) -> None:
    """One trial, through the production trial path and nothing else, on its own network.

    The network is removed whatever became of the trial, cancellation included.
    """
    network_id = await _off_loop(_create_trial_network, config, plan, slot)
    trial_error: CampaignError | None = None
    try:
        trial = await create_harbor_trial(
            arm=dict(plan.arm), task_path=task_path,
            trials_dir=config.trials_dir,
            manifest=config.trial_manifest(plan), trial_seed=config.trial_seed(plan),
            cli_version=config.cli_version, host_scan_policy=dict(config.host_scan_policy),
            trial_proxy=_slot_proxy(config, slot, codex),
            agent_timeout_seconds=config.timeouts.get("agent_seconds"),
            verifier_timeout_seconds=config.timeouts.get("verifier_seconds"),
            network=config.network,
            runtime_mounts=config.arm_runtime_mounts(plan.arm),
            cpuset=cpuset_for_slot(slot.index, config.concurrency),
        )
        await trial.run()
    except CampaignError as error:
        trial_error = error
    except Exception as error:
        trial_error = _failed_trial_error(config, plan, error)
    finally:
        await _cleanup_trial_network(network_id, trial_error)
    if trial_error is not None:
        raise trial_error


def _failed_trial_error(
    config: CampaignConfig, plan: TrialPlan, error: Exception,
) -> CampaignError:
    """A trial whose run raised publishes nothing gradable: its envelope, if one was written, is
    removed so that a re-run reads the root as harness-incomplete and arms the trial again."""
    trial_error = CampaignError(f"trial {plan.trial_id} failed: {error}")
    trial_error.__cause__ = error
    marker = config.trials_dir / plan.trial_id / "artifacts" / OUTER_ENVELOPE_FILENAME
    try:
        marker.unlink(missing_ok=True)
    except OSError as cleanup_error:
        return HostFaultError(
            f"{trial_error}; gradable marker cleanup also failed: {cleanup_error}")
    return trial_error


def _slot_proxy(
    config: CampaignConfig, slot: NetworkSlot, codex: _CodexAccess | None,
) -> dict[str, object]:
    proxy = config.slot_proxy(slot)
    if codex is not None:
        proxy["access_expires_at_ms"] = codex.expires_at_ms
        if codex.token_holder is not None:
            proxy["oauth_token_holder"] = codex.token_holder
    return proxy


async def _cleanup_trial_network(
    network_id: str, trial_error: CampaignError | None,
) -> None:
    try:
        await _off_loop(_remove_trial_network, network_id)
    except Exception as cleanup_error:
        if trial_error is not None:
            raise TrialCleanupError(trial_error, cleanup_error) from trial_error
        if isinstance(cleanup_error, CampaignError):
            raise
        raise HostFaultError(
            f"could not remove Docker network {network_id}: {cleanup_error}") from cleanup_error


def _create_trial_network(
    config: CampaignConfig, plan: TrialPlan, slot: NetworkSlot,
) -> str:
    """This trial's own network, on the subnet its concurrency slot owns.

    Host-level on failure: a slot whose declared subnet cannot be created is a fact about the
    machine and its address space, and every later trial on that slot would meet it again.
    """
    name = f"{plan.trial_id}__env_default"
    try:
        return create_trial_network(name, slot.subnet, slot.gateway)
    except TrialNetworkError as error:
        raise TrialNetworkUnavailable(
            f"trial {plan.trial_id} could not create Docker network {name} on slot "
            f"{slot.index} ({slot.subnet}): {error}") from error


def _remove_trial_network(network_id: str) -> None:
    """Host-level on failure: an un-removed network is leaked host state, and its subnet is a
    slot the campaign can no longer use."""
    try:
        remove_trial_network(network_id)
    except TrialNetworkError as error:
        raise HostFaultError(
            f"could not remove Docker network {network_id}: {error}") from error


def _read_outcome(
    plan: TrialPlan, trial_root: Path, state: str, *, slot: int | None = None,
    started_at: str | None = None, finished_at: str | None = None,
) -> TrialOutcome:
    read = TrialOutcomeReader(
        trial_id=plan.trial_id, arm_name=plan.arm_name, trial_root=trial_root,
    ).read()
    requests = read.requests
    metered = requests if requests is not None else _metered_requests(trial_root)
    # A trial that produced a canonical reward RAN, whatever that reward was. Keying this off
    # TERMINAL_SUCCESS instead called every zero-scoring trial a failure -- including the graded
    # refusals, which publish an outer envelope and a reward of 0 exactly as designed -- and so a
    # campaign measuring a hard benchmark reported `ok: false` for doing its job. TRIAL_FAILED is
    # for a trial that yields no measurement: a verifier that never scored, a harness that never
    # finished, an arm that never armed.
    return TrialOutcome(
        plan=plan, state=state if read.score_status == SCORE_AVAILABLE else TRIAL_FAILED,
        requests=requests, metered_requests=metered, armed=True,
        envelope=read.envelope, envelope_path=read.envelope_path,
        envelope_sha256=read.envelope_sha256, outcome_state=read.outcome_state,
        verifier_rewards=read.verifier_rewards, score_status=read.score_status,
        reason=read.reason, slot=slot, started_at=started_at, finished_at=finished_at,
    )


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
    """Every request the campaign's meters counted: each trial's own, plus each attempt of it
    that an earlier run left harness-incomplete and a later run set aside."""
    return sum(
        value for value in (
            *(outcome.metered_requests for outcome in outcomes),
            *(_attempt_meter(attempt) for outcome in outcomes
              for attempt in outcome.set_aside_attempts),
        ) if value is not None
    )


def _total_is_complete(outcomes: Sequence[TrialOutcome]) -> bool:
    """Whether every trial that was armed, and every set-aside attempt, contributed a figure.

    A trial that was never armed spent nothing and cannot make the total incomplete; a trial or a
    set-aside attempt that ran and left no readable meter makes the total a floor rather than a
    sum, and the document has to say so instead of letting the missing number read as zero.
    """
    return all(
        outcome.metered_requests is not None for outcome in outcomes if outcome.armed
    ) and all(
        _attempt_meter(attempt) is not None
        for outcome in outcomes for attempt in outcome.set_aside_attempts
    )


def _attempt_meter(attempt: Mapping[str, object]) -> int | None:
    value = attempt.get("metered_requests")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _write_comparison_report(
    config: CampaignConfig, outcomes: Sequence[TrialOutcome],
) -> tuple[Path | None, str | None]:
    """The report over every terminal trial, including explicit failed outcomes."""
    runs = [
        _report_run(config, outcome) for outcome in outcomes
        if outcome.outcome_state is not None
    ]
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
    arm = dict(outcome.plan.arm)
    return {
        "run_id": outcome.plan.trial_id, "arm": arm,
        "cli_version": arm.get("vendor_cli_version", config.cli_version),
        "task": {"task_id": outcome.plan.task.task_id,
                 "image_digest": outcome.plan.task.image_digest},
        "cortex_telemetry": _cortex_telemetry(outcome),
        "outcome_state": outcome.outcome_state,
        "outcome_reason": outcome.reason,
        "verifier_rewards": (
            None if outcome.verifier_rewards is None else dict(outcome.verifier_rewards)),
        "score_status": outcome.score_status,
    }


def _cortex_telemetry(outcome: TrialOutcome) -> Mapping[str, object] | None:
    if outcome.plan.arm.get("kind") != "cortex" or outcome.envelope is None:
        return None
    usage = outcome.envelope.get("proxy_usage")
    usage = usage if isinstance(usage, Mapping) else {}
    identity = outcome.envelope.get("identity")
    identity = identity if isinstance(identity, Mapping) else {}
    return {
        "trial_id": outcome.plan.trial_id, "root_run_id": identity.get("root_run_id"),
        "requests": usage.get("requests"), "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "outer_envelope_sha256": outcome.envelope_sha256,
    }


def _dry_run_document(
    config: CampaignConfig, resumes: Sequence[_Resume], preflight: _Preflight,
) -> dict[str, object]:
    """What `run` would do with every trial root, decided by the same reads, writing nothing."""
    return {
        "ok": preflight.refusal is None, "dry_run": True,
        "schema_version": CAMPAIGN_RESULT_SCHEMA_VERSION,
        "campaign": config.campaign, "paid": config.paid,
        "trials_dir": str(config.trials_dir),
        "concurrency": config.concurrency,
        "preflight": preflight.report(),
        "slots": [
            {"slot": slot.index, "subnet": slot.subnet, "gateway": slot.gateway,
             "container_ip": slot.container_ip}
            for slot in (config.slot(index) for index in range(config.concurrency))
        ],
        "report_path": str(config.trials_dir / COMPARISON_REPORT_FILENAME),
        "trials": [_dry_run_trial(config, resume, preflight) for resume in resumes],
    }


def _dry_run_trial(
    config: CampaignConfig, resume: _Resume, preflight: _Preflight,
) -> dict[str, object]:
    plan = resume.plan
    record: dict[str, object] = {
        "trial_id": plan.trial_id, "arm": plan.arm_name, "task_id": plan.task.task_id,
    }
    if resume.terminal is not None:
        record["state"] = "would-skip"
        record["outcome_state"] = resume.terminal.outcome_state
        return record
    if resume.incomplete is not None:
        record["state"] = "would-move-aside-and-rearm"
        record["reason"] = resume.incomplete
    else:
        record["state"] = "would-arm"
    codex = None if preflight.codex_expires_at_ms is None else _CodexAccess(
        preflight.codex_expires_at_ms, can_refresh=preflight.codex_can_refresh)
    refusal = _codex_trial_refusal(config, plan, codex)
    if refusal is not None:
        # Asked again when the trial is reached; this is the answer if it were reached now.
        record["codex_refusal_now"] = refusal
    return record


def _write_delivery_artifacts(
    config: CampaignConfig, outcomes: Sequence[TrialOutcome],
    document: Mapping[str, object],
) -> None:
    config.trials_dir.mkdir(parents=True, exist_ok=True)
    (config.trials_dir / CAMPAIGN_RESULT_FILENAME).write_text(
        _render_public_result(document), encoding="utf-8")
    summary = build_result_summary(config, outcomes)
    (config.trials_dir / RESULT_SUMMARY_FILENAME).write_text(
        render_result_summary(summary), encoding="utf-8")


def _render_public_result(document: Mapping[str, object]) -> str:
    return json.dumps(document, sort_keys=True) + "\n"


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
    print(_render_public_result(document), end="", flush=True)
    return 0 if document.get("ok") else 1
