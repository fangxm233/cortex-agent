# input:  Harbor base class, fake exec results, manifest and production trial seed
# output: production route proof plus preserved legacy dispatch
# pos:    Contract tests for the production Harbor agent wrapper
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import hashlib
import json
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace

import pytest
from harbor.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult

from cortex_bench_harness.campaign_config import load_campaign_config
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.production_arms import ProductionArmError
from cortex_bench_harness.launcher.production_session import (
    ProductionServerSession,
    ProductionSessionError,
)
from cortex_bench_harness.launcher.trial_admission import HarborTrialAdmissionError

ARTIFACT_NAME = "cortex-agent-server-test.tgz"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
BACKEND_CLI_PATH = "/usr/local/bin/pi"
BACKEND_CLI_VERSION = "0.82.1"
DIGEST = f"sha256:{'a' * 64}"
CAMPAIGNS_DIR = Path(__file__).resolve().parents[3] / "campaigns"
INSTALL_COMMAND = (
    "set -o pipefail; npm install --global --prefix /installed-agent/npm "
    f"--cache /installed-agent/npm-cache --offline --no-audit --no-fund "
    f"/installed-agent/{ARTIFACT_NAME}"
    " && ln -sfn /installed-agent/npm/bin/cortex /usr/local/bin/cortex"
)
VERIFY_COMMANDS = [
    "set -o pipefail; command -v cortex >/dev/null 2>&1",
    "set -o pipefail; cortex-evidence-export --help >/dev/null",
]
DISCOVERY_COMMANDS = [
    "set -o pipefail; npm ls --global --parseable --depth=0 "
    "--prefix /installed-agent/npm --cache /installed-agent/npm-cache "
    "--offline @cortex-agent/server",
    f"set -o pipefail; test -f {BUNDLE_ROOT}/dist/entry/production-app-bootstrap.js",
    'set -o pipefail; realpath -- "$(command -v pi)"',
    "set -o pipefail; pi --version",
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


class FakeProxySession:
    def __init__(self, request_count: int = 1) -> None:
        self.handle = SimpleNamespace(
            trial_id="trial-install-only",
            manifest_block={"schema_version": "cortex-bench-proxy-manifest/1"},
            accounting_export={
                "requests": {"status": "available", "value": request_count},
                "audit_log": {
                    "status": "available",
                    "value": {
                        "durable_requests": request_count,
                        "agrees_with_counters": True,
                    },
                },
            },
        )

    @staticmethod
    def credential_block(seed: object) -> dict[str, str]:
        return {
            "proxy_base_url": "http://trial-install-only.proxy.invalid:49152",
            "dummy_token_ref": "offline-token-handle",
        }


def ok(stdout: str | None = None) -> ExecResult:
    return ExecResult(stdout=stdout, return_code=0)


def install_results() -> list[ExecResult]:
    return [
        ok("/app\n"), ok("/app\n"), ok(), ok(), ok(), ok(), ok(),
        ok(f"{BUNDLE_ROOT}\n"), ok(), ok(f"{BACKEND_CLI_PATH}\n"),
        ok(f"{BACKEND_CLI_VERSION}\n"),
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
        "image_ref": f"registry.invalid/task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": None,
    }


def direct_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": "cortex-direct",
        "backend": "pi", "provider": "deepseek", "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 90, "max_output_tokens": 65536,
        },
    }


def trial_seed(overrides: dict[str, object] | None = None) -> dict[str, object]:
    seed: dict[str, object] = {
        "arm": direct_arm(), "arm_path": "arm://cortex-direct",
        "trial_id": "trial-install-only", "root_run_id": "root-install-only",
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {"upstream_base_url": "http://synthetic.invalid",
                       "route_identity_host": "api.deepseek.com",
                       "proxy_base_url": "http://trial-install-only.proxy.invalid",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": {"policy": "exact"},
    }
    seed.update(overrides or {})
    return seed


def make_agent(
    tmp_path: Path, *, version: str = "0.1.0",
    seed_overrides: dict[str, object] | None = None, attach_proxy: bool = False,
) -> CortexBenchAgent:
    agent = CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        version=version, trial_seed=trial_seed(seed_overrides),
        manifest=manifest_seed(tmp_path),
    )
    if attach_proxy:
        agent._proxy_session = FakeProxySession()
        agent._revoke_proxy = lambda: None
    return agent


def test_wrapper_is_real_harbor_installed_agent() -> None:
    assert issubclass(CortexBenchAgent, BaseInstalledAgent)
    assert CortexBenchAgent.import_path().endswith(":CortexBenchAgent")


