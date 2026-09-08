# input:  current CLI discovery, version queries, namespace checks
# output: missing/failed CLI and isolation regression proofs
# pos:    Unit tests for current vendor CLI compatibility support
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import hashlib
import subprocess
from pathlib import Path

import pytest

import current_vendor_cli as current
import vendor_wire_capture as capture


@pytest.mark.parametrize("vendor", current.COMMANDS)
def test_missing_current_cli_fails(vendor: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(current.shutil, "which", lambda _command: None)

    with pytest.raises(RuntimeError, match="not installed on PATH"):
        current.installed_cli(vendor)


@pytest.mark.parametrize("vendor", current.COMMANDS)
@pytest.mark.parametrize("status,stdout,message", (
    (7, "9.9.9", r"--version failed \(7\): synthetic version failure"),
    (0, " \n", "--version returned empty output"),
))
def test_failed_or_empty_version_is_not_accepted(
    vendor: str, status: int, stdout: str, message: str,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    binary = tmp_path / "current-cli"
    binary.write_bytes(b"current")
    monkeypatch.setattr(current.shutil, "which", lambda _command: str(binary))
    result = subprocess.CompletedProcess([], status, stdout, "synthetic version failure")
    monkeypatch.setattr(current.subprocess, "run", lambda *_args, **_kwargs: result)

    with pytest.raises(RuntimeError, match=message):
        current.installed_cli(vendor)


@pytest.mark.parametrize("failure", (PermissionError("not executable"),
                                      subprocess.TimeoutExpired("cli --version", 30)))
def test_version_execution_errors_propagate(
    failure: Exception, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(current.subprocess, "run", fail)
    with pytest.raises(type(failure)):
        current.inspect_binary(tmp_path / "cli")


def test_identity_reports_resolved_executable_version_and_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture,
) -> None:
    binary = tmp_path / "actual-cli"
    binary.write_bytes(b"actual executable bytes")
    link = tmp_path / "cli"
    link.symlink_to(binary)
    calls = []

    def version(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, "9.9.9 (Claude Code)\n", "")

    monkeypatch.setattr(current.subprocess, "run", version)
    identity = current.inspect_binary(link)
    assert identity == current.CliIdentity(
        binary, "9.9.9 (Claude Code)", hashlib.sha256(binary.read_bytes()).hexdigest(),
    )
    assert calls == [([str(binary), "--version"], {
        "capture_output": True, "text": True, "timeout": 30,
    })]
    assert identity.version_output in capsys.readouterr().out


def test_namespace_guard_rejects_host_before_changing_links(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(current.socket, "if_nameindex", lambda: [(1, "lo"), (2, "eth0")])
    calls = []
    monkeypatch.setattr(current.subprocess, "run", lambda *args, **_kwargs: calls.append(args))

    with pytest.raises(AssertionError, match="loopback-only network namespace"):
        current.require_isolated_network()
    assert calls == []


@pytest.mark.parametrize("command", ("bwrap", "strace"))
def test_capture_requires_containment_tools(
    command: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(capture.shutil, "which", lambda name: None if name == command else name)
    with pytest.raises(RuntimeError, match=f"{command} is required"):
        capture._check_prerequisites(tmp_path / "claude")


def test_capture_rejects_failed_version_query(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(capture.shutil, "which", lambda name: name)
    result = subprocess.CompletedProcess([], 3, "2.1.263 (Claude Code)", "failed")
    monkeypatch.setattr(capture.subprocess, "run", lambda *_args, **_kwargs: result)
    with pytest.raises(RuntimeError, match=r"--version failed \(3\)"):
        capture._check_prerequisites(tmp_path / "claude")


def test_capture_requires_claude_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(capture.shutil, "which", lambda _name: None)
    with pytest.raises(RuntimeError, match="claude is not on PATH"):
        capture._claude_binary()
