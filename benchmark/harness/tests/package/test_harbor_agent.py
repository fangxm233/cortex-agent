# input:  Harbor base class, fake exec results, trial seed
# output: install, container-fact discovery, and composed run-config proofs
# pos:    Contract tests for the Harbor agent wrapper
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import override

import pytest
from harbor.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.arm_resolution import ContainerFacts

ARTIFACT_NAME = "cortex-agent-server-test.tgz"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
BACKEND_CLI_PATH = "/usr/local/bin/claude"
BACKEND_CLI_VERSION = "1.2.3 (Claude Code)"
DIGEST = f"sha256:{'a' * 64}"
INSTALL_COMMAND = (
    "set -o pipefail; npm install --global --prefix /installed-agent/npm "
    f"--no-audit --no-fund /installed-agent/{ARTIFACT_NAME}"
    " && ln -sfn /installed-agent/npm/bin/cortex /usr/local/bin/cortex"
)
VERIFY_COMMANDS = [
    "set -o pipefail; command -v cortex >/dev/null 2>&1",
    "set -o pipefail; cortex agent-run --help >/dev/null",
]
DISCOVERY_COMMANDS = [
    "set -o pipefail; npm ls --global --parseable --depth=0 "
    "--prefix /installed-agent/npm @cortex-agent/server",
    f"set -o pipefail; test -x {BUNDLE_ROOT}/native/cortex-supervisor/dist/cortex-supervisor",
    'set -o pipefail; realpath -- "$(command -v claude)"',
    "set -o pipefail; claude --version",
]
VERSION_COMMAND = "set -o pipefail; cortex daemon --version"
BUNDLE_ROOT_RESULT = 7
CLI_PATH_RESULT = 9
CLI_VERSION_RESULT = 10


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


def install_results() -> list[ExecResult]:
    return [
        ok("/app\n"), ok("/app\n"), ok(), ok(), ok(),
        ok(), ok(),
        ok(f"{BUNDLE_ROOT}\n"), ok(),
        ok(f"{BACKEND_CLI_PATH}\n"), ok(f"{BACKEND_CLI_VERSION}\n"),
    ]


def setup_results() -> list[ExecResult]:
    return [*install_results(), ok("2026.7.31\n")]


def manifest_seed(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "cortex_bench_harness-0.1.0-py3-none-any.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / ARTIFACT_NAME,
    }
    for name, file in files.items():
        file.write_bytes(b"npm artifact" if name == "npm_artifact_path" else b"fixture")
    return {
        "root_run_id": "root-install-only", "trial_id": "trial-install-only",
        "arm": "cortex-direct", **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": "debian@sha256:abc", "image_digest": None,
        "image_size_bytes": None,
    }


def direct_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": "cortex-direct",
        "backend": "claude", "provider": "anthropic", "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 90,
        },
    }


def trial_seed(overrides: dict[str, object] | None = None) -> dict[str, object]:
    seed: dict[str, object] = {
        "arm": direct_arm(), "arm_path": "arm://cortex-direct",
        "trial_id": "trial-install-only", "root_run_id": "root-install-only",
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {"upstream_base_url": "https://api.anthropic.com",
                       "route_identity_host": "api.anthropic.com",
                       "proxy_base_url": "http://trial-proxy.invalid",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": None,
    }
    seed.update(overrides or {})
    return seed


def make_agent(
    tmp_path: Path,
    *,
    version: str = "0.1.0",
    seed_overrides: dict[str, object] | None = None,
) -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        version=version, trial_seed=trial_seed(seed_overrides),
        manifest=manifest_seed(tmp_path),
    )


def test_wrapper_is_real_harbor_installed_agent() -> None:
    assert issubclass(CortexBenchAgent, BaseInstalledAgent)
    assert CortexBenchAgent.import_path().endswith(":CortexBenchAgent")


def test_setup_installs_bundle_and_discovers_container_facts(tmp_path: Path) -> None:
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
        *((command, None) for command in DISCOVERY_COMMANDS),
        (VERSION_COMMAND, None),
    ]
    staged = tmp_path / "agent/setup" / ARTIFACT_NAME
    assert staged.read_bytes() == b"npm artifact"
    assert environment.uploads == [(staged, f"/installed-agent/{ARTIFACT_NAME}")]
    manifest = tmp_path / "artifacts/cortex-bench-harness-manifest.json"
    assert manifest.is_file()
    assert '"version": "2026.7.31"' in manifest.read_text()


def test_setup_composes_the_resolution_from_the_discovered_facts(tmp_path: Path) -> None:
    agent = make_agent(tmp_path)

    asyncio.run(agent.setup(FakeEnvironment(setup_results())))

    document = json.loads((tmp_path / "agent/arm-resolution.json").read_text())
    parent = document["roles"]["parent"]
    assert document["schema_version"] == "cortex-benchmark-arm-resolution/1"
    assert document["cli_artifact"] == {
        "path": BACKEND_CLI_PATH, "version": BACKEND_CLI_VERSION,
    }
    assert parent["system_prompt_path"] == (
        f"{BUNDLE_ROOT}/defaults/prompts/systemPrompts/direct.md"
    )
    assert parent["plugin_dirs"] == [
        f"{BUNDLE_ROOT}/defaults/plugins/cortex-common",
        f"{BUNDLE_ROOT}/defaults/plugins/cortex-coder",
    ]
    assert parent["mcp_config_paths"] == []


