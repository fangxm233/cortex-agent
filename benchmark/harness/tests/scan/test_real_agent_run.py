# input:  dynamic trial helpers, fake Claude, Docker opt-in gate
# output: gated thread, child merge, mutation, and scan assertions
# pos:    Opt-in container proof for the real Cortex run path
# >>> If I am updated, update my header and folder CORTEX.md <<<

from docker_gate import require_docker_opt_in

require_docker_opt_in()

import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import stub_trial
from cortex_bench_harness.launcher.arm_resolution import ContainerFacts
from stub_trial import (
    TrialEvidence,
    result_surface_files,
    run_real_agent_trial,
    write_workspace_diff,
)

EXPECTED_USAGE = {
    "input_tokens": 11,
    "output_tokens": 7,
    "cache_creation_input_tokens": 3,
    "cache_read_input_tokens": 5,
}
EXPECTED_ATIF_VALIDATION = {
    "ok": True, "errors": [],
    "validator": "harbor.utils.trajectory_validator.TrajectoryValidator",
    "harbor_version": "0.20.0",
}
EXPECTED_SCOPE = {
    "stub_agent_trial": False, "real_cortex_agent_run": True,
    "fake_model_backend": "claude-path-substitution", "paid_model_calls": 0,
    "other_faked_layers": [],
}


def journal_metric_arithmetic(events: tuple[dict[str, object], ...]) -> dict[str, int | float]:
    costs = [event for event in events if event["type"] == "cost_record"]
    turns = [event for event in events if event["type"] == "turn_complete"]
    return {
        "total_prompt_tokens": sum(int(event["prompt_tokens"]) for event in costs),
        "total_completion_tokens": sum(int(event["tokens_out"]) for event in costs),
        "total_cached_tokens": sum(int(event["cached_tokens"]) for event in costs),
        "total_cost_usd": sum(float(event["cost_usd"]) for event in costs),
        "total_steps": sum(int(event["numTurns"]) for event in turns),
    }


