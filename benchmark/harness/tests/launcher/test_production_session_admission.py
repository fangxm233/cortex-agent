# input:  admitted Docker environment and materialized home
# output: real sealed-exec webhook regression proof
# pos:    Cross-seam production-session admission proof
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The session's own suite drives a FAKE executor, and the admission suite never drives the session,
# so an exec-time environment addition in the session was invisible to both. This module is the
# missing witness: the session runs against `AdmittedDockerEnvironment.exec` itself, with only the
# `docker compose exec` call replaced, so the sealed-environment identity check is the real one.

import asyncio
import importlib
import json
import subprocess
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

import pytest
from harbor.environments.base import ExecResult
from harbor.trial.trial import Trial

from capability_admission import admit_capability
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.production_arms import (
    ProductionArmBundle,
    production_arm_bundle,
)
from cortex_bench_harness.launcher.production_home import (
    ProductionArmLaunchFacts,
    materialize_production_home,
)
from cortex_bench_harness.launcher.production_session import (
    InstalledProductionServer,
    ProductionServerSession,
    ProductionSessionSpec,
)
from cortex_bench_harness.launcher.trial_admission import build_harbor_trial_config

DIRECT_BUNDLE = production_arm_bundle("direct-pi-deepseek")
AUDIT_RETRY_BUNDLE = production_arm_bundle("coder-review-audit-retry-pi-deepseek")
MANAGER_BUNDLE = production_arm_bundle("manager-qa-off-pi-deepseek")
DIGEST = f"sha256:{'a' * 64}"
IMAGE_REF = f"registry.invalid/task@{DIGEST}"
TRIAL_ID = "trial-sealed"
PROXY_HOST = f"{TRIAL_ID}.proxy.invalid"
CONTAINER_LOGS_DIR = PurePosixPath("/logs/agent")
WORKSPACE_CWD = "/app"


@pytest.fixture(autouse=True)
def admitted_deepseek_capability(monkeypatch: pytest.MonkeyPatch):
    admit_capability(monkeypatch, "pi-deepseek-api-key")
    monkeypatch.setenv("CORTEX_BENCH_SEALED_CREDENTIAL", "fake-host-credential")
    monkeypatch.setenv("CORTEX_BENCH_SEALED_FORBIDDEN", "ambient-forbidden-value")
    monkeypatch.setenv("CORTEX_BENCH_SEALED_ARGV", "argv-forbidden-value")
    monkeypatch.setenv("CORTEX_BENCH_SEALED_CHECKOUT", "/srv/private/cortex-checkout")
    monkeypatch.setenv("CORTEX_BENCH_SEALED_IDENTITY", "private-machine-id")
    result = subprocess.CompletedProcess(
        args=["docker", "image", "inspect"], returncode=0,
        stdout=json.dumps({"Env": ["PATH=/image/path"], "Volumes": None}) + "\n",
        stderr="",
    )
    module = importlib.import_module(
        "cortex_bench_harness.launcher.trial_admission_io",
    )
    monkeypatch.setattr(
        module, "subprocess",
        SimpleNamespace(run=lambda *args, **kwargs: result), raising=False,
    )


ARM_NAMES = {
    "direct-pi-deepseek": "zero-paid-pi-direct",
    "coder-review-audit-retry-pi-deepseek": "zp-pi-coder-audit-retry",
    "manager-qa-off-pi-deepseek": "zp-pi-manager-qa-off",
}


def production_arm(bundle: ProductionArmBundle = DIRECT_BUNDLE) -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": ARM_NAMES[bundle.key], "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": dict(bundle.orchestration),
        "limits": {
            "max_provider_requests": 8, "max_cost_usd": "2.00",
            "deadline_seconds": 90, **bundle.limits,
        },
    }


def write_task(root: Path) -> Path:
    task = root / "task"
    (task / "environment").mkdir(parents=True)
    (task / "tests").mkdir()
    (task / "instruction.md").write_text("Make the requested change.\n")
    (task / "tests/test.sh").write_text("#!/bin/sh\nexit 0\n")
    (task / "task.toml").write_text(
        "[environment]\n"
        f"docker_image = {json.dumps(IMAGE_REF)}\n"
        'network_mode = "allowlist"\n'
        "allowed_hosts = []\n"
        'os = "linux"\n\n'
        "[agent]\n"
        "timeout_sec = 90\n"
    )
    return task


