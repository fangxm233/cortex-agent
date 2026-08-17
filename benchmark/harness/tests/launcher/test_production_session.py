# input:  sealed home, installed server facts, fake executor
# output: lifecycle, webhook, evidence and shutdown proofs
# pos:    Integration contract for one production direct-arm session
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

import pytest

from cortex_bench_harness.launcher.production_session import (
    InstalledProductionServer,
    ProductionServerSession,
    ProductionSessionError,
    ProductionSessionSpec,
    is_production_direct_arm,
    is_production_direct_candidate,
    require_production_direct_arm,
)


EVIDENCE_CONTEXT = {
    "schema_version": "cortex-production-benchmark-evidence-context/1",
    "trial_id": "trial-direct", "root_run_id": "root-direct",
    "bundle_manifest_hash": "b" * 64,
    "model_execution": {
        "model_alias_policy": {"policy": "exact"}, "cli_name": "pi",
        "cli_version": "0.82.1", "max_output_tokens": 65536,
    },
}


def direct_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "cortex-direct", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0,
            "max_task_depth": 0, "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 90, "max_output_tokens": 65536,
        },
    }


def session(
    tmp_path: Path, *, readiness_timeout_seconds: float = 1,
) -> ProductionServerSession:
    materialized = SimpleNamespace(
        process_environment={
            "PATH": "/usr/bin:/bin",
            "HOME": "/logs/agent/production-cortex-home/container-home",
            "CORTEX_HOME": "/logs/agent/production-cortex-home",
            "CORTEX_PROJECTS_DIR": "/logs/agent/production-cortex-home/context/projects",
            "XDG_CACHE_HOME": "/logs/agent/production-cortex-home/container-home/.cache",
            "XDG_CONFIG_HOME": "/logs/agent/production-cortex-home/container-home/.config",
            "CORTEX_CONFIG_IMMUTABLE": "1", "WEBHOOK_PORT": "3001",
            "CORTEX_WEBHOOK_THREAD_OP_ONLY": "1", "CORTEX_WEBHOOK_SINGLE_ROOT": "1",
            "CORTEX_TUI": "1", "CORTEX_TUI_PORT": "3003",
        },
        production_evidence_context=EVIDENCE_CONTEXT,
        bundle_manifest_hash="b" * 64,
        client_token="client-token", webhook_token="webhook-token",
    )
    spec = ProductionSessionSpec(
        logs_dir=tmp_path, container_logs_dir=PurePosixPath("/logs/agent"),
        workspace_cwd="/app", arm=direct_arm(), trial_id="trial-direct",
        root_run_id="root-direct", materialized_home=materialized,
        installed=InstalledProductionServer(
            bundle_root=PurePosixPath("/installed/server"),
            backend_cli_path=PurePosixPath("/usr/local/bin/pi"),
            backend_cli_version="0.82.1",
        ),
    )
    return ProductionServerSession(
        spec, poll_interval_seconds=0, readiness_timeout_seconds=readiness_timeout_seconds,
    )


