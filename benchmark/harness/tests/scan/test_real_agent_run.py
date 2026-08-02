# input:  pinned Debian image, installed Cortex bundle, fake Claude fixture
# output: collected real agent-run lifecycle and artifact assertions
# pos:    Container integration proof for the genuine Cortex run path
# >>> If I am updated, update my header and folder CORTEX.md <<<

from pathlib import Path

from stub_trial import run_real_agent_trial

EXPECTED_USAGE = {
    "input_tokens": 11,
    "output_tokens": 7,
    "cache_creation_input_tokens": 3,
    "cache_read_input_tokens": 5,
}


def test_real_agent_run_uses_fake_claude_and_commits_trajectory(tmp_path: Path) -> None:
    evidence = run_real_agent_trial(tmp_path)

    assert evidence.image_size_bytes == 28_242_677
    assert evidence.inherited_real_run is True
    assert evidence.run_exit_code == 0
    assert evidence.resolved_cwd == "/app"
    assert evidence.raw_usage == EXPECTED_USAGE
    assert {"assistant_text", "cost_record", "turn_complete"} <= evidence.event_types
    assert evidence.cost_record == {
        "tokens_in": 11, "tokens_out": 7, "prompt_tokens": 19,
        "cached_tokens": 5, "cost_usd": 0.001,
    }
    assert evidence.terminal_state == "completed"
    assert evidence.trajectory_validation == {"ok": True, "problems": []}
    assert evidence.scope == {
        "stub_agent_trial": False, "real_cortex_agent_run": True,
        "fake_model_backend": "claude-path-substitution", "paid_model_calls": 0,
        "other_faked_layers": [],
    }
    assert evidence.required_scan_clean is True
    assert evidence.whole_tree_scan_clean is True
    assert evidence.outbound_routes == []
