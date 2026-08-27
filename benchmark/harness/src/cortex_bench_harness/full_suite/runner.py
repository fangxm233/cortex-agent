# input:  validated suite/host inputs, host-only credential and fixed slots
# output: one-attempt per-task Harbor results with isolated proxy evidence
# pos:    Full-suite execution coordinator
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict
from pathlib import Path

from cortex_bench_harness.proxy import SharedRequestLimit

from .config import HostInputs, SuiteSpec
from .network import NetworkSlot, create_networks, network_slots, remove_networks
from .processes import ProcessRegistry
from .scheduler import TaskOutcome, run_tasks
from .state import RunLedger
from .task_job import (
    build_child_environment,
    build_task_job,
    harbor_command,
    write_job,
    write_pi_config,
)
from .task_proxy import arm_task_proxy, finalize_task_proxy

HARNESS_ROOT = Path(__file__).resolve().parents[3]
SOURCE_ROOT = HARNESS_ROOT / "src"


class SuiteFault(RuntimeError):
    """A failure about the run rather than about one task, so it stops every task."""


class FullSuiteRunner:
    def __init__(
        self, spec: SuiteSpec, inputs: HostInputs, credential: str,
    ) -> None:
        self.spec = spec
        self.inputs = inputs
        self.credential = credential
        self.ledger = RunLedger.create(
            inputs.run_dir, spec.digest, [task.task_id for task in spec.tasks])
        self.slots = network_slots(spec, inputs.run_dir.name)
        self.shared_limit = SharedRequestLimit(spec.suite_max_requests)
        self.processes = ProcessRegistry()

    def run(self) -> dict[str, object]:
        create_networks(self.slots)
        try:
            outcomes = run_tasks(
                [task.task_id for task in self.spec.tasks], concurrency=self.spec.concurrency,
                execute=self._run_task, on_cancel=self.processes.cancel_all,
            )
        except BaseException:
            self._mark_not_run()
            raise
        finally:
            remove_networks(self.slots)
        document = self._suite_result(outcomes)
        _write_json(self.inputs.run_dir / "suite-result.json", document)
        return document

    def _run_task(self, task_id: str, slot_index: int) -> TaskOutcome:
        """One task, whose failure is its own.

        A task that fails is recorded as failed and the suite keeps going. It used to re-raise,
        and the raise travelled through `future.result()` into the scheduler's cancel path: on
        2026-08-23 one task's failure SIGKILLed six running tasks and left thirty-eight never
        run (EXP-089, EXP-091). Only a fault about the RUN -- a real credential in an artifact,
        an interrupt -- may still stop every task, and those are raised as they are.
        """
        slot = self.slots[slot_index]
        root = self.inputs.run_dir / "tasks" / task_id
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.ledger.transition(task_id, "arming")
        try:
            return self._run_armed_task(task_id, root, slot)
        except BaseException as error:
            self._mark_failed(task_id)
            _remove_private_config(root)
            _assert_credential_absent(root, self.credential)
            _write_json(root / "task-outcome.json", _failure(task_id, slot_index, error))
            if not isinstance(error, Exception):
                raise
            return TaskOutcome(task_id, slot_index, "failed", type(error).__name__)

    def _run_armed_task(
        self, task_id: str, root: Path, slot: NetworkSlot,
    ) -> TaskOutcome:
        session = arm_task_proxy(
            self.spec, self.inputs, task_id=task_id, task_root=root,
            container_ipv4=slot.container_ipv4, credential=self.credential,
            shared_limit=self.shared_limit,
        )
        try:
            self.ledger.transition(task_id, "armed")
            code, dummy = self._invoke_harbor(task_id, root, slot, session.handle)
            finalized = finalize_task_proxy(session)
            result = _single_result(root / "harbor-results")
        except BaseException:
            session.handle.stop()
            raise
        _remove_private_config(root)
        _assert_credential_absent(root, self.credential)
        document = _task_document(
            task_id, slot.index, code, result, finalized,
            dummy_present=_contains(root, dummy),
        )
        _write_json(root / "task-outcome.json", document)
        if not finalized.trace_complete:
            raise RuntimeError("network trace became incomplete")
        self.ledger.transition(task_id, "terminal")
        return TaskOutcome(task_id, slot.index, "terminal", _exception_name(result))

    def _invoke_harbor(
        self, task_id: str, root: Path, slot: NetworkSlot, handle: object,
    ) -> tuple[int, str]:
        dummy = str(getattr(handle, "dummy_token"))
        base_url = str(getattr(handle, "base_url"))
        config_root = root / "control/pi-config"
        write_pi_config(self.spec, config_root, base_url, dummy)
        job = build_task_job(
            self.spec, self.inputs, task_id=task_id,
            task_path=self.inputs.tasks_dir / task_id, task_root=root,
            pi_config=config_root, proxy_host=self.inputs.proxy_advertised_host,
            network_name=slot.name, container_ipv4=slot.container_ipv4,
        )
        job_path = root / "control/job.json"
        write_job(job_path, job)
        code = _run_harbor(self.inputs.harbor, job_path, root, self.processes)
        return code, dummy

    def _mark_failed(self, task_id: str) -> None:
        if self.ledger.state_of(task_id) in {"arming", "armed"}:
            self.ledger.transition(task_id, "failed")

    def _mark_not_run(self) -> None:
        for task_id in self.ledger.planned_tasks():
            self.ledger.transition(task_id, "not-run")

    def _suite_result(self, outcomes: list[TaskOutcome]) -> dict[str, object]:
        """The run's own account of itself.

        `ok` says every task reached a terminal state, which is a statement about the RUN. It is
        no longer the only thing a reader gets: a suite that finished with some tasks failed is
        a usable result, and `states` is what says how many, so a partial suite stops looking
        like no suite at all.
        """
        states: dict[str, int] = {}
        for outcome in outcomes:
            states[outcome.state] = states.get(outcome.state, 0) + 1
        return {
            "ok": all(outcome.state == "terminal" for outcome in outcomes),
            "schema_version": "cortex-bench-full-suite-result/2",
            "suite": self.spec.suite, "spec_digest": self.spec.digest,
            "states": dict(sorted(states.items())),
            "request_limit": {
                "maximum": self.shared_limit.maximum, "used": self.shared_limit.used},
            "outstanding_prerequisites": list(self.spec.outstanding_prerequisites),
            "tasks": [asdict(outcome) for outcome in outcomes],
        }


