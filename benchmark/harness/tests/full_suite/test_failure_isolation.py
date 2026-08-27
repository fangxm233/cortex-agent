# input:  a two-task suite where one task fails, leaks its dummy, or meets a provider outage
# output: proof that a task's failure stays that task's failure
# pos:    Full-suite failure isolation tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
#
# Two paid runs died this way. On 2026-08-22 the first task to SUCCEED raised, and the raise
# cancelled the pool (EXP-089). On 2026-08-23 an agent read its own config, the dummy token it
# was given appeared in its transcript, the leak assertion fired, and 38 tasks were never run
# (EXP-091). Both were the same shape: a per-task condition with suite-wide consequences.

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from cortex_bench_harness.full_suite.config import HostInputs, load_suite_spec
from cortex_bench_harness.full_suite.runner import FullSuiteRunner, SuiteFault
from cortex_bench_harness.full_suite.task_proxy import FinalizedProxy
from .test_config import write_spec

HOST_CREDENTIAL = "sk-host-credential-never-in-an-artifact"


class FakeHandle:
    def __init__(self, task_id: str) -> None:
        self.dummy_token = f"dummy-{task_id}"
        self.base_url = f"http://proxy.full.invalid/{task_id}"

    def stop(self) -> None:
        return


def _inputs(tmp_path: Path) -> HostInputs:
    tasks = tmp_path / "task-assets"
    for task_id in ("one", "two"):
        (tasks / task_id).mkdir(parents=True)
    return HostInputs(
        tasks, tmp_path / "run", tmp_path / "images.json", tmp_path / "harbor",
        tmp_path / "node", tmp_path / "pi", tmp_path / "gateway", "0.0.0.0",
        "proxy.full.invalid",
    )


def _arm(_spec, _inputs, *, task_id, task_root, **_kwargs):
    proxy = task_root / "proxy"
    proxy.mkdir()
    return SimpleNamespace(handle=FakeHandle(task_id), proxy_dir=proxy)


def _finalize(session, outcomes: dict[str, int] | None = None):
    names = ("accounting.json", "lease.json", "trace.jsonl", "revoke.json")
    paths = [session.proxy_dir / name for name in names]
    for path in paths:
        path.write_text("{}\n")
    paths[0].write_text(json.dumps({"audit_log": {"outcomes": outcomes or {}}}))
    return FinalizedProxy(*paths, True)


def _write_result(root: Path, reward: object) -> None:
    trial = root / "harbor-results/job/trial/result.json"
    trial.parent.mkdir(parents=True)
    (root / "harbor-results/job/result.json").write_text(json.dumps({"job_name": "job"}))
    trial.write_text(json.dumps({
        "exception_info": None, "verifier_result": {"rewards": reward},
    }))
    (root / "control/pi-config").mkdir(parents=True)


def _patch(monkeypatch, invoke, finalize=_finalize) -> None:
    monkeypatch.setattr(
        "cortex_bench_harness.full_suite.runner.create_networks", lambda _slots: None)
    monkeypatch.setattr(
        "cortex_bench_harness.full_suite.runner.remove_networks", lambda _slots: None)
    monkeypatch.setattr("cortex_bench_harness.full_suite.runner.arm_task_proxy", _arm)
    monkeypatch.setattr("cortex_bench_harness.full_suite.runner.finalize_task_proxy", finalize)
    monkeypatch.setattr(FullSuiteRunner, "_invoke_harbor", invoke)


def _run(tmp_path: Path) -> dict:
    spec = load_suite_spec(write_spec(tmp_path))
    return FullSuiteRunner(spec, _inputs(tmp_path), HOST_CREDENTIAL).run()


def test_one_failing_task_leaves_the_rest_of_the_suite_running(
    tmp_path: Path, monkeypatch,
) -> None:
    def invoke(self, task_id, root, _slot, _handle):
        if task_id == "one":
            raise RuntimeError("harbor exploded")
        _write_result(root, {"reward": 1})
        return 0, f"dummy-{task_id}"

    _patch(monkeypatch, invoke)
    result = _run(tmp_path)

    assert result["ok"] is False
    assert result["states"] == {"failed": 1, "terminal": 1}
    states = {task["task_id"]: task["state"] for task in result["tasks"]}
    assert states == {"one": "failed", "two": "terminal"}
    # The suite still published itself, which is what a partial run has to do to be usable.
    assert (tmp_path / "run/suite-result.json").is_file()
    failed = json.loads((tmp_path / "run/tasks/one/task-outcome.json").read_text())
    assert failed["infrastructure_error"] == "RuntimeError"
    assert "harbor exploded" in failed["infrastructure_error_detail"]


def test_the_dummy_token_in_an_artifact_is_recorded_rather_than_fatal(
    tmp_path: Path, monkeypatch,
) -> None:
    def invoke(self, task_id, root, _slot, _handle):
        _write_result(root, {"reward": 1})
        # Exactly what a PI agent does when it inspects its own provider config.
        (root / "transcript.jsonl").write_text(f'{{"key": "dummy-{task_id}"}}\n')
        return 0, f"dummy-{task_id}"

    _patch(monkeypatch, invoke)
    result = _run(tmp_path)

    assert result["states"] == {"terminal": 2}
    outcome = json.loads((tmp_path / "run/tasks/one/task-outcome.json").read_text())
    assert outcome["dummy_token_in_artifacts"] is True
    assert outcome["score_status"] == "scored"


def test_the_host_credential_in_an_artifact_still_stops_the_run(
    tmp_path: Path, monkeypatch,
) -> None:
    def invoke(self, task_id, root, _slot, _handle):
        _write_result(root, {"reward": 1})
        (root / "transcript.jsonl").write_text(HOST_CREDENTIAL)
        return 0, f"dummy-{task_id}"

    _patch(monkeypatch, invoke)
    with pytest.raises(SuiteFault):
        _run(tmp_path)


def test_a_zero_earned_during_a_provider_outage_is_named_as_one(
    tmp_path: Path, monkeypatch,
) -> None:
    def invoke(self, task_id, root, _slot, _handle):
        _write_result(root, {"reward": 0})
        return 0, f"dummy-{task_id}"

    def finalize(session):
        return _finalize(session, {"upstream_error_status": 2})

    _patch(monkeypatch, invoke, finalize)
    _run(tmp_path)

    outcome = json.loads((tmp_path / "run/tasks/one/task-outcome.json").read_text())
    assert outcome["score_status"] == "provider_unavailable"
    assert outcome["provider_error_requests"] == 2


def test_a_reward_earned_despite_provider_errors_still_counts(
    tmp_path: Path, monkeypatch,
) -> None:
    def invoke(self, task_id, root, _slot, _handle):
        _write_result(root, {"reward": 1})
        return 0, f"dummy-{task_id}"

    def finalize(session):
        return _finalize(session, {"upstream_error_status": 1})

    _patch(monkeypatch, invoke, finalize)
    _run(tmp_path)

    outcome = json.loads((tmp_path / "run/tasks/one/task-outcome.json").read_text())
    assert outcome["score_status"] == "scored"
