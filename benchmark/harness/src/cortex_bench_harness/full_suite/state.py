# input:  run identity, spec digest and per-task lifecycle transitions
# output: atomic crash-visible no-rerun ledger
# pos:    Full-suite paid-run state boundary
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path

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
    """A paid run identity would be created twice or resumed ambiguously."""


class RunLedger:
    def __init__(self, run_dir: Path, document: dict[str, object]) -> None:
        self.run_dir = run_dir
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

    @classmethod
    def load(cls, run_dir: Path) -> "RunLedger":
        path = run_dir / "suite-state.json"
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RunStateError(f"cannot load run state {path}: {error}") from error
        if document.get("schema_version") != STATE_SCHEMA:
            raise RunStateError(f"unsupported run state schema in {path}")
        return cls(run_dir, document)

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

    def assert_resumable(self) -> None:
        with self._lock:
            incomplete = [
                task_id for task_id, record in self._tasks().items()
                if record["state"] in {"arming", "armed"}
            ]
        if incomplete:
            raise RunStateError(f"incomplete paid task requires manual review: {incomplete[0]}")

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
        _atomic_json(self.path, self._document)


def _atomic_json(path: Path, document: dict[str, object]) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