def launch_kwargs(root: Path, bundle: ProductionArmBundle = DIRECT_BUNDLE) -> dict[str, object]:
    arm_name = ARM_NAMES[bundle.key]
    artifacts = root / "inputs"
    artifacts.mkdir(parents=True)
    files = {
        "wheel_path": artifacts / "harness.whl",
        "lockfile_path": artifacts / "uv.lock",
        "npm_artifact_path": artifacts / "server.tgz",
    }
    for path in files.values():
        path.write_bytes(b"sealed session fixture")
    return {
        "arm": production_arm(bundle),
        "task_path": write_task(root),
        "trials_dir": root / "trials",
        "manifest": {
            "root_run_id": f"{TRIAL_ID}.{arm_name}", "trial_id": TRIAL_ID,
            "arm": arm_name,
            **{key: str(value) for key, value in files.items()},
            "lockfile_manifest_path": "benchmark/harness/uv.lock",
            "image_ref": IMAGE_REF, "image_digest": DIGEST,
            "image_size_bytes": len(b"sealed session fixture"),
        },
        "trial_seed": {
            "arm": production_arm(bundle), "arm_path": f"arm://{arm_name}",
            "trial_id": TRIAL_ID, "root_run_id": f"{TRIAL_ID}.{arm_name}",
            "task": {"task_id": "sealed-task", "image_ref": IMAGE_REF,
                     "image_digest": DIGEST},
            "profile_name": "benchmark", "paid_run": False,
            "pi_benchmark_capability_proven": True,
            "credential": {
                "upstream_base_url": "http://127.0.0.1:9099",
                "route_identity_host": "api.deepseek.com",
                "proxy_base_url": f"http://{PROXY_HOST}:4317",
                "dummy_token_ref": "zero-paid-dummy-token",
            },
            "model_alias_policy": {"kind": "exact"},
        },
        "cli_version": "2026.8.6",
        "host_scan_policy": {
            "secret_environment": {"provider_credential": "CORTEX_BENCH_SEALED_CREDENTIAL"},
            "forbidden_environment": {"forbidden": "CORTEX_BENCH_SEALED_FORBIDDEN"},
            "forbidden_argv_environment": {"forbidden": "CORTEX_BENCH_SEALED_ARGV"},
            "repository_checkout_environment": "CORTEX_BENCH_SEALED_CHECKOUT",
            "host_identity_environment": {"machine": "CORTEX_BENCH_SEALED_IDENTITY"},
        },
        "trial_proxy": {
            "credential_env": "CORTEX_BENCH_SEALED_CREDENTIAL",
            "bound_source_ip": "172.19.0.2",
            "request_body_limit_bytes": 16 * 1024 * 1024,
            "response_body_limit_bytes": 16 * 1024 * 1024,
            "listen_host": "0.0.0.0",
        },
    }


class ContainerDouble:
    """Stands in for `docker compose exec` only: everything above it is production code."""

    def __init__(self, logs_dir: Path) -> None:
        self.logs_dir = logs_dir
        self.commands: list[str] = []
        self.result_polls = 0

    async def __call__(
        self, command: str, *, service: str, cwd: str | None,
        env: dict[str, str] | None, timeout_sec: int | None,
        user: str | int | None,
    ) -> ExecResult:
        self.commands.append(command)
        return ExecResult(stdout=self._stdout(command), stderr="", return_code=0)

    def _stdout(self, command: str) -> str:
        if "production-app-bootstrap.js" in command:
            (self.logs_dir / "production-server-auth.json").unlink()
            return "4242\n"
        if "production-thread-ready.json" in command:
            return json.dumps({"success": True, "data": {"agents": []}})
        if "127.0.0.1:9880/status" in command:
            return json.dumps({"status": "ok"})
        if "production-thread-start.json" in command:
            return json.dumps({
                "success": True,
                "data": {"threadId": "thr_sealed", "status": "running"},
            })
        if "cortex-task add" in command:
            return json.dumps({
                "success": True, "message": "Task added to general", "task-id": "a1b2",
            })
        if "cortex-task lock-release" in command:
            return json.dumps({"success": True, "message": "Lock released"})
        if "production-thread-list.json" in command:
            return json.dumps({"success": True, "data": {
                "scope": "project", "count": 1,
                "threads": [{
                    "threadId": "thr_sealed", "status": "running",
                    "templateName": "benchmark-manager", "trigger": "task-dispatch",
                    "createdAt": "2026-01-01T00:00:01.000Z",
                }],
            }})
        if "production-thread-result.json" in command:
            self.result_polls += 1
            return json.dumps({
                "success": True,
                "data": {"threadId": "thr_sealed", "status": "completed",
                         "terminal": True, "artifact": None, "finalOutput": "done"},
            })
        if "cortex-evidence-export" in command:
            return ""
        if "kill -TERM" in command:
            return ""
        raise AssertionError(f"unexpected container command: {command}")


