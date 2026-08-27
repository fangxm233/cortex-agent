# input:  a campaign's declared trials and each one's transition as it happens
# output: an atomic run-level ledger of what ran, what is running and what is left
# pos:    Campaign progress ledger
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# A campaign's result document is written once, at the end. For a three-trial campaign that is
# fine. For 623 trials over tens of hours it is not: the only way to see progress was to list
# trial roots and guess, and the only way to see WHY a trial failed was to wait for the run to
# finish. This writes the same facts continuously, so a long run can be watched, resumed from a
# known point, and reasoned about while it is still going.
#
# It is an operational file, not a published one. It lives beside the trial roots inside
# `trials_dir` and carries host paths in failure reasons exactly as the operator would read them;
# the sanitized, publishable projections are the campaign result and the result summary.
#
# It is a VIEW, never the source of truth. Resume decisions are made from the trial roots
# themselves (`_partition`), because a root is the thing a trial actually produced; deleting this
# file loses observability and nothing else.

import json
import os
import tempfile
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path

PROGRESS_SCHEMA_VERSION = "cortex-bench-campaign-progress/1"
PROGRESS_FILENAME = "progress.json"

PENDING = "pending"
RUNNING = "running"
RESUMED = "resumed"
DONE = "done"
FAILED = "failed"


class CampaignProgress:
    """The run-level ledger, rewritten atomically on every transition.

    Every trial is declared up front, so the file answers "what is left" from the first write
    rather than growing into the answer. Writes are best-effort by design: a full disk must not
    turn a running campaign into a failed one over a file whose only job is to be read by a human.
    """

    def __init__(self, path: Path, campaign: str, started_at: str) -> None:
        self._path = path
        self._campaign = campaign
        self._started_at = started_at
        self._trials: dict[str, dict[str, object]] = {}

    def declare(self, trial_id: str, task_id: str, arm_name: str, resumed: bool) -> None:
        self._trials[trial_id] = {
            "task_id": task_id, "arm": arm_name,
            "state": RESUMED if resumed else PENDING,
        }

    def started(self, trial_id: str, slot: int, started_at: str) -> None:
        self._trials[trial_id].update(
            {"state": RUNNING, "slot": slot, "started_at": started_at})
        self.flush()

    def finished(
        self, trial_id: str, *, failed: bool, score_status: str | None,
        reason: str | None, finished_at: str,
    ) -> None:
        record = self._trials[trial_id]
        record.update({
            "state": FAILED if failed else DONE, "finished_at": finished_at,
            "score_status": score_status, "reason": reason,
        })
        self.flush()

    def flush(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_json(self._path, self.document())
        except OSError:
            # Observability is not worth a trial. The campaign result is still written at the end.
            return

    def document(self) -> dict[str, object]:
        return {
            "schema_version": PROGRESS_SCHEMA_VERSION, "campaign": self._campaign,
            "started_at": self._started_at, "updated_at": _timestamp(),
            "counts": _counts(self._trials.values()),
            "trials": {trial_id: dict(record) for trial_id, record in self._trials.items()},
        }


def _counts(records: Sequence[Mapping[str, object]] | object) -> dict[str, int]:
    states = [str(record["state"]) for record in records]  # type: ignore[union-attr]
    counted = {state: states.count(state) for state in (
        PENDING, RUNNING, RESUMED, DONE, FAILED)}
    counted["total"] = len(states)
    return counted


def _atomic_json(path: Path, document: Mapping[str, object]) -> None:
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


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
