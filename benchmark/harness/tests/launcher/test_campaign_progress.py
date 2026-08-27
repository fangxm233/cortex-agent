# input:  a campaign run and the trial transitions it makes along the way
# output: proof the run-level ledger answers "what is left" while the run is still going
# pos:    Campaign progress ledger tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The campaign result is written once, at the end. At three trials that is fine; at 623 trials
# over tens of hours the operator had nothing to read but trial roots. These pin the ledger that
# replaced that: every declared trial present from the first write, a failure carrying its reason,
# and -- the one that matters most -- a ledger write never turning a running campaign into a
# failed one.

import json
from pathlib import Path

import pytest

from cortex_bench_harness.campaign_progress import PROGRESS_FILENAME, CampaignProgress
from test_campaign import (
    RecordingTrialPath,
    publish_envelope,
    run_cli,
    write_campaign,
)


def progress(trials_dir: Path) -> dict:
    return json.loads((trials_dir / PROGRESS_FILENAME).read_text(encoding="utf-8"))


def test_a_finished_run_leaves_a_ledger_naming_every_trial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_requests=1).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))
    document = progress(tmp_path / "trials")

    assert status == 0
    assert document["schema_version"] == "cortex-bench-campaign-progress/1"
    assert set(document["trials"]) == {trial["trial_id"] for trial in result["trials"]}
    assert document["counts"] == {
        "pending": 0, "running": 0, "resumed": 0, "done": 4, "failed": 0, "total": 4}
    first = document["trials"]["camp-01-task-one-cortex-a"]
    assert (first["task_id"], first["arm"], first["state"]) == (
        "task-one", "cortex-a", "done")
    assert first["started_at"] <= first["finished_at"]


def test_a_resumed_trial_is_distinguished_from_one_this_run_produced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """Which trials this run is actually about to spend money on is the resume question."""
    RecordingTrialPath(default_requests=1).install(monkeypatch)
    trials_dir = tmp_path / "trials"
    publish_envelope(trials_dir, "camp-01-task-one-cortex-a", "cortex-a", 7)

    run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))
    document = progress(trials_dir)

    assert document["trials"]["camp-01-task-one-cortex-a"]["state"] == "resumed"
    assert document["counts"]["resumed"] == 1 and document["counts"]["done"] == 3


def test_a_failed_trial_carries_its_reason_without_waiting_for_the_run_to_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    failed = "camp-01-task-two-cortex-a"
    RecordingTrialPath(failures=(failed,)).install(monkeypatch)

    status, _, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))
    record = progress(tmp_path / "trials")["trials"][failed]

    assert status == 1
    assert record["state"] == "failed"
    assert f"container refused trial {failed}" in record["reason"]


def test_the_ledger_is_written_before_the_first_trial_is_armed(tmp_path: Path) -> None:
    """A run that dies in its first hour still says what it was going to do."""
    ledger = CampaignProgress(tmp_path / PROGRESS_FILENAME, "camp-01", "2026-08-26T00:00:00.000Z")
    ledger.declare("t-1", "task-one", "cortex-a", resumed=False)
    ledger.declare("t-2", "task-two", "cortex-a", resumed=True)
    ledger.flush()

    document = progress(tmp_path)
    assert document["counts"] == {
        "pending": 1, "running": 0, "resumed": 1, "done": 0, "failed": 0, "total": 2}
    assert document["trials"]["t-1"]["state"] == "pending"


def test_a_ledger_that_cannot_be_written_does_not_fail_the_trial(tmp_path: Path) -> None:
    """Observability is not worth a trial: the campaign result is still written at the end."""
    unwritable = tmp_path / "file" / "progress.json"
    (tmp_path / "file").write_text("not a directory", encoding="utf-8")
    ledger = CampaignProgress(unwritable, "camp-01", "2026-08-26T00:00:00.000Z")
    ledger.declare("t-1", "task-one", "cortex-a", resumed=False)

    ledger.started("t-1", 0, "2026-08-26T00:00:01.000Z")
    ledger.finished(
        "t-1", failed=False, score_status="available", reason=None,
        finished_at="2026-08-26T00:00:02.000Z")

    assert not unwritable.exists()
    assert ledger.document()["trials"]["t-1"]["state"] == "done"