def _run_harbor(
    harbor: Path, job_path: Path, root: Path, registry: ProcessRegistry,
) -> int:
    environment = build_child_environment(os.environ, source_root=SOURCE_ROOT)
    with (root / "harbor.stdout.log").open("wb") as stdout:
        with (root / "harbor.stderr.log").open("wb") as stderr:
            return registry.run(
                harbor_command(harbor, job_path), cwd=HARNESS_ROOT,
                env=environment, stdout=stdout, stderr=stderr,
            )


def _single_result(root: Path) -> dict[str, object]:
    paths = list(root.glob("*/*/result.json")) if root.is_dir() else []
    if len(paths) != 1:
        raise RuntimeError(f"expected one Harbor trial result.json, found {len(paths)}")
    try:
        result = json.loads(paths[0].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot parse Harbor result: {error}") from error
    if not isinstance(result, dict):
        raise RuntimeError("Harbor result must be a mapping")
    return result


def _task_document(
    task_id: str, slot: int, harbor_code: int, result: dict[str, object], finalized: object,
    *, dummy_present: bool = False,
) -> dict[str, object]:
    verifier = result.get("verifier_result")
    reward = verifier.get("rewards") if isinstance(verifier, dict) else None
    provider_errors = _provider_error_count(getattr(finalized, "accounting_path"))
    return {
        "schema_version": "cortex-bench-full-suite-task-result/2",
        "task_id": task_id, "slot": slot, "harbor_exit_code": harbor_code,
        "exception_type": _exception_name(result), "reward": reward,
        "score_status": _score_status(reward, provider_errors),
        "provider_error_requests": provider_errors,
        # Expected, not alarming: the dummy is the credential the container is GIVEN, so any
        # agent that reads its own config writes it into its transcript. Recorded so a scan
        # can tell it apart from the host credential, which must never appear at all.
        "dummy_token_in_artifacts": dummy_present,
        "network_trace_complete": getattr(finalized, "trace_complete"),
        "network_trace": str(getattr(finalized, "network_trace_path")),
        "accounting": str(getattr(finalized, "accounting_path")),
        "revocation": str(getattr(finalized, "revocation_path")),
    }


#: Audit outcomes that mean the provider, not the agent, ended a request.
PROVIDER_FAULT_OUTCOMES = ("upstream_error_status", "usage_accounting_unavailable")


def _provider_error_count(accounting_path: object) -> int:
    """How many of this task's requests died at the provider rather than at the agent."""
    try:
        document = json.loads(Path(str(accounting_path)).read_text(encoding="utf-8"))
        outcomes = document["audit_log"]["outcomes"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return 0
    if not isinstance(outcomes, dict):
        return 0
    return sum(
        value for key, value in outcomes.items()
        if key in PROVIDER_FAULT_OUTCOMES and isinstance(value, int)
    )


def _score_status(reward: object, provider_errors: int) -> str:
    """Whether this task's number means what a score means.

    A zero earned while the provider was refusing requests is not evidence about the agent, and
    counting it as one is how a 2026-08-23 run reported 28.6% for a suite whose uncontaminated
    subset was 48.0% (EXP-091). It is reported, and named, separately. A task that scored
    despite an outage is not contaminated -- it already answered.
    """
    value = _reward_value(reward)
    if value is not None and value > 0:
        return "scored"
    if provider_errors > 0:
        return "provider_unavailable"
    return "scored" if value is not None else "unscored"


def _reward_value(reward: object) -> float | None:
    """Harbor reports rewards as a mapping; a bare number is accepted for the same meaning."""
    if isinstance(reward, bool):
        return None
    if isinstance(reward, (int, float)):
        return float(reward)
    if isinstance(reward, dict):
        inner = reward.get("reward")
        if isinstance(inner, (int, float)) and not isinstance(inner, bool):
            return float(inner)
    return None


def _exception_name(result: dict[str, object]) -> str | None:
    exception = result.get("exception_info")
    return str(exception.get("exception_type")) if isinstance(exception, dict) else None


def _failure(task_id: str, slot: int, error: BaseException) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-full-suite-task-result/2",
        "task_id": task_id, "slot": slot, "infrastructure_error": type(error).__name__,
        "infrastructure_error_detail": str(error)[:500],
        "score_status": "unscored",
    }


def _remove_private_config(root: Path) -> None:
    private = root / "control/pi-config"
    if private.exists():
        shutil.rmtree(private)


def _assert_credential_absent(root: Path, credential: str) -> None:
    """The host credential must not be in any artifact. This one still stops the run.

    The dummy token used to be checked here too, and that made the check fire on ordinary
    agent behaviour: the dummy IS the container's credential, so an agent that cats its own
    config has already "leaked" it. That false positive aborted a paid 87-task run after 49
    tasks (EXP-091). The dummy is now recorded per task instead of being fatal.
    """
    planted = credential.encode() if credential else b""
    if not planted:
        return
    for path in (candidate for candidate in root.rglob("*") if candidate.is_file()):
        if planted in path.read_bytes():
            raise SuiteFault(f"host credential reached task artifact: {path.name}")


def _contains(root: Path, needle: str) -> bool:
    planted = needle.encode() if needle else b""
    if not planted:
        return False
    return any(
        planted in path.read_bytes()
        for path in root.rglob("*") if path.is_file()
    )


def _write_json(path: Path, document: object) -> None:
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
