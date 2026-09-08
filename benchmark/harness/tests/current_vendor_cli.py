# input:  PATH vendor CLIs, subprocess, Linux network namespaces
# output: current CLI identities and loopback-only test execution
# pos:    Shared support for current vendor CLI compatibility tests
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import hashlib
import os
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

COMMANDS = {"pi": "pi", "claude-code": "claude", "codex": "codex"}
ISOLATED_ENV = "CORTEX_CURRENT_VENDOR_CLI_ISOLATED"
HARNESS_DIR = Path(__file__).resolve().parents[1]
# PI loads its Node module graph even for --version (observed >10s on a busy host).
VERSION_QUERY_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class CliIdentity:
    binary: Path
    version_output: str
    artifact_sha256: str


def inspect_binary(binary: Path) -> CliIdentity:
    binary = binary.resolve()
    completed = subprocess.run(
        [str(binary), "--version"], capture_output=True, text=True,
        timeout=VERSION_QUERY_TIMEOUT_SECONDS,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"{binary} --version failed ({completed.returncode}): {completed.stderr}")
    version = completed.stdout.strip()
    if not version:
        raise RuntimeError(f"{binary} --version returned empty output")
    with binary.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    identity = CliIdentity(binary, version, digest)
    print(f"Current CLI: {binary}: {version}; sha256={digest}", flush=True)
    return identity


def installed_cli(vendor: str) -> CliIdentity:
    command = COMMANDS[vendor]
    binary = shutil.which(command)
    if binary is None:
        raise RuntimeError(f"{command} is not installed on PATH")
    return inspect_binary(Path(binary))


def require_isolated_network() -> None:
    # Do not trust the recursion marker: a host invocation must never run wire traffic.
    interfaces = {name for _index, name in socket.if_nameindex()}
    assert interfaces == {"lo"}, f"expected loopback-only network namespace, got {interfaces}"
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    routes = Path("/proc/net/route").read_text(encoding="utf-8").splitlines()[1:]
    assert not any(row.split()[1] == "00000000" for row in routes if row.split())


def isolated_or_rerun(request: pytest.FixtureRequest) -> bool:
    if os.environ.get(ISOLATED_ENV) == "1":
        require_isolated_network()
        return True
    unshare = shutil.which("unshare")
    assert unshare, "unshare is required for zero-egress vendor CLI tests"
    target = f"{request.path}::{request.node.nodeid.split('::', 1)[1]}"
    result = subprocess.run(
        [unshare, "--user", "--map-root-user", "--net", sys.executable,
         "-m", "pytest", "-q", "-s", target],
        cwd=HARNESS_DIR, env={**os.environ, ISOLATED_ENV: "1"},
        capture_output=True, text=True, timeout=180,
    )
    print(result.stdout, end="", flush=True)
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    return False