def test_setup_installs_attests_fresh_home_and_never_composes_standalone(
    tmp_path: Path,
) -> None:
    environment = FakeEnvironment(setup_results())
    agent = make_agent(tmp_path, attach_proxy=True)

    asyncio.run(agent.setup(environment))

    assert environment.calls == [
        ("pwd", None), ("realpath -- /app", None), ("test -d /app", None),
        ("[ -d /installed-agent ] || mkdir -p /installed-agent", "root"),
        (INSTALL_COMMAND, "root"),
        *((command, None) for command in VERIFY_COMMANDS),
        *((command, None) for command in DISCOVERY_COMMANDS),
        (VERSION_COMMAND, None),
    ]
    assert all("agent-run" not in command for command, _ in environment.calls)
    assert not (tmp_path / "agent/arm-resolution.json").exists()
    source = tmp_path / ARTIFACT_NAME
    assert environment.uploads == [(source, f"/installed-agent/{ARTIFACT_NAME}")]
    manifest = json.loads(
        (tmp_path / "artifacts/cortex-bench-harness-manifest.json").read_text()
    )
    assert manifest["cortex_cli"]["version"] == "2026.7.31"
    attestation = json.loads(
        (tmp_path / "artifacts/cortex-bench-launch-attestation.json").read_text()
    )
    assert attestation["capture_boundary"] == "launcher_pre_boot"
    assert attestation["npm_artifact_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert (tmp_path / "agent/production-cortex-home/config/profiles.json").is_file()


@pytest.mark.parametrize(
    "config_name",
    ["zero-paid-dry-run.yaml", "zero-paid-failed-agent.yaml", "zero-paid-parallel.yaml"],
)
def test_committed_zero_paid_direct_campaigns_materialize_the_production_bundle(
    tmp_path: Path, config_name: str,
) -> None:
    (arm,) = load_campaign_config(CAMPAIGNS_DIR / config_name).arms
    seed = trial_seed({"arm": arm, "arm_path": f"arm://{arm['name']}"})
    manifest = manifest_seed(tmp_path)
    manifest["arm"] = arm["name"]
    agent = CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        trial_seed=seed, manifest=manifest,
    )
    agent._proxy_session = FakeProxySession()
    agent._revoke_proxy = lambda: None

    asyncio.run(agent.setup(FakeEnvironment(setup_results())))

    assert (tmp_path / "agent/production-cortex-home/config/profiles.json").is_file()
    assert not (tmp_path / "agent/arm-resolution.json").exists()


def test_production_direct_requires_the_trial_scoped_proxy_before_setup(tmp_path: Path) -> None:
    environment = FakeEnvironment([])

    with pytest.raises(HarborTrialAdmissionError, match="proxy"):
        asyncio.run(make_agent(tmp_path).setup(environment))

    assert environment.calls == []


def test_setup_materializes_before_any_production_process_spawn(tmp_path: Path) -> None:
    environment = FakeEnvironment(setup_results())
    agent = make_agent(tmp_path, attach_proxy=True)

    asyncio.run(agent.setup(environment))

    assert (tmp_path / "artifacts/cortex-bench-launch-attestation.json").is_file()
    assert not any(
        command.startswith("set -o pipefail; node ")
        and "dist/entry/production-app-bootstrap.js" in command
        for command, _ in environment.calls
    )


def test_direct_run_dispatches_the_production_session_not_agent_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment = FakeEnvironment(setup_results())
    agent = make_agent(tmp_path, attach_proxy=True)
    observed: list[str] = []

    async def run_production(
        self: ProductionServerSession, instruction: str, execute: object,
    ) -> None:
        observed.append(instruction)
        self._stopped_cleanly = True

    monkeypatch.setattr(ProductionServerSession, "run", run_production)
    asyncio.run(agent.setup(environment))
    asyncio.run(agent.run("Solve through production.", environment, None))

    assert observed == ["Solve through production."]
    assert agent.production_server_stopped is True
    assert all("cortex agent-run" not in command for command, _ in environment.calls)


def test_direct_run_refuses_without_positive_trial_proxy_traffic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment = FakeEnvironment(setup_results())
    agent = make_agent(tmp_path, attach_proxy=True)
    agent._proxy_session = FakeProxySession(request_count=0)

    async def run_production(
        self: ProductionServerSession, instruction: str, execute: object,
    ) -> None:
        self._stopped_cleanly = True

    monkeypatch.setattr(ProductionServerSession, "run", run_production)
    asyncio.run(agent.setup(environment))

    with pytest.raises(ProductionSessionError, match="trial-scoped proxy"):
        asyncio.run(agent.run("Solve through production.", environment, None))

    assert agent.production_server_stopped is True


def test_failed_install_does_not_publish_manifest_or_home(tmp_path: Path) -> None:
    failed = ExecResult(stderr="corrupt artifact", return_code=1)
    results = [ok("/app\n"), ok("/app\n"), ok(), ok(), failed]

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path, attach_proxy=True).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()
    assert not (tmp_path / "agent/production-cortex-home").exists()


