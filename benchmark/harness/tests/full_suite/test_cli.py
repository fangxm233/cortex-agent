# input:  full-suite CLI flags, stdin spec and mocked preflight
# output: explicit-flag, help and structured-JSON CLI proofs
# pos:    Full-suite CLI contract tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import cortex_bench_harness.full_suite.cli as cli


def required_args(tmp_path: Path) -> list[str]:
    values = {
        "tasks-dir": tmp_path / "tasks", "run-dir": tmp_path / "run",
        "image-inventory": tmp_path / "images.json", "harbor": tmp_path / "harbor",
        "node-root": tmp_path / "node", "pi-root": tmp_path / "pi",
        "gateway": tmp_path / "gateway.yaml",
    }
    arguments = []
    for name, value in values.items():
        arguments.extend((f"--{name}", str(value)))
    arguments.extend(("--proxy-listen-host", "0.0.0.0"))
    arguments.extend(("--proxy-advertised-host", "proxy.full.invalid"))
    return arguments


def test_help_has_copyable_preflight_and_run_examples(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        cli.build_parser().parse_args(["--help"])
    output = capsys.readouterr().out
    assert exit_info.value.code == 0
    assert "Examples:" in output
    assert "--preflight" in output
    assert "--run" in output


def test_preflight_success_is_structured_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        cli, "load_suite_spec", lambda _path: SimpleNamespace(outstanding_prerequisites=()))
    monkeypatch.setattr(cli, "preflight", lambda _spec, _inputs: {
        "ok": True, "provider_requests": 0, "task_count": 89,
    })
    code = cli.main(["--spec", str(tmp_path / "suite.yaml"), *required_args(tmp_path)])
    output = json.loads(capsys.readouterr().out)
    assert (code, output["ok"], output["provider_requests"]) == (0, True, 0)


def test_paid_run_is_blocked_while_prerequisites_are_outstanding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    spec = SimpleNamespace(outstanding_prerequisites=("timeout-containment",))
    monkeypatch.setattr(cli, "load_suite_spec", lambda _path: spec)
    monkeypatch.setattr(cli, "preflight", lambda _spec, _inputs: {"ok": True})
    code = cli.main([
        "--spec", str(tmp_path / "suite.yaml"), *required_args(tmp_path), "--run"])
    assert code == 1
    assert "outstanding prerequisites" in json.loads(capsys.readouterr().err)["error"]


def test_invalid_spec_returns_json_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    code = cli.main(["--spec", str(tmp_path / "missing.yaml"), *required_args(tmp_path)])
    captured = capsys.readouterr()
    assert (code, captured.out) == (1, "")
    assert json.loads(captured.err)["ok"] is False