def sealed_trial(tmp_path: Path, bundle: ProductionArmBundle = DIRECT_BUNDLE) -> Trial:
    config = build_harbor_trial_config(**launch_kwargs(tmp_path, bundle))
    trial = asyncio.run(Trial.create(config))
    assert isinstance(trial.agent, CortexBenchAgent)
    trial.agent_environment.bind_proxy_controller(trial.agent)
    return trial


def production_session(
    trial: Trial, logs_dir: Path, bundle: ProductionArmBundle = DIRECT_BUNDLE,
) -> ProductionServerSession:
    arm_name = ARM_NAMES[bundle.key]
    materialized = materialize_production_home(
        cortex_home=logs_dir / "production-cortex-home",
        artifacts_dir=trial.paths.artifacts_dir,
        runtime_cortex_home=CONTAINER_LOGS_DIR / "production-cortex-home",
        facts=ProductionArmLaunchFacts(
            arm_bundle=bundle,
            trial_id=TRIAL_ID, root_run_id=f"{TRIAL_ID}.{arm_name}",
            npm_artifact=Path(str(trial.config.agent.kwargs["manifest"]["npm_artifact_path"])),
            backend_cli_version="0.82.1",
            proxy_base_url=f"http://{PROXY_HOST}:4317",
            dummy_token_ref="zero-paid-dummy-token",
            model_alias_policy={"kind": "exact"},
        ),
        inherited_environment={"PATH": "/usr/bin:/bin", "TZ": "UTC"},
    )
    spec = ProductionSessionSpec(
        logs_dir=logs_dir, container_logs_dir=CONTAINER_LOGS_DIR,
        workspace_cwd=WORKSPACE_CWD, arm=production_arm(bundle), trial_id=TRIAL_ID,
        root_run_id=f"{TRIAL_ID}.{arm_name}",
        materialized_home=materialized,
        installed=InstalledProductionServer(
            bundle_root=PurePosixPath("/installed/server"),
            backend_cli_path=PurePosixPath("/usr/local/bin/pi"),
            backend_cli_version="0.82.1",
        ),
    )
    return ProductionServerSession(spec, poll_interval_seconds=0)


def test_webhook_post_passes_the_real_sealed_environment_assertion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression: `_post` used to add `CORTEX_WEBHOOK_TOKEN` to the exec environment.

    `AdmittedDockerEnvironment.exec` compares the merged process environment to the sealed
    allowlist by keys AND value digest, so the very first webhook POST raised
    `process environment differs from the sealed values` and no trial could ever be injected.
    """
    trial = sealed_trial(tmp_path)
    logs_dir = trial.paths.agent_dir
    logs_dir.mkdir(parents=True, exist_ok=True)
    container = ContainerDouble(logs_dir)
    monkeypatch.setattr(trial.agent_environment, "_compose_exec", container)
    session = production_session(trial, logs_dir)

    async def execute(command: str, **kwargs: object):
        return await trial.agent.exec_as_agent(
            trial.agent_environment, command, **kwargs,
        )

    result = asyncio.run(session.run("Solve only this task.", execute))

    assert (result.thread_id, result.status) == ("thr_sealed", "completed")
    assert session.stopped_cleanly is True
    assert any("/webhook/thread-op" in command for command in container.commands)


def test_webhook_token_never_reaches_a_container_command_string(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Its delivery replaces an exec env var, so it must not become argv instead."""
    trial = sealed_trial(tmp_path)
    logs_dir = trial.paths.agent_dir
    logs_dir.mkdir(parents=True, exist_ok=True)
    container = ContainerDouble(logs_dir)
    monkeypatch.setattr(trial.agent_environment, "_compose_exec", container)
    session = production_session(trial, logs_dir)
    token = session._spec.materialized_home.webhook_token

    asyncio.run(session.run("Solve only this task.", lambda command, **kwargs: (
        trial.agent.exec_as_agent(trial.agent_environment, command, **kwargs)
    )))

    assert token
    assert all(token not in command for command in container.commands)
    assert all(
        session._spec.materialized_home.client_token not in command
        for command in container.commands
    )
    assert not list(logs_dir.glob("production-*auth*.json"))


