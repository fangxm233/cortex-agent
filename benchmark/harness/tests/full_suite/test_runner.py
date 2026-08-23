# input:  two-task suite, fake task-owned proxy sessions and Harbor results
# output: one-arm-per-task execution and deterministic result proofs
# pos:    Full-suite runner integration tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import json
from pathlib import Path
from types import SimpleNamespace

from cortex_bench_harness.full_suite.config import HostInputs, load_suite_spec
from cortex_bench_harness.full_suite.runner import FullSuiteRunner
from cortex_bench_harness.full_suite.task_proxy import FinalizedProxy
from .test_config import write_spec


class FakeHandle:
    def __init__(self, task_id: str) -> None:
        self.dummy_token = f"dummy-{task_id}"
        self.base_url = f"http://proxy.full.invalid/{task_id}"

    def stop(self) -> None:
        return


def test_cancelled_runner_marks_never_started_tasks_not_run(tmp_path: Path) -> None:
    spec = load_suite_spec(write_spec(tmp_path))
    inputs = HostInputs(
        tmp_path / "tasks", tmp_path / "run", tmp_path / "images.json",
        tmp_path / "harbor", tmp_path / "node", tmp_path / "pi",
        tmp_path / "gateway", "0.0.0.0", "proxy.full.invalid",
    )
    runner = FullSuiteRunner(spec, inputs, "key")
    runner.ledger.transition("one", "arming")
    runner._mark_not_run()
    assert runner.ledger.state_of("one") == "arming"
    assert runner.ledger.state_of("two") == "not-run"


def test_runner_arms_each_task_once_and_keeps_results_ordered(
    tmp_path: Path, monkeypatch,
) -> None:
    spec = load_suite_spec(write_spec(tmp_path))
    tasks = tmp_path / "task-assets"
    for task_id in ("one", "two"):
        (tasks / task_id).mkdir(parents=True)
    inputs = HostInputs(
        tasks, tmp_path / "run", tmp_path / "images.json", tmp_path / "harbor",
        tmp_path / "node", tmp_path / "pi", tmp_path / "gateway", "0.0.0.0",
        "proxy.full.invalid",
    )
    armed: list[str] = []

    def arm(_spec, _inputs, *, task_id, task_root, **_kwargs):
        armed.append(task_id)
        proxy = task_root / "proxy"
        proxy.mkdir()
        return SimpleNamespace(handle=FakeHandle(task_id), proxy_dir=proxy)

    def invoke(self, task_id, root, _slot, _handle):
        job = root / "harbor-results/job"
        trial = job / "trial/result.json"
        trial.parent.mkdir(parents=True)
        (job / "result.json").write_text(json.dumps({"job_name": task_id}))
        trial.write_text(json.dumps({
            "exception_info": None, "verifier_result": {"rewards": {"reward": 1}},
        }))
        private = root / "control/pi-config"
        private.mkdir(parents=True)
        return 0, f"dummy-{task_id}"

    def finalize(session):
        paths = [session.proxy_dir / name for name in ("accounting.json", "lease.json", "trace.jsonl", "revoke.json")]
        for path in paths:
            path.write_text("{}\n")
        return FinalizedProxy(*paths, True)

    monkeypatch.setattr("cortex_bench_harness.full_suite.runner.create_networks", lambda _slots: None)
    monkeypatch.setattr("cortex_bench_harness.full_suite.runner.remove_networks", lambda _slots: None)
    monkeypatch.setattr("cortex_bench_harness.full_suite.runner.arm_task_proxy", arm)
    monkeypatch.setattr("cortex_bench_harness.full_suite.runner.finalize_task_proxy", finalize)
    monkeypatch.setattr(FullSuiteRunner, "_invoke_harbor", invoke)

    result = FullSuiteRunner(spec, inputs, "real-key-not-persisted").run()

    assert sorted(armed) == ["one", "two"]
    assert [task["task_id"] for task in result["tasks"]] == ["one", "two"]
    assert all(task["state"] == "terminal" for task in result["tasks"])
    for task_id in ("one", "two"):
        outcome = json.loads((inputs.run_dir / f"tasks/{task_id}/task-outcome.json").read_text())
        assert outcome["reward"] == {"reward": 1}
    assert "real-key-not-persisted" not in (inputs.run_dir / "suite-result.json").read_text()
