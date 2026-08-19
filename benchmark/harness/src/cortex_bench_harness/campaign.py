# input:  campaign config and host Codex OAuth expiry
# output: terminal outcomes, verifier rewards and comparison report
# pos:    Public campaign runner
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The driver owns exactly three policies the trial path does not: which trials run and in what
# order, how many run at once, and the resume rule. It delegates execution to `create_harbor_trial`,
# then reads Harbor's result and the host envelope into one terminal outcome. Reporting remains
# delegated to the comparison builder.
#
# Resume classifies every existing root BEFORE anything is armed. Terminal success, failure, and
# security failure are read without writing the root again. A harness-incomplete root is refused
# wholesale because it cannot be trusted or overwritten. At suite scale, naming every incomplete
# root in one refusal avoids one campaign run per root.
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
import os
import subprocess
import sys
import time
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
from .host_finalization import OUTER_ENVELOPE_FILENAME
from .launcher.comparison_report import build_comparison_report, render_comparison_report
from .launcher.credential_capabilities import (
    CODEX_CLI_CAPABILITY_KEY,
    capability_key_for,
)
from .launcher.lease_bound import SETUP_TIMEOUT_MS, TEARDOWN_GRACE_MS
from .launcher.trial_admission import create_harbor_trial
from .proxy.adapters.openai_codex_responses import extract_access_expiry_ms
from .outcome import (
    HARNESS_INCOMPLETE,
    SCORE_UNAVAILABLE,
    SECURITY_FAILED,
    TERMINAL_SUCCESS,
    TrialOutcomeReader,
)

CAMPAIGN_RESULT_SCHEMA_VERSION = "cortex-bench-campaign-result/5"
COMPARISON_REPORT_FILENAME = "comparison-report.json"
PROXY_EXPORT_FILENAME = "proxy-export.json"
STATE_COMPLETED = "completed"
STATE_HOST_FAULT = "stopped-after-host-fault"
TRIAL_RAN = "ran"
TRIAL_SKIPPED = "skipped"
TRIAL_FAILED = "failed"
TRIAL_NOT_ARMED = "not-armed"
CODEX_CLOCK_SKEW_MARGIN_MS = 60_000
NETWORK_CREATE_TIMEOUT_MS = 30_000

