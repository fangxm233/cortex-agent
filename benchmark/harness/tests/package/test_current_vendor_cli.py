# input:  current CLI discovery, version queries, namespace checks
# output: missing/failed CLI and isolation regression proofs
# pos:    Unit tests for current vendor CLI compatibility support
# >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

from pathlib import Path

import pytest

import current_vendor_cli as current
import vendor_wire_capture as capture


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
