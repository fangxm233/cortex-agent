# input:  scanner CLI arguments, policy JSON, and trial files
# output: exit-code, help, fail-closed, and redaction assertions
# pos:    Command boundary tests for the artifact scanner
# >>> If I am updated, update my header and folder CORTEX.md <<<

import io
import json
from pathlib import Path

import pytest

from cortex_bench_harness.scan.cli import main

CREDENTIAL = "sk-ant-SYNTHETIC-CLI-SCAN"
CHECKOUT = "/srv/checkout/cortex"
HOSTNAME = "synthetic-cli-host"
SOURCES = ("stdout", "stderr", "events", "manifest", "workspace_diff")
FILENAMES = {
    "stdout": "stdout.txt",
    "stderr": "stderr.txt",
    "events": "events.jsonl",
    "manifest": "cortex-bench-harness-manifest.json",
    "workspace_diff": "workspace.diff",
}


def make_inputs(tmp_path: Path, content: str = "clean\n") -> tuple[list[str], Path]:
    arguments: list[str] = []
    trial_root = tmp_path / "trial"
    trial_root.mkdir()
    for source in SOURCES:
        path = trial_root / FILENAMES[source]
        path.write_text(content)
        arguments.extend([f"--{source.replace('_', '-')}-file", str(path)])
    config = tmp_path / "policy.json"
    config.write_text(json.dumps(policy_document()))
    return arguments, config


def policy_document() -> dict[str, object]:
    return {
        "secrets": {"synthetic_credential": CREDENTIAL},
        "repository_checkout": CHECKOUT,
        "hostname": HOSTNAME,
    }


def test_dirty_scan_exits_one_and_redacts_values(tmp_path: Path, capsys) -> None:
    arguments, config = make_inputs(tmp_path, f"{CREDENTIAL} {CHECKOUT} {HOSTNAME}\n")
    exit_code = main([*arguments, "--config-file", str(config)])
    output = capsys.readouterr().out
    report = json.loads(output)
    assert exit_code == 1
    assert report["ok"] is False
    assert len(report["matches"]) == 3 * len(SOURCES)
    assert all(value not in output for value in (CREDENTIAL, CHECKOUT, HOSTNAME, str(tmp_path)))


def test_clean_scan_exits_zero_after_all_sources(tmp_path: Path, capsys) -> None:
    arguments, config = make_inputs(tmp_path)
    exit_code = main([*arguments, "--config-file", str(config)])
    report = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert report["clean"] is True
    assert [item["source"] for item in report["sources"]] == list(SOURCES)


def test_config_file_accepts_stdin(tmp_path: Path, capsys) -> None:
    arguments, _ = make_inputs(tmp_path)
    stream = io.StringIO(json.dumps(policy_document()))
    exit_code = main([*arguments, "--config-file", "-"], stdin=stream)
    assert exit_code == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_unreadable_required_source_exits_two_without_path(tmp_path: Path, capsys) -> None:
    arguments, config = make_inputs(tmp_path)
    missing_path = tmp_path / "trial" / "stdout.txt"
    missing_path.unlink()
    exit_code = main([*arguments, "--config-file", str(config)])
    output = capsys.readouterr().out
    assert exit_code == 2
    assert json.loads(output)["source"] == "stdout"
    assert str(missing_path) not in output


def test_missing_source_parent_preserves_source_identity(tmp_path: Path, capsys) -> None:
    arguments, config = make_inputs(tmp_path)
    events_index = arguments.index("--events-file") + 1
    Path(arguments[events_index]).unlink()
    missing_path = tmp_path / "missing" / "events.jsonl"
    arguments[events_index] = str(missing_path)

    exit_code = main([*arguments, "--config-file", str(config)])
    output = capsys.readouterr().out
    report = json.loads(output)

    assert exit_code == 2
    assert report["source"] == "events"
    assert "--events-file" in report["hint"]
    assert str(missing_path) not in output


def test_help_has_copyable_example(capsys) -> None:
    with pytest.raises(SystemExit) as result:
        main(["--help"])
    output = capsys.readouterr().out
    assert result.value.code == 0
    assert "usage:" in output
    assert "Examples:" in output
    assert "--workspace-diff-file workspace.diff" in output