EPILOG = """Examples:
  cortex-bench run --config benchmark/campaigns/zero-paid-dry-run.yaml
  cortex-bench run --config campaign.yaml --dry-run
  cat campaign.yaml | cortex-bench run --config -

A campaign is resumable: re-running the same config reads every terminal trial root,
including failures, so a retry arms nothing and spends nothing.
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
    outcome_state: str | None = None
    verifier_rewards: Mapping[str, int | float] | None = None
    score_status: str | None = None
    reason: str | None = None
    slot: int | None = None
    started_at: str | None = None
    finished_at: str | None = None

    @property
    def admission(self) -> Mapping[str, object] | None:
        """What the terminal record says about being gradable."""
        if self.outcome_state == SECURITY_FAILED:
            return {"admitted": False, "reason": "security_failed"}
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
        if self.outcome_state is not None:
            record["outcome_state"] = self.outcome_state
            record["verifier_rewards"] = (
                None if self.verifier_rewards is None else dict(self.verifier_rewards))
            record["score_status"] = self.score_status
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
        partitioned = _partition(config, self._plans)
        pending = tuple(plan for plan, resumed in partitioned if resumed is None)
        self._access_expires_at_ms = _codex_wave_preflight(config, pending)
        for plan, resumed in partitioned:
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
            await _arm_trial(
                self._config, plan, slot, self._access_expires_at_ms)
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
            plan=plan, state=TRIAL_FAILED, outcome_state=HARNESS_INCOMPLETE,
            verifier_rewards=None, score_status=SCORE_UNAVAILABLE,
            reason=str(error), slot=slot.index, started_at=started_at,
            finished_at=_timestamp(), armed=True,
            metered_requests=_metered_requests(trial_root))


def _partition(
    config: CampaignConfig, plans: Sequence[TrialPlan],
) -> list[tuple[TrialPlan, TrialOutcome | None]]:
    """Decide resume-or-arm for every trial before any of them is armed.

    Refusing every unfinished root at once matters at suite scale: an operator learns which roots
    to move aside in one message, rather than one campaign run per root.
    """
    partitioned: list[tuple[TrialPlan, TrialOutcome | None]] = []
    unfinished: list[tuple[Path, str | None]] = []
    for plan in plans:
        trial_root = config.trials_dir / plan.trial_id
        if not trial_root.exists():
            partitioned.append((plan, None))
            continue
        outcome = _read_outcome(plan, trial_root, TRIAL_SKIPPED)
        if outcome.outcome_state == HARNESS_INCOMPLETE:
            unfinished.append((trial_root, outcome.reason))
            continue
        partitioned.append((plan, outcome))
    if unfinished:
        details = ", ".join(f"{root} ({reason})" for root, reason in unfinished)
        raise CampaignError(
            f"{len(unfinished)} trial root(s) are harness-incomplete: {details}. "
            "Move them aside to re-run those trials; this driver never overwrites one")
    return partitioned


def _codex_wave_preflight(
    config: CampaignConfig, pending: Sequence[TrialPlan],
) -> int | None:
    codex = _codex_plans(pending)
    if not codex:
        return None
    if len(codex) != len(pending):
        raise CampaignError("pending Codex trials must be a single-provider concurrent wave")
    if len(codex) > config.concurrency:
        raise CampaignError(
            "all pending Codex trials must fit in one concurrent wave before any route is armed")
    credential_name = str(config.proxy["credential_env"])
    credential = os.environ.get(credential_name)
    if not credential:
        raise CampaignError(f"host credential {credential_name} is not set for Codex preflight")
    try:
        expiry_ms = extract_access_expiry_ms(credential)
    except ValueError as error:
        raise CampaignError(f"Codex token expiry preflight refused the campaign: {error}") from error
    now_ms = _now_ms()
    if expiry_ms <= now_ms:
        raise CampaignError("Codex token is expired; no route was armed and no refresh was attempted")
    required_ms = _codex_required_expiry_ms(config, codex, now_ms)
    if expiry_ms < required_ms:
        raise CampaignError(
            "Codex token cannot cover setup, lease, teardown, and clock skew for the "
            "whole concurrent wave; zero routes were armed")
    return expiry_ms


def _codex_plans(pending: Sequence[TrialPlan]) -> tuple[TrialPlan, ...]:
    codex: list[TrialPlan] = []
    for plan in pending:
        vendor_agent = plan.arm.get("vendor_agent")
        capability_id = str(plan.arm["credential_capability"])
        if vendor_agent != "codex" and capability_id != "codex-subscription":
            continue
        if vendor_agent != "codex" or capability_id != "codex-subscription":
            raise CampaignError(
                "Codex vendor arms must name the exact codex-subscription capability")
        try:
            key = capability_key_for(capability_id)
        except LookupError as error:
            raise CampaignError("the exact codex-subscription capability is not registered") from error
        if key != CODEX_CLI_CAPABILITY_KEY or plan.arm.get("provider") != key.provider:
            raise CampaignError("Codex vendor arm differs from the exact registered capability key")
        codex.append(plan)
    return tuple(codex)


def _codex_required_expiry_ms(
    config: CampaignConfig, plans: Sequence[TrialPlan], now_ms: int,
) -> int:
    leases = (_declared_lease_ms(config, plan) for plan in plans)
    return (
        now_ms + len(plans) * NETWORK_CREATE_TIMEOUT_MS
        + SETUP_TIMEOUT_MS + max(leases) + TEARDOWN_GRACE_MS
        + CODEX_CLOCK_SKEW_MARGIN_MS
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
    access_expires_at_ms: int | None = None,
) -> None:
    """One trial, through the production trial path and nothing else."""
    network_id = ""
    trial_error: CampaignError | None = None
    try:
        network_id = _create_trial_network(config, plan, slot)
        trial = await create_harbor_trial(
            arm=dict(plan.arm), task_path=plan.task.path, trials_dir=config.trials_dir,
            manifest=config.trial_manifest(plan), trial_seed=config.trial_seed(plan),
            cli_version=config.cli_version, host_scan_policy=dict(config.host_scan_policy),
            trial_proxy=_slot_proxy(config, slot, access_expires_at_ms),
            agent_timeout_seconds=config.timeouts.get("agent_seconds"),
            verifier_timeout_seconds=config.timeouts.get("verifier_seconds"),
            network=config.network,
        )
        await trial.run()
    except HostFaultError:
        raise
    except CampaignError as error:
        trial_error = error
    except Exception as error:
        trial_error = _failed_trial_error(config, plan, error)
    _cleanup_trial_network(network_id, trial_error)
    if trial_error is not None:
        raise trial_error


def _failed_trial_error(
    config: CampaignConfig, plan: TrialPlan, error: Exception,
) -> CampaignError:
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
    config: CampaignConfig, slot: NetworkSlot, access_expires_at_ms: int | None,
) -> dict[str, object]:
    proxy = config.slot_proxy(slot)
    if access_expires_at_ms is not None:
        proxy["access_expires_at_ms"] = access_expires_at_ms
    return proxy


def _cleanup_trial_network(
    network_id: str, trial_error: CampaignError | None,
) -> None:
    if not network_id:
        return
    try:
        _remove_trial_network(network_id)
    except Exception as cleanup_error:
        if trial_error is not None:
            raise TrialCleanupError(trial_error, cleanup_error) from trial_error
        raise


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
    result = subprocess.run(
        command, capture_output=True, text=True,
        timeout=NETWORK_CREATE_TIMEOUT_MS / 1000,
    )
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
    read = TrialOutcomeReader(
        trial_id=plan.trial_id, arm_name=plan.arm_name, trial_root=trial_root,
    ).read()
    requests = read.requests
    metered = requests if requests is not None else _metered_requests(trial_root)
    return TrialOutcome(
        plan=plan, state=state if read.outcome_state == TERMINAL_SUCCESS else TRIAL_FAILED,
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
        "grader_admission": dict(outcome.admission) if outcome.admission else None,
        "outcome_state": outcome.outcome_state,
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