class FakeExecutor:
    def __init__(
        self, logs_dir: Path, *, export_failure: bool = False,
        malformed_evidence: bool = False, gateway_failure: bool = False,
    ) -> None:
        self.logs_dir = logs_dir
        self.export_failure = export_failure
        self.malformed_evidence = malformed_evidence
        self.gateway_failure = gateway_failure
        self.calls: list[tuple[str, dict[str, str] | None, str | None]] = []
        self.timeouts: list[int | None] = []
        self.payloads: dict[str, object] = {}
        self.result_polls = 0

    async def __call__(
        self, command: str, *, env: dict[str, str] | None = None,
        cwd: str | None = None, timeout_sec: int | None = None,
    ) -> SimpleNamespace:
        self.calls.append((command, env, cwd))
        self.timeouts.append(timeout_sec)
        if "production-webhook-auth.json" in command:
            self._capture("production-webhook-auth.json")
        if "dist/entry/production-app-bootstrap.js" in command:
            self._capture("production-server-auth.json")
            (self.logs_dir / "production-server-auth.json").unlink()
            return SimpleNamespace(stdout="4242\n", stderr="")
        if "production-thread-ready.json" in command:
            self._capture("production-thread-ready.json")
            return self._reply({"success": True, "data": {"agents": []}})
        if "http://127.0.0.1:9880/status" in command:
            if self.gateway_failure:
                raise RuntimeError("aistatus gateway unavailable")
            return self._reply({"status": "ok"})
        if "production-thread-start.json" in command:
            self._capture("production-thread-start.json")
            return self._reply({
                "success": True, "data": {"threadId": "thr_production", "status": "running"},
            })
        if "production-thread-result.json" in command:
            self._capture("production-thread-result.json")
            self.result_polls += 1
            terminal = self.result_polls > 1
            return self._reply({
                "success": True,
                "data": {
                    "threadId": "thr_production",
                    "status": "completed" if terminal else "running",
                    "terminal": terminal, "artifact": None, "finalOutput": "done" if terminal else None,
                },
            })
        if "cortex-evidence-export" in command:
            self._capture("production-evidence-input.json")
            if self.export_failure:
                raise RuntimeError("export refused")
            trajectory = self.logs_dir / "trajectory"
            trajectory.mkdir()
            terminal = {} if self.malformed_evidence else {
                "schema_version": "cortex-bench-manifest/2",
                "bundle_manifest_hash": "b" * 64,
            }
            composite = {} if self.malformed_evidence else {
                "schema_version": "cortex-bench-composite-manifest/2",
                "trial_id": "trial-direct", "root_run_id": "root-direct",
                "arm_name": "cortex-direct",
                "identity": {"bundle_manifest_hash": "b" * 64},
            }
            (trajectory / "run-root-direct.terminal.json").write_text(json.dumps(terminal))
            (trajectory / "composite-manifest.json").write_text(json.dumps(composite))
            if self.malformed_evidence:
                return SimpleNamespace(stdout="{not json", stderr="")
            return self._reply({
                "ok": True,
                "directory": "/logs/agent/trajectory",
                "composite_path": "/logs/agent/trajectory/composite-manifest.json",
                "composite_sha256": "c" * 64,
                "terminal_paths": ["/logs/agent/trajectory/run-root-direct.terminal.json"],
            })
        if command.startswith("kill -TERM -- -4242"):
            return SimpleNamespace(stdout="", stderr="")
        raise AssertionError(f"unexpected command: {command}")

    def _capture(self, name: str) -> None:
        self.payloads[name] = json.loads((self.logs_dir / name).read_text())

    @staticmethod
    def _reply(value: dict[str, object]) -> SimpleNamespace:
        return SimpleNamespace(stdout=json.dumps(value), stderr="")


def test_session_boots_real_server_injects_only_webhook_exports_and_stops(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path)
    production = session(tmp_path)

    result = asyncio.run(production.run("Solve only this task.", runner))

    assert (result.thread_id, result.status, result.final_output) == (
        "thr_production", "completed", "done",
    )
    assert production.stopped_cleanly is True
    commands = [call[0] for call in runner.calls]
    assert "dist/entry/production-app-bootstrap.js" in commands[0]
    assert "setsid" in commands[0] and "env -i" in commands[0]
    assert "CORTEX_WEBHOOK_THREAD_OP_ONLY=1" in commands[0]
    assert "CORTEX_CONFIG_IMMUTABLE=1" in commands[0]
    assert "CORTEX_WEBHOOK_SINGLE_ROOT=1" in commands[0]
    assert "CORTEX_PRODUCTION_AUTH_FILE=/logs/agent/production-server-auth.json" in commands[0]
    assert "client-token" not in commands[0] and "webhook-token" not in commands[0]
    assert runner.payloads["production-server-auth.json"] == {
        "clientToken": "client-token", "webhookToken": "webhook-token",
    }
    # The sealed container environment is an exact identity, so a webhook POST may add no exec
    # variable at all; the bearer travels as a one-shot file whose path is the only thing in argv.
    assert all(
        env is None and "webhook-token" not in command
        and "/logs/agent/production-webhook-auth.json" in command
        for command, env, _ in runner.calls if "/webhook/thread-op" in command
    )
    assert runner.payloads["production-webhook-auth.json"] == {
        "webhookToken": "webhook-token",
    }
    assert all("cortex agent-run" not in command for command in commands)
    assert all("benchmark-thread-run" not in command for command in commands)
    assert sum("/webhook/thread-op" in command for command in commands) == 4
    assert sum("http://127.0.0.1:9880/status" in command for command in commands) == 1
    assert all("api.deepseek.com" not in command for command in commands)
    assert all("/webhook/task-op" not in command for command in commands)
    for command, timeout in zip(commands, runner.timeouts, strict=True):
        if "/webhook/thread-op" in command or "127.0.0.1:9880/status" in command:
            assert timeout == 10
    assert commands[-2].endswith(
        "cortex-evidence-export --input-file /logs/agent/production-evidence-input.json"
    )
    assert commands[-1].startswith("kill -TERM -- -4242")
    assert (tmp_path / "trajectory/run-root-direct.terminal.json").is_file()
    assert (tmp_path / "trajectory/composite-manifest.json").is_file()
    assert not list(tmp_path.glob("production-*.json"))