def test_workspace_diff_captures_added_workspace_bytes(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    artifacts = tmp_path / "trial" / "artifacts"
    workspace.mkdir()
    artifacts.mkdir(parents=True)
    (workspace / "result.txt").write_bytes(b"planted-workspace-value")
    layout = SimpleNamespace(
        workspace=workspace, trial_paths=SimpleNamespace(artifacts_dir=artifacts),
    )

    output = write_workspace_diff(layout)

    assert b"b/result.txt" in output.read_bytes()
    assert b"planted-workspace-value" in output.read_bytes()


def test_whole_tree_file_list_includes_staged_setup_artifact(tmp_path: Path) -> None:
    agent = tmp_path / "trial" / "agent"
    verifier = tmp_path / "trial" / "verifier"
    artifacts = tmp_path / "trial" / "artifacts"
    staged = agent / "setup" / "cortex.tgz"
    staged.parent.mkdir(parents=True)
    verifier.mkdir(parents=True)
    artifacts.mkdir(parents=True)
    staged.write_bytes(b"package")
    layout = SimpleNamespace(
        trial_paths=SimpleNamespace(
            agent_dir=agent, verifier_dir=verifier, artifacts_dir=artifacts,
        ),
    )

    assert staged in result_surface_files(layout)


def test_partial_environment_start_is_cleaned_up(monkeypatch) -> None:
    class FailingEnvironment:
        stopped = False

        async def start(self, force_build: bool) -> None:
            raise RuntimeError("partial start")

        async def stop(self, delete: bool) -> None:
            self.stopped = True

    environment = FailingEnvironment()
    monkeypatch.setattr(stub_trial, "create_environment", lambda _layout: environment)
    monkeypatch.setattr(stub_trial, "create_agent", lambda _layout, _image: object())

    with pytest.raises(RuntimeError, match="partial start"):
        asyncio.run(stub_trial.execute_trial(object(), {}))

    assert environment.stopped is True


def test_component_fixture_supplies_its_document_through_the_hook(tmp_path: Path) -> None:
    image = {"image_ref": stub_trial.IMAGE_REF, "image_digest": stub_trial.IMAGE_DIGEST,
             "image_size_bytes": 1}
    layout = SimpleNamespace(
        trial_paths=SimpleNamespace(
            agent_dir=tmp_path / "agent", artifacts_dir=tmp_path / "artifacts",
        ),
        wheel_path=tmp_path / "harness.whl", harness_dir=tmp_path,
        npm_artifact=tmp_path / "server.tgz",
    )

    agent = stub_trial.create_agent(layout, image)
    facts = ContainerFacts("/bundle", "/opt/fake-bin/claude", "2.1.999")

    assert not {"roles", "thread_templates", "thread_agents", "cli_artifact"} & set(
        stub_trial.trial_seed(image),
    )
    assert agent._compose_arm_resolution(facts) == stub_trial.arm_resolution_document(image)


def test_fake_claude_reports_its_version_without_a_trial_artifact_dir() -> None:
    result = subprocess.run(
        [str(Path(__file__).with_name("fake_claude.sh")), "--version"],
        text=True, capture_output=True, check=True, env={"PATH": os.environ["PATH"]},
    )

    assert result.stdout.strip() == "2.1.999 (Cortex benchmark fake)"


def test_fake_claude_emits_canonical_assistant_role(tmp_path: Path) -> None:
    request = {"type": "user", "message": {"role": "user"}, "session_id": "fixture-session"}
    environment = {
        "PATH": os.environ["PATH"], "FAKE_CLAUDE_ARTIFACT_DIR": str(tmp_path),
    }
    result = subprocess.run(
        [
            str(Path(__file__).with_name("fake_claude.sh")), "-p",
            "--system-prompt", "You are a code implementer.",
        ],
        input=json.dumps(request, separators=(",", ":")) + "\n",
        text=True, capture_output=True, check=True, env=environment,
    )
    assistant = json.loads(result.stdout.splitlines()[0])

    assert assistant["type"] == "assistant"
    assert assistant["message"]["role"] == "assistant"


def assert_dynamic_run_surface(evidence: TrialEvidence) -> None:
    assert evidence.image_size_bytes == 28_242_677
    assert evidence.inherited_real_run is True
    assert evidence.run_exit_code == 0
    assert evidence.resolved_cwd == "/app"
    assert evidence.raw_usage == EXPECTED_USAGE
    assert {"tool_use", "tool_result", "cost_record", "turn_complete"} <= evidence.event_types
    assert evidence.cost_record == {
        "tokens_in": 19, "tokens_out": 7, "prompt_tokens": 19,
        "cached_tokens": 5, "cost_usd": 0.001,
    }
    assert evidence.mcp_composition == "benchmark-thread-run"
    assert evidence.fake_roles == ("parent", "benchmark-coder", "benchmark-reviewer")
    assert evidence.terminal_state == "completed"
    assert evidence.recorded_journal_path == "events.jsonl"
    assert evidence.trajectory_validation == {"ok": True, "problems": []}


def assert_child_aggregation(evidence: TrialEvidence) -> None:
    assert evidence.child_agent_slots == frozenset({"benchmark-coder", "benchmark-reviewer"})
    assert len(evidence.child_journal_paths) == 1
    assert all(path.is_file() for path in evidence.child_journal_paths)
    all_events = tuple(event for fragment in evidence.fragment_events for event in fragment)
    expected_metrics = journal_metric_arithmetic(all_events)
    assert expected_metrics == {
        "total_prompt_tokens": 62, "total_completion_tokens": 24,
        "total_cached_tokens": 15, "total_cost_usd": 0.006, "total_steps": 3,
    }
    assert evidence.final_metrics == expected_metrics
    assert all(value is not None for value in evidence.final_metrics.values())
    assert evidence.subagent_count == 1
    assert evidence.fail_closed_reasons == {
        "corrupted_child": "malformed_fragment",
        "missing_child": "missing_child_fragment",
    }
    assert evidence.merged_trajectory_path.is_file()
    assert evidence.atif_validation == EXPECTED_ATIF_VALIDATION


def assert_trial_safety(evidence: TrialEvidence) -> None:
    assert re.fullmatch(r"\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?", evidence.cortex_cli_version)
    assert evidence.scope == EXPECTED_SCOPE
    assert evidence.required_scan_clean is True
    assert evidence.whole_tree_scan_clean is True
    assert evidence.outbound_routes == []


def test_real_agent_run_blocks_on_thread_and_merges_child_usage(tmp_path: Path) -> None:
    evidence = run_real_agent_trial(tmp_path)

    assert_dynamic_run_surface(evidence)
    assert_child_aggregation(evidence)
    assert_trial_safety(evidence)
