# input:  Harbor base class, fake exec results, npm artifact
# output: install, CLI version, manifest, and argv assertions
# pos:    Contract tests for the Harbor agent wrapper
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
from collections.abc import Sequence
from pathlib import Path

import pytest
from harbor.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult

from cortex_bench_harness.harbor_agent import CortexBenchAgent

ARTIFACT_NAME = "cortex-agent-server-test.tgz"
INSTALL_COMMAND = (
    "set -o pipefail; npm install --global --prefix /installed-agent/npm "
    f"--no-audit --no-fund /installed-agent/{ARTIFACT_NAME}"
    " && ln -sfn /installed-agent/npm/bin/cortex /usr/local/bin/cortex"
)
VERIFY_COMMANDS = [
    "set -o pipefail; command -v cortex >/dev/null 2>&1",
    "set -o pipefail; cortex agent-run --help >/dev/null",
    "set -o pipefail; package_root=\"$(npm ls --global --parseable --depth=0 "
    "--prefix /installed-agent/npm @cortex-agent/server)\""
    " && test -x \"$package_root/native/cortex-supervisor/dist/cortex-supervisor\"",
]
VERSION_COMMAND = "set -o pipefail; cortex daemon --version"


class FakeEnvironment:
    def __init__(self, results: Sequence[ExecResult]) -> None:
        self._results = iter(results)
        self.calls: list[tuple[str, str | int | None]] = []
        self.uploads: list[tuple[Path | str, str]] = []

    async def exec(self, command: str, **kwargs: object) -> ExecResult:
        user = kwargs.get("user")
        assert user is None or isinstance(user, (str, int))
        self.calls.append((command, user))
        return next(self._results)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((source_path, target_path))


def ok(stdout: str | None = None) -> ExecResult:
    return ExecResult(stdout=stdout, return_code=0)


def setup_results() -> list[ExecResult]:
    return [
        ok("/app\n"), ok("/app\n"), ok(), ok(), ok(), ok(), ok(), ok(),
        ok("2026.7.31\n"),
    ]


def make_agent(tmp_path: Path) -> CortexBenchAgent:
    wheel_path = tmp_path / "cortex_bench_harness-0.1.0-py3-none-any.whl"
    lockfile_path = tmp_path / "uv.lock"
    npm_artifact_path = tmp_path / ARTIFACT_NAME
    wheel_path.write_bytes(b"wheel")
    lockfile_path.write_bytes(b"lock")
    npm_artifact_path.write_bytes(b"npm artifact")
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent",
        artifact_dir=tmp_path / "artifacts",
        manifest={
            "root_run_id": "root-install-only",
            "trial_id": "trial-install-only",
            "arm": "cortex-direct",
            "wheel_path": str(wheel_path),
            "lockfile_path": str(lockfile_path),
            "lockfile_manifest_path": "benchmark/harness/uv.lock",
            "npm_artifact_path": str(npm_artifact_path),
            "image_ref": "debian@sha256:abc",
            "image_digest": None,
            "image_size_bytes": None,
        },
    )


def test_wrapper_is_real_harbor_installed_agent() -> None:
    assert issubclass(CortexBenchAgent, BaseInstalledAgent)
    assert CortexBenchAgent.import_path().endswith(":CortexBenchAgent")


def test_setup_installs_bundle_as_root_and_verifies_as_agent(tmp_path: Path) -> None:
    environment = FakeEnvironment(setup_results())
    agent = make_agent(tmp_path)

    asyncio.run(agent.setup(environment))

    assert environment.calls == [
        ("pwd", None),
        ("realpath -- /app", None),
        ("test -d /app", None),
        ("[ -d /installed-agent ] || mkdir -p /installed-agent", "root"),
        (INSTALL_COMMAND, "root"),
        *((command, None) for command in VERIFY_COMMANDS),
        (VERSION_COMMAND, None),
    ]
    staged = tmp_path / "agent/setup" / ARTIFACT_NAME
    assert staged.read_bytes() == b"npm artifact"
    assert environment.uploads == [(staged, f"/installed-agent/{ARTIFACT_NAME}")]
    manifest = tmp_path / "artifacts/cortex-bench-harness-manifest.json"
    assert manifest.is_file()
    assert '"version": "2026.7.31"' in manifest.read_text()


def test_failed_install_does_not_publish_manifest(tmp_path: Path) -> None:
    failed = ExecResult(stderr="corrupt artifact", return_code=1)
    results = [ok("/app\n"), ok("/app\n"), ok(), ok(), failed]
    environment = FakeEnvironment(results)

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path).setup(environment))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


@pytest.mark.parametrize("failed_check", range(3))
def test_failed_verification_does_not_publish_manifest(
    tmp_path: Path, failed_check: int,
) -> None:
    failure = ExecResult(stderr=f"verification {failed_check} failed", return_code=1)
    results = [ok("/app\n"), ok("/app\n"), ok(), ok(), ok()]
    results.extend([ok()] * failed_check)
    results.append(failure)
    environment = FakeEnvironment(results)

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path).setup(environment))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


def test_failed_version_probe_does_not_publish_manifest(tmp_path: Path) -> None:
    failure = ExecResult(stderr="version probe failed", return_code=1)
    results = [ok("/app\n"), ok("/app\n"), ok(), ok(), ok(), ok(), ok(), ok(), failure]

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


def test_empty_version_probe_does_not_publish_manifest(tmp_path: Path) -> None:
    results = [ok("/app\n"), ok("/app\n"), ok(), ok(), ok(), ok(), ok(), ok(), ok("\n")]

    with pytest.raises(RuntimeError, match="version"):
        asyncio.run(make_agent(tmp_path).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


def test_preview_argv_contains_resolved_cwd(tmp_path: Path) -> None:
    agent = make_agent(tmp_path)
    asyncio.run(agent.setup(FakeEnvironment(setup_results())))

    assert agent.preview_run_argv() == [
        "cortex", "agent-run", "--prompt-file", "/logs/agent/instruction.md",
        "--agent-slot", "parent", "--profile", "benchmark", "--cwd", "/app",
        "--output-format", "jsonl", "--events-file",
        "/logs/agent/trajectory/events.jsonl", "--trajectory-root",
        "/logs/agent/trajectory", "--root-run-id", "root-install-only",
    ]
