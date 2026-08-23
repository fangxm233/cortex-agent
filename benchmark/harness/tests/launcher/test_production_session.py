# input:  sealed home, installed server facts, fake executor
# output: lifecycle, webhook, evidence and shutdown proofs
# pos:    Integration contract for one production arm session
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

import pytest

from cortex_bench_harness.launcher.production_arms import (
    ProductionArmError,
    production_arm_bundle,
)
from cortex_bench_harness.launcher.production_session import (
    InstalledProductionServer,
    ProductionServerSession,
    ProductionSessionError,
    ProductionSessionSpec,
)

DIRECT_BUNDLE = production_arm_bundle("direct-pi-deepseek")
AUDIT_RETRY_BUNDLE = production_arm_bundle("coder-review-audit-retry-pi-deepseek")
REVIEWER_FIX_BUNDLE = production_arm_bundle("coder-review-reviewer-fix-pi-deepseek")
MANAGER_BUNDLE = production_arm_bundle("manager-qa-off-pi-deepseek")
MANAGER_QA_ON_BUNDLE = production_arm_bundle("manager-qa-on-pi-deepseek")
PRODUCTION_BUNDLES = (
    DIRECT_BUNDLE, AUDIT_RETRY_BUNDLE, REVIEWER_FIX_BUNDLE,
    MANAGER_BUNDLE, MANAGER_QA_ON_BUNDLE,
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
            "max_provider_requests": 8, "max_cost_usd": "2.50",
            "deadline_seconds": 90, "max_output_tokens": 65536,
        },
    }


def audit_retry_arm() -> dict[str, object]:
    arm = direct_arm()
    arm["name"] = "cortex-audit-retry"
    arm["orchestration"] = {
        "mode": "coder-review", "coder_review_variant": "audit-retry",
        "ask_manager": False,
    }
    return arm


def manager_arm() -> dict[str, object]:
    arm = direct_arm()
    arm["name"] = "cortex-manager-qa-off"
    arm["orchestration"] = {"mode": "manager", "ask_manager": False}
    return arm


def arm_for_bundle(bundle) -> dict[str, object]:
    arm = direct_arm()
    arm["name"] = f"cortex-{bundle.key}"
    arm["orchestration"] = dict(bundle.orchestration)
    return arm


def session(
    tmp_path: Path, *, readiness_timeout_seconds: float = 1,
    dispatch_timeout_seconds: float = 1,
    arm: dict[str, object] | None = None, bundle=DIRECT_BUNDLE,
) -> ProductionServerSession:
    materialized = SimpleNamespace(
        arm_bundle=bundle,
        process_environment={
            "PATH": "/usr/bin:/bin",
            "HOME": "/logs/agent/production-cortex-home/container-home",
            "CORTEX_HOME": "/logs/agent/production-cortex-home",
            "CORTEX_PROJECTS_DIR": "/logs/agent/production-cortex-home/context/projects",
            "XDG_CACHE_HOME": "/logs/agent/production-cortex-home/container-home/.cache",
            "XDG_CONFIG_HOME": "/logs/agent/production-cortex-home/container-home/.config",
            "CORTEX_CONFIG_IMMUTABLE": "1", "WEBHOOK_PORT": "3001",
            "CORTEX_WEBHOOK_THREAD_OP_ONLY": "1", "CORTEX_WEBHOOK_SINGLE_ROOT": "1",
            "CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE": bundle.root_template,
            "CORTEX_TUI": "1", "CORTEX_TUI_PORT": "3003",
        },
        production_evidence_context=EVIDENCE_CONTEXT,
        bundle_manifest_hash="b" * 64,
        client_token="client-token", webhook_token="webhook-token",
    )
    spec = ProductionSessionSpec(
        logs_dir=tmp_path, container_logs_dir=PurePosixPath("/logs/agent"),
        workspace_cwd="/app", arm=arm or direct_arm(), trial_id="trial-direct",
        root_run_id="root-direct", materialized_home=materialized,
        installed=InstalledProductionServer(
            bundle_root=PurePosixPath("/installed/server"),
            backend_cli_path=PurePosixPath("/usr/local/bin/pi"),
            backend_cli_version="0.82.1",
        ),
    )
    return ProductionServerSession(
        spec, poll_interval_seconds=0, readiness_timeout_seconds=readiness_timeout_seconds,
        dispatch_timeout_seconds=dispatch_timeout_seconds,
    )


