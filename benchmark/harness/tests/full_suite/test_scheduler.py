# input:  task ids, bounded worker slots, atomic run ledger
# output: concurrency, no-rerun and crash-state scheduling proofs
# pos:    Full-suite scheduler tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import threading
import time
from pathlib import Path

import pytest

from cortex_bench_harness.full_suite.scheduler import TaskOutcome, run_tasks
from cortex_bench_harness.full_suite.state import RunLedger, RunStateError


def test_scheduler_bounds_concurrency_and_never_retries_failures() -> None:
    lock = threading.Lock()
    active = 0
    peak = 0
    calls: list[str] = []

    def execute(task_id: str, slot: int) -> TaskOutcome:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            calls.append(task_id)
        time.sleep(0.02)
        with lock:
            active -= 1
        return TaskOutcome(task_id, slot, "failed" if task_id == "task-3" else "terminal")

    task_ids = [f"task-{index}" for index in range(12)]
    outcomes = run_tasks(task_ids, concurrency=3, execute=execute)

    assert peak == 3
    assert calls.count("task-3") == 1
    assert sorted(calls) == sorted(task_ids)
    assert [outcome.task_id for outcome in outcomes] == task_ids
    assert outcomes[3].state == "failed"


def test_host_fault_stops_new_scheduling_and_calls_cancel() -> None:
    started: list[str] = []
    cancelled: list[bool] = []

    def execute(task_id: str, slot: int) -> TaskOutcome:
        started.append(task_id)
        if task_id == "task-0":
            raise RuntimeError("host fault")
        time.sleep(0.05)
        return TaskOutcome(task_id, slot, "terminal")

    with pytest.raises(RuntimeError, match="host fault"):
        run_tasks(
            [f"task-{index}" for index in range(20)], concurrency=3,
            execute=execute, on_cancel=lambda: cancelled.append(True),
        )
    assert cancelled == [True]
    assert len(started) <= 3


def test_ledger_persists_arming_before_route_open(tmp_path: Path) -> None:
    ledger = RunLedger.create(tmp_path / "run", "spec-digest", ["one", "two"])
    ledger.transition("one", "arming")
    reloaded = RunLedger.load(tmp_path / "run")
    assert reloaded.state_of("one") == "arming"
    assert reloaded.state_of("two") == "planned"
    with pytest.raises(RunStateError, match="incomplete paid task"):
        reloaded.assert_resumable()


def test_existing_run_identity_is_not_recreated(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    RunLedger.create(run_dir, "spec-digest", ["one"])
    with pytest.raises(RunStateError, match="already exists"):
        RunLedger.create(run_dir, "spec-digest", ["one"])


def test_terminal_task_is_not_considered_incomplete(tmp_path: Path) -> None:
    ledger = RunLedger.create(tmp_path / "run", "spec-digest", ["one", "two"])
    ledger.transition("one", "arming")
    ledger.transition("one", "armed")
    ledger.transition("one", "terminal")
    ledger.assert_resumable()
    assert ledger.planned_tasks() == ["two"]