def test_evidence_export_reads_the_production_home_not_the_container_home(
    tmp_path: Path,
) -> None:
    """The exporter is a second reader of the server's own stores.

    The admitted container environment names a different `CORTEX_HOME`, and admission refuses
    exec-time variables, so the exporter must compose the server's environment inside the command
    exactly as the bootstrap does. Run against the container's own home it finds no attempts.
    """
    runner = FakeExecutor(tmp_path)

    asyncio.run(session(tmp_path).run("Solve only this task.", runner))

    export, environment, _ = next(
        call for call in runner.calls if "cortex-evidence-export" in call[0]
    )
    assert environment is None
    assert export.startswith("env -i ")
    assert "CORTEX_HOME=/logs/agent/production-cortex-home" in export
    assert "HOME=/logs/agent/production-cortex-home/container-home" in export
    assert export.endswith(
        "cortex-evidence-export --input-file /logs/agent/production-evidence-input.json"
    )


def test_session_posts_validated_root_context_and_export_identity(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path)

    asyncio.run(session(tmp_path).run("Solve only this task.", runner))

    start = runner.payloads["production-thread-start.json"]
    evidence = runner.payloads["production-evidence-input.json"]
    assert start == {
        "action": "start", "template": "benchmark-direct",
        "message": "Solve only this task.", "projectId": "general",
        "productionBenchmarkEvidenceContext": EVIDENCE_CONTEXT,
    }
    assert evidence["outputDirectory"] == "/logs/agent/trajectory"
    assert evidence["project"] == "general"
    assert evidence["trialId"] == "trial-direct"
    assert evidence["rootRunId"] == "root-direct"
    assert evidence["armName"] == "cortex-direct"
    assert evidence["bundleManifestHash"] == "b" * 64
    assert evidence["mode"] == "direct"
    assert evidence["expectedRoles"] == ["benchmark-direct"]
    assert evidence["managerQa"] is None
    assert evidence["limits"] == {"max_task_depth": 0, "max_tasks": 0}
    assert evidence["proxyExport"]["trial_id"] == "trial-direct"


def test_session_records_malformed_evidence_without_revalidating_it(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path, malformed_evidence=True)
    production = session(tmp_path)

    result = asyncio.run(production.run("Solve only this task.", runner))

    assert result.status == "completed"
    assert (tmp_path / "trajectory/run-root-direct.terminal.json").read_text() == "{}"
    assert production.stopped_cleanly is True


def test_session_refuses_aistatus_fallback_when_gateway_is_unavailable(
    tmp_path: Path,
) -> None:
    runner = FakeExecutor(tmp_path, gateway_failure=True)
    production = session(tmp_path, readiness_timeout_seconds=0.01)

    with pytest.raises(ProductionSessionError, match="readiness timed out"):
        asyncio.run(production.run("Solve only this task.", runner))

    commands = [call[0] for call in runner.calls]
    assert any("127.0.0.1:9880/status" in command for command in commands)
    assert all("production-thread-start.json" not in command for command in commands)
    assert commands[-1].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


def test_session_still_stops_the_server_when_export_refuses(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path, export_failure=True)
    production = session(tmp_path)

    with pytest.raises(RuntimeError, match="export refused"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert runner.calls[-1][0].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


def test_exact_pi_deepseek_direct_shape_selects_the_production_path() -> None:
    assert is_production_direct_arm(direct_arm()) is True


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("backend", "claude"), ("provider", "anthropic"),
        ("model", "claude-sonnet"), ("name", ""),
        ("credential_capability", "another-capability"),
    ],
)
def test_refuses_any_arm_that_can_enter_aistatus_direct_fallback(
    field: str, value: str,
) -> None:
    arm = direct_arm()
    arm[field] = value

    assert is_production_direct_arm(arm) is False
    with pytest.raises(ProductionSessionError, match="PI/DeepSeek.*direct fallback"):
        require_production_direct_arm(arm)


def test_preserves_a_nonempty_campaign_arm_name_as_production_identity() -> None:
    arm = direct_arm()
    arm["name"] = "zero-paid-pi-direct"

    assert is_production_direct_candidate(arm) is True
    assert is_production_direct_arm(arm) is True
    require_production_direct_arm(arm)


@pytest.mark.parametrize("mode", ["coder-review", "manager"])
def test_production_direct_selector_refuses_non_direct_orchestration(mode: str) -> None:
    arm = direct_arm()
    arm["orchestration"] = {"mode": mode, "ask_manager": False}

    assert is_production_direct_candidate(arm) is False
    assert is_production_direct_arm(arm) is False
    with pytest.raises(ProductionSessionError, match="PI/DeepSeek.*direct fallback"):
        require_production_direct_arm(arm)


@pytest.mark.parametrize(
    ("field", "value"),
    [("max_output_tokens", 8192), ("max_task_depth", 1), ("max_thread_starts", 1)],
)
def test_refuses_direct_limits_that_do_not_match_the_committed_bundle(
    field: str, value: int,
) -> None:
    arm = direct_arm()
    limits = dict(arm["limits"])
    limits[field] = value
    arm["limits"] = limits

    assert is_production_direct_candidate(arm) is True
    assert is_production_direct_arm(arm) is False