class FakeExecutor:
    def __init__(
        self, logs_dir: Path, *, export_failure: bool = False,
        malformed_evidence: bool = False, gateway_failure: bool = False,
        dispatch_never_runs: bool = False, dispatch_error_once: Exception | None = None,
        dispatch_error_always: bool = False, result_timeout_once: bool = False,
        result_never_terminal: bool = False, result_status: str = "completed",
    ) -> None:
        self.logs_dir = logs_dir
        self.export_failure = export_failure
        self.malformed_evidence = malformed_evidence
        self.gateway_failure = gateway_failure
        self.dispatch_never_runs = dispatch_never_runs
        self.dispatch_error_once = dispatch_error_once
        self.dispatch_error_always = dispatch_error_always
        self.result_timeout_once = result_timeout_once
        self.result_never_terminal = result_never_terminal
        self.result_status = result_status
        self.calls: list[tuple[str, dict[str, str] | None, str | None]] = []
        self.timeouts: list[int | None] = []
        self.payloads: dict[str, object] = {}
        self.result_polls = 0
        self.list_thread_polls = 0
        self.dispatched_threads = [
            {
                "threadId": "thr_dispatched", "status": "running",
                "templateName": "manager", "trigger": "task-dispatch",
                "createdAt": "2026-01-01T00:00:01.000Z",
            },
        ]

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
        if "cortex-task add" in command:
            self._capture("production-task-spec.json")
            return self._task_cli_reply({
                "success": True, "message": "Task added to general", "task-id": "a1b2",
            })
        if "cortex-task lock-release" in command:
            return self._task_cli_reply({
                "success": True, "project": "general", "message": "Lock released",
            })
        if "production-thread-list.json" in command:
            self._capture("production-thread-list.json")
            self.list_thread_polls += 1
            if self.dispatch_error_once is not None and (
                self.dispatch_error_always or self.list_thread_polls == 1
            ):
                raise self.dispatch_error_once
            dispatched = (
                [] if self.dispatch_never_runs or self.list_thread_polls < 2
                else self.dispatched_threads
            )
            return self._reply({"success": True, "data": {
                "scope": "project", "count": len(dispatched), "threads": dispatched,
            }})
        if "production-thread-result.json" in command:
            self._capture("production-thread-result.json")
            requested = self.payloads["production-thread-result.json"]["threadId"]
            self.result_polls += 1
            if self.result_timeout_once and self.result_polls == 1:
                raise RuntimeError("Command timed out after 10 seconds")
            terminal = not self.result_never_terminal and self.result_polls > 1
            return self._reply({
                "success": True,
                "data": {
                    "threadId": requested,
                    "status": self.result_status if terminal else "running",
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

    @staticmethod
    def _task_cli_reply(value: dict[str, object]) -> SimpleNamespace:
        """The JSON result as the sealed container really delivers it.

        `cortex-task` prints its own logger to stdout ahead of the result, and the sealed exec
        returns the process output with its advisory notice trailing the JSON.
        """
        return SimpleNamespace(
            stdout=(
                "[task-lock 09:40:08] Lock acquired for %s by %s (expires %s) "
                "general benchmark-launcher 2026-01-01T00:20:00.000Z\n"
                "[thread-manager 09:40:08] Loaded 1 agents, 1 templates\n"
                + json.dumps(value, indent=2) + "\n"
                "Lock acquired automatically. "
                "Release with: cortex-task lock-release --project general\n"
            ),
            stderr="",
        )


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
    assert all("cortex-task" not in command for command in commands)
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


def test_result_poll_retries_one_exec_timeout_until_the_thread_is_terminal(
    tmp_path: Path,
) -> None:
    runner = FakeExecutor(tmp_path, result_timeout_once=True)

    result = asyncio.run(session(tmp_path).run("Solve only this task.", runner))

    assert result.status == "completed"
    assert runner.result_polls == 2


@pytest.mark.parametrize(
    ("bundle", "status"),
    [(AUDIT_RETRY_BUNDLE, "failed"), (REVIEWER_FIX_BUNDLE, "aborted")],
    ids=["audit-retry-failed", "reviewer-fix-aborted"],
)
def test_coder_review_terminal_failure_is_recorded_without_result_poll_cycles(
    tmp_path: Path, bundle, status: str,
) -> None:
    runner = FakeExecutor(tmp_path, result_status=status)
    production = session(tmp_path, arm=arm_for_bundle(bundle), bundle=bundle)

    result = asyncio.run(production.run("Solve only this task.", runner))

    assert result.status == status
    assert runner.result_polls == 2
    assert json.loads((tmp_path / "production-session-outcome.json").read_text()) == {
        "schema_version": "cortex-bench-production-session-outcome/1",
        "trial_id": "trial-direct", "thread_id": "thr_production",
        "terminal": True, "status": status,
        "terminal_reason": f"thread_{status}", "artifact": None,
        "final_output": "done",
    }


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
        "action": "start", "template": "direct",
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
    assert evidence["expectedRoles"] == ["direct"]
    assert evidence["managerQa"] is None
    assert "limits" not in evidence
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


def test_audit_retry_session_injects_its_own_template_and_evidence_shape(
    tmp_path: Path,
) -> None:
    """The arm decides the injected root and the evidence mode; the session hardcodes neither."""
    runner = FakeExecutor(tmp_path)
    production = session(tmp_path, arm=audit_retry_arm(), bundle=AUDIT_RETRY_BUNDLE)

    asyncio.run(production.run("Solve only this task.", runner))

    start = runner.payloads["production-thread-start.json"]
    evidence = runner.payloads["production-evidence-input.json"]
    assert start["template"] == "coder-review"
    assert start["projectId"] == "general"
    assert evidence["mode"] == "coder-review"
    assert evidence["expectedRoles"] == ["coder", "reviewer"]
    assert evidence["managerQa"] is None
    assert evidence["armName"] == "cortex-audit-retry"
    assert all(
        "config/thread-templates/templates/direct.json" not in command
        for command, _, _ in runner.calls
    )


def test_manager_arm_injects_a_task_and_never_posts_a_thread_root(tmp_path: Path) -> None:
    """The second injection kind: the unit of work enters as a task, not as a thread root.

    The launcher adds it to the arm's own task store through the production task CLI and stops
    there — nothing tells the server which thread to run, and no `thread-op start` is posted.
    """
    runner = FakeExecutor(tmp_path)
    production = session(tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE)

    asyncio.run(production.run("Solve only this task.", runner))

    commands = [call[0] for call in runner.calls]
    assert all("production-thread-start.json" not in command for command in commands)
    assert all("/webhook/task-op" not in command for command in commands)
    add = next(command for command in commands if "cortex-task add" in command)
    assert add.startswith("env -i ")
    assert "CORTEX_HOME=/logs/agent/production-cortex-home" in add
    assert add.endswith(
        "cortex-task add --project general "
        "--task-file /logs/agent/production-task-spec.json --auto-lock"
    )
    assert runner.payloads["production-task-spec.json"] == {
        "text": "Solve only this task.",
        "why": "The trial's one unit of work, injected as this arm's task root.",
        "done-when": "Solve only this task.",
        "template": "manager", "priority": "high",
    }


def test_manager_arm_releases_the_add_lock_under_the_same_owner(tmp_path: Path) -> None:
    """`--auto-lock` acquires and never releases, and the owner is the process that acquired.

    Every exec is a new process, so the launcher names one owner identity for both calls; without
    it the release is made by a stranger and the arm's task store stays locked for the trial.
    """
    runner = FakeExecutor(tmp_path)

    asyncio.run(session(
        tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE,
    ).run("Solve only this task.", runner))

    commands = [call[0] for call in runner.calls]
    add = next(command for command in commands if "cortex-task add" in command)
    release = next(command for command in commands if "cortex-task lock-release" in command)
    assert commands.index(add) < commands.index(release)
    assert release.endswith("cortex-task lock-release --project general --json")
    owner = "CORTEX_EXECUTION_ID=benchmark-launcher"
    assert owner in add and owner in release


def test_manager_arm_waits_on_the_thread_the_dispatcher_started(tmp_path: Path) -> None:
    """The production dispatcher owns the root, so its own thread is the outcome to wait on."""
    runner = FakeExecutor(tmp_path)
    production = session(tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE)

    result = asyncio.run(production.run("Solve only this task.", runner))

    assert (result.thread_id, result.status, result.final_output) == (
        "thr_dispatched", "completed", "done",
    )
    assert runner.payloads["production-thread-list.json"] == {
        "action": "list-threads", "scope": "project", "projectId": "general",
    }
    assert runner.payloads["production-thread-result.json"]["threadId"] == "thr_dispatched"
    assert production.stopped_cleanly is True


@pytest.mark.parametrize("bundle", PRODUCTION_BUNDLES, ids=lambda bundle: bundle.key)
def test_every_arm_deadline_returns_and_records_an_explicit_terminal_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bundle,
) -> None:
    runner = FakeExecutor(tmp_path, result_never_terminal=True)
    declared_arm = arm_for_bundle(bundle)
    declared_arm["limits"]["deadline_seconds"] = 1
    clock = iter(value / 4 for value in range(1, 40))
    monkeypatch.setattr(
        "cortex_bench_harness.launcher.production_session.time.monotonic",
        lambda: next(clock),
    )
    production = session(tmp_path, arm=declared_arm, bundle=bundle)

    result = asyncio.run(production.run("Solve only this task.", runner))

    thread_id = "thr_dispatched" if bundle.injection == "task-root" else "thr_production"
    assert (result.thread_id, result.status, result.final_output) == (
        thread_id, "deadline_exhausted", None,
    )
    assert json.loads((tmp_path / "production-session-outcome.json").read_text()) == {
        "schema_version": "cortex-bench-production-session-outcome/1",
        "trial_id": "trial-direct", "thread_id": thread_id,
        "terminal": True, "status": "deadline_exhausted",
        "terminal_reason": "run_deadline_reached", "artifact": None,
        "final_output": None,
    }
    commands = [call[0] for call in runner.calls]
    assert all("cortex-evidence-export" not in command for command in commands)
    assert commands[-1].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


def test_manager_dispatch_poll_retries_one_exec_timeout(tmp_path: Path) -> None:
    runner = FakeExecutor(
        tmp_path, dispatch_error_once=RuntimeError("Command timed out after 10 seconds"),
    )

    result = asyncio.run(session(
        tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE,
    ).run("Solve only this task.", runner))

    assert result.status == "completed"
    assert runner.list_thread_polls == 2


def test_manager_dispatch_poll_keeps_non_timeout_exec_failures_fatal(tmp_path: Path) -> None:
    runner = FakeExecutor(
        tmp_path, dispatch_error_once=RuntimeError("Docker exec failed"),
    )
    production = session(tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE)

    with pytest.raises(RuntimeError, match="Docker exec failed"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert runner.list_thread_polls == 1
    assert production.stopped_cleanly is True


def test_manager_dispatch_poll_stops_retrying_exec_timeouts_at_deadline(
    tmp_path: Path,
) -> None:
    runner = FakeExecutor(
        tmp_path,
        dispatch_error_once=RuntimeError("Command timed out after 10 seconds"),
        dispatch_error_always=True,
    )
    production = session(
        tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE, dispatch_timeout_seconds=0.01,
    )

    with pytest.raises(ProductionSessionError, match="task dispatch"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert runner.list_thread_polls > 1
    assert production.stopped_cleanly is True


def test_manager_arm_uses_the_newest_dispatch_thread_after_a_retry(tmp_path: Path) -> None:
    """Thread-op lists newest first; a retried task must not bind to its stale attempt."""
    runner = FakeExecutor(tmp_path)
    runner.dispatched_threads = [
        {
            "threadId": "thr_retry", "status": "running",
            "templateName": "manager", "trigger": "task-dispatch",
            "createdAt": "2026-01-01T00:00:02.000Z",
        },
        {
            "threadId": "thr_stale", "status": "failed",
            "templateName": "manager", "trigger": "task-dispatch",
            "createdAt": "2026-01-01T00:00:01.000Z",
        },
    ]
    production = session(tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE)

    result = asyncio.run(production.run("Solve only this task.", runner))

    assert result.thread_id == "thr_retry"
    assert runner.payloads["production-thread-result.json"]["threadId"] == "thr_retry"


def test_manager_arm_exports_its_own_evidence_shape(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path)

    asyncio.run(session(
        tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE,
    ).run("Solve only this task.", runner))

    evidence = runner.payloads["production-evidence-input.json"]
    assert evidence["mode"] == "manager"
    assert evidence["expectedRoles"] == ["manager"]
    assert evidence["managerQa"] == "off"
    assert evidence["armName"] == "cortex-manager-qa-off"
    assert "limits" not in evidence


def test_manager_arm_refuses_a_task_cli_that_did_not_add_the_task(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path)
    original = runner._task_cli_reply
    runner._task_cli_reply = lambda value: original(  # type: ignore[method-assign]
        {"success": False, "message": "Lock required: held by someone else"})
    production = session(tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE)

    with pytest.raises(ProductionSessionError, match="cortex-task add refused"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert production.stopped_cleanly is True


def test_manager_arm_refuses_a_task_cli_that_printed_no_result(tmp_path: Path) -> None:
    """A refused CLI writes its reason to stderr and leaves stdout without a result."""
    runner = FakeExecutor(tmp_path)
    runner._task_cli_reply = lambda value: SimpleNamespace(  # type: ignore[method-assign]
        stdout="", stderr="--project is required")
    production = session(tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE)

    with pytest.raises(ProductionSessionError, match="cortex-task add printed no JSON result"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert production.stopped_cleanly is True


def test_manager_arm_refuses_a_dispatch_that_never_runs(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path, dispatch_never_runs=True)
    production = session(
        tmp_path, arm=manager_arm(), bundle=MANAGER_BUNDLE, dispatch_timeout_seconds=0.01,
    )

    with pytest.raises(ProductionSessionError, match="task dispatch"):
        asyncio.run(production.run("Solve only this task.", runner))

    commands = [call[0] for call in runner.calls]
    assert all("production-thread-result.json" not in command for command in commands)
    assert commands[-1].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


def test_session_refuses_an_arm_its_bundle_does_not_declare(tmp_path: Path) -> None:
    arm = audit_retry_arm()
    arm["orchestration"] = {
        "mode": "coder-review", "coder_review_variant": "unknown", "ask_manager": False,
    }

    with pytest.raises(ProductionArmError, match="production launcher"):
        session(tmp_path, arm=arm, bundle=AUDIT_RETRY_BUNDLE)


def test_session_refuses_a_materialized_home_from_another_arm(tmp_path: Path) -> None:
    with pytest.raises(ProductionSessionError, match="materialized home.*arm"):
        session(tmp_path, arm=audit_retry_arm(), bundle=DIRECT_BUNDLE)
