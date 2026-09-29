from __future__ import annotations

import threading
from datetime import UTC, datetime
from pathlib import Path

from ..launcher.trial_admission_io import atomic_write_json

STATE_SCHEMA = "cortex-bench-full-suite-state/1"
TRANSITIONS = {
    "planned": frozenset({"arming", "not-run"}),
    "arming": frozenset({"armed", "failed"}),
    "armed": frozenset({"terminal", "failed"}),
    "terminal": frozenset(),
    "failed": frozenset(),
    "not-run": frozenset(),
}


class RunStateError(RuntimeError):
    """A paid run identity would be created twice or its recorded task state is inconsistent."""


class RunLedger:
    def __init__(self, run_dir: Path, document: dict[str, object]) -> None:
        self.path = run_dir / "suite-state.json"
        self._document = document
        self._lock = threading.Lock()

    @classmethod
    def create(
        cls, run_dir: Path, spec_digest: str, task_ids: list[str],
    ) -> "RunLedger":
        try:
            run_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
        except FileExistsError as error:
            raise RunStateError(f"run identity already exists: {run_dir}") from error
        document: dict[str, object] = {
            "schema_version": STATE_SCHEMA,
            "spec_digest": spec_digest,
            "created_at": _utc_now(),
            "tasks": {task_id: {"state": "planned"} for task_id in task_ids},
        }
        ledger = cls(run_dir, document)
        ledger._persist()
        return ledger

    def transition(self, task_id: str, target: str) -> None:
        with self._lock:
            record = self._task_record(task_id)
            current = str(record["state"])
            if target not in TRANSITIONS.get(current, frozenset()):
                raise RunStateError(f"task {task_id} cannot transition {current} -> {target}")
            record["state"] = target
            record[f"{target}_at"] = _utc_now()
            self._persist()

    def state_of(self, task_id: str) -> str:
        with self._lock:
            return str(self._task_record(task_id)["state"])

    def planned_tasks(self) -> list[str]:
        with self._lock:
            tasks = self._tasks()
            return [task_id for task_id, record in tasks.items() if record["state"] == "planned"]

    def _tasks(self) -> dict[str, dict[str, object]]:
        tasks = self._document.get("tasks")
        if not isinstance(tasks, dict):
            raise RunStateError("run state tasks must be a mapping")
        return tasks

    def _task_record(self, task_id: str) -> dict[str, object]:
        record = self._tasks().get(task_id)
        if not isinstance(record, dict):
            raise RunStateError(f"run state does not declare task {task_id}")
        return record

    def _persist(self) -> None:
        atomic_write_json(self.path, self._document)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