def test_audit_retry_arm_injects_its_attested_root_through_the_real_sealed_exec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K-051: the second arm's exec path gets its own witness against the real admission check.

    A fake executor cannot see that the sealed environment gained
    `CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE`, and the exact-identity comparison in
    `AdmittedDockerEnvironment.exec` is what would refuse it.
    """
    trial = sealed_trial(tmp_path, AUDIT_RETRY_BUNDLE)
    logs_dir = trial.paths.agent_dir
    logs_dir.mkdir(parents=True, exist_ok=True)
    container = ContainerDouble(logs_dir)
    monkeypatch.setattr(trial.agent_environment, "_compose_exec", container)
    session = production_session(trial, logs_dir, AUDIT_RETRY_BUNDLE)
    posted: list[dict[str, object]] = []
    original = session._write_request

    def capture(name: str, value):
        posted.append({"name": name, "body": dict(value)})
        return original(name, value)

    monkeypatch.setattr(session, "_write_request", capture)

    result = asyncio.run(session.run("Solve only this task.", lambda command, **kwargs: (
        trial.agent.exec_as_agent(trial.agent_environment, command, **kwargs)
    )))

    assert (result.thread_id, result.status) == ("thr_sealed", "completed")
    start = next(
        item["body"] for item in posted if item["name"] == "production-thread-start.json")
    evidence = next(
        item["body"] for item in posted if item["name"] == "production-evidence-input.json")
    assert start["template"] == "benchmark-coder-review"
    assert evidence["mode"] == "coder-review"
    assert evidence["expectedRoles"] == ["benchmark-coder", "benchmark-reviewer"]
    launch = container.commands[0]
    assert "CORTEX_WEBHOOK_SINGLE_ROOT=1" in launch
    assert "CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE=benchmark-coder-review" in launch
    assert all("benchmark-direct" not in command for command in container.commands)


def test_manager_arm_injects_its_task_root_through_the_real_sealed_exec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """K-051: the task-root injection is a new exec path, so it gets its own real-exec witness.

    `cortex-task` runs under a composed environment the webhook POSTs do not use — it adds
    `CORTEX_EXECUTION_ID` for the lock owner and the launch adds the evidence-context file — and
    only `AdmittedDockerEnvironment.exec` compares the merged environment against the sealed
    identity by keys AND value digest.
    """
    trial = sealed_trial(tmp_path, MANAGER_BUNDLE)
    logs_dir = trial.paths.agent_dir
    logs_dir.mkdir(parents=True, exist_ok=True)
    container = ContainerDouble(logs_dir)
    monkeypatch.setattr(trial.agent_environment, "_compose_exec", container)
    session = production_session(trial, logs_dir, MANAGER_BUNDLE)

    result = asyncio.run(session.run("Solve only this task.", lambda command, **kwargs: (
        trial.agent.exec_as_agent(trial.agent_environment, command, **kwargs)
    )))

    assert (result.thread_id, result.status) == ("thr_sealed", "completed")
    assert all(
        "production-thread-start.json" not in command for command in container.commands)
    add = next(command for command in container.commands if "cortex-task add" in command)
    assert "CORTEX_EXECUTION_ID=benchmark-launcher" in add
    assert (
        "cortex-task add --project general "
        f"--task-file {CONTAINER_LOGS_DIR}/production-task-spec.json --auto-lock"
    ) in add
    assert any("cortex-task lock-release" in command for command in container.commands)
    launch = container.commands[0]
    assert (
        "CORTEX_PRODUCTION_BENCHMARK_EVIDENCE_CONTEXT_FILE="
        f"{CONTAINER_LOGS_DIR}/production-cortex-home"
        "/production-benchmark-evidence-context.json"
    ) in launch


def test_manager_arm_opens_only_its_task_store_in_the_sealed_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one relaxation this arm needs, against the home the trial actually materialized."""
    trial = sealed_trial(tmp_path, MANAGER_BUNDLE)
    logs_dir = trial.paths.agent_dir
    logs_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(trial.agent_environment, "_compose_exec", ContainerDouble(logs_dir))
    session = production_session(trial, logs_dir, MANAGER_BUNDLE)
    home = session._spec.materialized_home.cortex_home

    tasks = home / "context/projects/general/TASKS.yaml"
    assert tasks.stat().st_mode & 0o777 == 0o644
    assert (home / "context/projects/general").stat().st_mode & 0o777 == 0o755
    assert (home / "context/projects").stat().st_mode & 0o777 == 0o555
    assert (home / "config/settings.json").stat().st_mode & 0o777 == 0o444
    attestation = json.loads(
        session._spec.materialized_home.launch_attestation_path.read_text())
    assert attestation["arm_confinement"] == {
        "injection": "task-root",
        "webhook_endpoints": ["POST /webhook/thread-op"],
        "writable_home_paths": ["context/projects/general"],
    }