@pytest.mark.parametrize("failed_check", range(6))
def test_failed_verification_does_not_publish_manifest(
    tmp_path: Path, failed_check: int,
) -> None:
    failure = ExecResult(stderr=f"verification {failed_check} failed", return_code=1)
    results = install_results()[: 5 + failed_check]
    results.append(failure)

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path, attach_proxy=True).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


@pytest.mark.parametrize(
    ("empty_probe", "message"),
    [
        (BUNDLE_ROOT_RESULT, "bundle root"),
        (CLI_PATH_RESULT, "pi CLI path"),
        (CLI_VERSION_RESULT, "pi CLI version"),
    ],
)
def test_empty_installed_fact_probe_fails_closed(
    tmp_path: Path, empty_probe: int, message: str,
) -> None:
    results = install_results()
    results[empty_probe] = ok("\n")

    with pytest.raises(RuntimeError, match=message):
        asyncio.run(make_agent(tmp_path, attach_proxy=True).setup(FakeEnvironment(results)))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


def test_failed_version_probe_does_not_publish_manifest(tmp_path: Path) -> None:
    failure = ExecResult(stderr="version probe failed", return_code=1)

    with pytest.raises(NonZeroAgentExitCodeError):
        asyncio.run(make_agent(tmp_path, attach_proxy=True).setup(
            FakeEnvironment([*install_results(), failure])
        ))

    assert not (tmp_path / "artifacts/cortex-bench-harness-manifest.json").exists()


def test_constructor_accepts_one_explicit_version_keyword(tmp_path: Path) -> None:
    assert make_agent(tmp_path, version="2026.8.3").version() == "2026.8.3"


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
    ("field", "value"),
    [
        ("trial_id", "another-trial"), ("arm", "another-arm"),
        ("image_ref", f"registry.invalid/other@{DIGEST}"),
        ("image_digest", f"sha256:{'b' * 64}"),
    ],
)
def test_constructor_rejects_manifest_seed_binding_mismatch(
    tmp_path: Path, field: str, value: str,
) -> None:
    manifest = manifest_seed(tmp_path)
    manifest[field] = value

    with pytest.raises(ValueError, match=field):
        CortexBenchAgent(
            logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
            version="0.1.0", trial_seed=trial_seed(), manifest=manifest,
        )


def audit_retry_arm() -> dict[str, object]:
    arm = direct_arm()
    arm["orchestration"] = {
        "mode": "coder-review", "coder_review_variant": "audit-retry",
        "ask_manager": False,
    }
    return arm


@pytest.mark.parametrize("builder", [direct_arm, audit_retry_arm])
def test_a_misaligned_production_arm_never_falls_back_to_standalone(
    tmp_path: Path, builder,
) -> None:
    arm = builder()
    limits = dict(arm["limits"])
    limits["max_output_tokens"] = 8192
    arm["limits"] = limits

    with pytest.raises(ProductionArmError, match="production launcher"):
        CortexBenchAgent(
            logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
            trial_seed=trial_seed({"arm": arm}), manifest=manifest_seed(tmp_path),
        )


def legacy_arm() -> dict[str, object]:
    arm = direct_arm()
    arm.update({
        "backend": "claude", "provider": "anthropic", "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
    })
    return arm


def legacy_agent(tmp_path: Path) -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        version="0.1.0", trial_seed=trial_seed({"arm": legacy_arm()}),
        manifest=manifest_seed(tmp_path),
    )


def test_nonproduction_arm_remains_on_the_legacy_path(tmp_path: Path) -> None:
    environment = FakeEnvironment(setup_results())
    agent = legacy_agent(tmp_path)

    asyncio.run(agent.setup(environment))

    assert any("cortex agent-run --help" in command for command, _ in environment.calls)
    assert (tmp_path / "agent/arm-resolution.json").is_file()
    assert not (tmp_path / "agent/production-cortex-home").exists()


def test_nonproduction_run_still_executes_and_collects_the_legacy_agent_run(
    tmp_path: Path,
) -> None:
    environment = FakeEnvironment([
        *setup_results(), ok(), ExecResult(stdout="legacy stdout", stderr="", return_code=0),
    ])
    agent = legacy_agent(tmp_path)
    asyncio.run(agent.setup(environment))

    asyncio.run(agent.run("Solve through legacy.", environment, None))

    commands = [command for command, _ in environment.calls]
    assert any("cortex agent-run --prompt-file" in command for command in commands)
    assert all("dist/entry/production-app-bootstrap.js" not in command for command in commands)
    assert (tmp_path / "agent/stdout.txt").read_text() == "legacy stdout"