def test_failed_install_does_not_publish_manifest(tmp_path: Path) -> None:
    failed = ExecResult(stderr="corrupt artifact", return_code=1)
    results = [ok("/app\n"), ok("/app\n"), ok(), ok(), failed]
    environment = FakeEnvironment(results)

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path).setup(environment))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


@pytest.mark.parametrize("failed_check", range(6))
def test_failed_verification_does_not_publish_manifest(
    tmp_path: Path, failed_check: int,
) -> None:
    failure = ExecResult(stderr=f"verification {failed_check} failed", return_code=1)
    results = install_results()[: 5 + failed_check]
    results.append(failure)
    environment = FakeEnvironment(results)

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path).setup(environment))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()
    assert not (tmp_path / "agent/arm-resolution.json").exists()


@pytest.mark.parametrize(
    ("empty_probe", "message"),
    [
        (BUNDLE_ROOT_RESULT, "bundle root"),
        (CLI_PATH_RESULT, "claude CLI path"),
        (CLI_VERSION_RESULT, "claude CLI version"),
    ],
)
def test_empty_container_fact_probe_fails_closed(
    tmp_path: Path, empty_probe: int, message: str,
) -> None:
    results = install_results()
    results[empty_probe] = ok("\n")

    with pytest.raises(RuntimeError, match=message):
        asyncio.run(make_agent(tmp_path).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()
    assert not (tmp_path / "agent/arm-resolution.json").exists()


def test_failed_version_probe_does_not_publish_manifest(tmp_path: Path) -> None:
    failure = ExecResult(stderr="version probe failed", return_code=1)
    results = [*install_results(), failure]

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


def test_empty_version_probe_does_not_publish_manifest(tmp_path: Path) -> None:
    results = [*install_results(), ok("\n")]

    with pytest.raises(RuntimeError, match="version"):
        asyncio.run(make_agent(tmp_path).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


def test_preview_argv_contains_resolved_cwd_and_arm_resolution(tmp_path: Path) -> None:
    agent = make_agent(tmp_path)
    asyncio.run(agent.setup(FakeEnvironment(setup_results())))

    assert agent.preview_run_argv() == [
        "cortex", "agent-run", "--prompt-file", "/logs/agent/instruction.md",
        "--agent-slot", "parent", "--profile", "benchmark", "--cwd", "/app",
        "--output-format", "jsonl", "--events-file",
        "/logs/agent/trajectory/events.jsonl", "--trajectory-root",
        "/logs/agent/trajectory", "--root-run-id", "root-install-only",
        "--run-config", "/logs/agent/arm-resolution.json",
    ]
    resolution = json.loads((tmp_path / "agent/arm-resolution.json").read_text())
    assert resolution["root_run_id"] == "root-install-only"


def test_preview_argv_requires_a_completed_setup(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="setup"):
        make_agent(tmp_path).preview_run_argv()


def test_constructor_accepts_one_explicit_version_keyword(tmp_path: Path) -> None:
    agent = make_agent(tmp_path, version="2026.8.3")

    assert agent.version() == "2026.8.3"


@pytest.mark.parametrize(
    ("field", "value"),
    [("root_run_id", "another-run"), ("profile_name", "another-profile")],
)
def test_constructor_rejects_trial_seed_binding_mismatch(
    tmp_path: Path, field: str, value: str,
) -> None:
    with pytest.raises(ValueError, match=field):
        make_agent(tmp_path, seed_overrides={field: value})


@pytest.mark.parametrize(
    "launcher_owned",
    ["schema_version", "roles", "thread_templates", "cli_artifact", "credential_capabilities"],
)
def test_constructor_rejects_launcher_owned_seed_fields(
    tmp_path: Path, launcher_owned: str,
) -> None:
    with pytest.raises(ValueError, match=launcher_owned):
        make_agent(tmp_path, seed_overrides={launcher_owned: {}})


class FixtureCompositionAgent(CortexBenchAgent):
    """Component-fixture subclass: supplies its own document through the hook."""

    fixture_document: dict[str, object] = {"schema_version": "component-fixture/1"}
    observed_facts: ContainerFacts | None = None

    @override
    def _compose_arm_resolution(self, facts: ContainerFacts) -> dict[str, object]:
        self.observed_facts = facts
        return self.fixture_document


def test_component_fixture_subclass_supplies_its_document_through_the_hook(
    tmp_path: Path,
) -> None:
    agent = FixtureCompositionAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest=manifest_seed(tmp_path), trial_seed=trial_seed(),
    )

    asyncio.run(agent.setup(FakeEnvironment(setup_results())))

    assert json.loads((tmp_path / "agent/arm-resolution.json").read_text()) == {
        "schema_version": "component-fixture/1",
    }
    assert agent.observed_facts == ContainerFacts(
        BUNDLE_ROOT, BACKEND_CLI_PATH, BACKEND_CLI_VERSION,
    )
