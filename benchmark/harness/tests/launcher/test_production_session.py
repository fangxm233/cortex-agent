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
DIRECT_CODEX_BUNDLE = production_arm_bundle("direct-pi-openai-codex")


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


def arm_for_bundle(bundle) -> dict[str, object]:
    arm = direct_arm()
    arm.update(
        name=f"cortex-{bundle.key}", provider=bundle.provider, model=bundle.model,
        credential_capability=bundle.credential_capability,
        orchestration=dict(bundle.orchestration),
    )
    return arm


def session(
    tmp_path: Path, *, readiness_timeout_seconds: float = 1,
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
            "CORTEX_WEBHOOK_BENCHMARK_ONLY": "1",
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
        not_ready: bool = False, result_timeout_once: bool = False,
        result_never_terminal: bool = False, result_status: str = "completed",
        result_session_id: str | None = None,
        journal_cwd: str | None = "/app",
        export_journal: bool = True,
        malformed_journal: bool = False,
    ) -> None:
        self.logs_dir = logs_dir
        self.export_failure = export_failure
        self.malformed_evidence = malformed_evidence
        self.gateway_failure = gateway_failure
        self.not_ready = not_ready
        self.result_timeout_once = result_timeout_once
        self.result_never_terminal = result_never_terminal
        self.result_status = result_status
        self.result_session_id = result_session_id
        # What the exported trajectory says each attempt ran in. None omits the header entirely.
        self.journal_cwd = journal_cwd
        self.export_journal = export_journal
        self.malformed_journal = malformed_journal
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
        if "production-session-ready.json" in command:
            self._capture("production-session-ready.json")
            return self._reply({"success": True, "data": {"ready": not self.not_ready}})
        if "http://127.0.0.1:9880/status" in command:
            if self.gateway_failure:
                raise RuntimeError("aistatus gateway unavailable")
            return self._reply({"status": "ok"})
        if "production-session-start.json" in command:
            self._capture("production-session-start.json")
            return self._reply({
                "success": True,
                "data": {"sessionId": "ses_production", "channel": "web:ses_production",
                         "status": "running"},
            })
        if "production-session-status.json" in command:
            self._capture("production-session-status.json")
            requested = self.payloads["production-session-status.json"]["sessionId"]
            self.result_polls += 1
            if self.result_timeout_once and self.result_polls == 1:
                raise RuntimeError("Command timed out after 10 seconds")
            terminal = not self.result_never_terminal and self.result_polls > 1
            return self._reply({
                "success": True,
                "data": {
                    "sessionId": self.result_session_id or requested,
                    "channel": f"web:{requested}", "running": not terminal,
                    "terminal": terminal,
                    "status": self.result_status if terminal else "running",
                    "turns": 1 if terminal else 0,
                    "finalOutput": "done" if terminal else None, "error": None,
                    "executionIds": ["exec-1"],
                },
            })
        if "events.jsonl" in command:
            # The workspace-contract reader, answering from the container side of the mount.
            journal = self.logs_dir / "trajectory" / "events.jsonl"
            if not journal.is_file():
                return self._reply({"journal": "absent"})
            try:
                rows = [
                    json.loads(line)
                    for line in journal.read_text(encoding="utf-8").splitlines() if line.strip()
                ]
            except json.JSONDecodeError:
                return self._reply({"journal": "malformed"})
            return self._reply({"journal": "read", "headers": [
                {"slot": row.get("agent_slot"), "cwd": row.get("resolved_cwd")}
                for row in rows
                if isinstance(row, dict) and row.get("type") == "run_header"
            ]})
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
                "schema_version": "cortex-bench-composite-manifest/3",
                "trial_id": "trial-direct", "root_run_id": "root-direct",
                "arm_name": "cortex-direct",
                "identity": {"bundle_manifest_hash": "b" * 64},
            }
            (trajectory / "run-root-direct.terminal.json").write_text(json.dumps(terminal))
            (trajectory / "composite-manifest.json").write_text(json.dumps(composite))
            header = [] if self.journal_cwd is None else [json.dumps({
                "schema_version": "cortex-bench-journal/2", "type": "run_header",
                "root_run_id": "root-direct", "session_id": "ses_production",
                "agent_slot": "direct", "seq": 0,
                "resolved_cwd": self.journal_cwd,
            })]
            if self.malformed_journal:
                (trajectory / "events.jsonl").write_text("{not json")
            elif self.export_journal:
                (trajectory / "events.jsonl").write_text("\n".join(header))
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

def test_session_boots_real_server_starts_one_session_exports_and_stops(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path)
    production = session(tmp_path)

    result = asyncio.run(production.run("Solve only this task.", runner))

    assert (result.session_id, result.status, result.final_output) == (
        "ses_production", "completed", "done",
    )
    assert production.stopped_cleanly is True
    commands = [call[0] for call in runner.calls]
    assert "dist/entry/production-app-bootstrap.js" in commands[0]
    assert "setsid" in commands[0] and "env -i" in commands[0]
    assert "CORTEX_WEBHOOK_BENCHMARK_ONLY=1" in commands[0]
    assert "CORTEX_CONFIG_IMMUTABLE=1" in commands[0]
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
        for command, env, _ in runner.calls if "/webhook/benchmark-session" in command
    )
    assert runner.payloads["production-webhook-auth.json"] == {
        "webhookToken": "webhook-token",
    }
    assert all("cortex agent-run" not in command for command in commands)
    assert all("/webhook/thread-op" not in command for command in commands)
    # ping, start, two status polls
    assert sum("/webhook/benchmark-session" in command for command in commands) == 4
    assert sum("http://127.0.0.1:9880/status" in command for command in commands) == 1
    assert all("api.deepseek.com" not in command for command in commands)
    assert all("/webhook/task-op" not in command for command in commands)
    assert all("cortex-task" not in command for command in commands)
    for command, timeout in zip(commands, runner.timeouts, strict=True):
        if "/webhook/benchmark-session" in command or "127.0.0.1:9880/status" in command:
            assert timeout == 10
    assert commands[-3].endswith(
        "cortex-evidence-export --input-file /logs/agent/production-evidence-input.json"
    )
    assert commands[-2].endswith("/logs/agent/trajectory/events.jsonl")
    assert commands[-1].startswith("kill -TERM -- -4242")
    assert (tmp_path / "trajectory/run-root-direct.terminal.json").is_file()
    assert (tmp_path / "trajectory/composite-manifest.json").is_file()
    assert not list(tmp_path.glob("production-*.json"))


def test_status_poll_retries_one_exec_timeout_until_the_session_is_terminal(
    tmp_path: Path,
) -> None:
    runner = FakeExecutor(tmp_path, result_timeout_once=True)

    result = asyncio.run(session(tmp_path).run("Solve only this task.", runner))

    assert result.status == "completed"
    assert runner.result_polls == 2


@pytest.mark.parametrize("status", ["failed", "stopped"])
def test_a_session_that_did_not_complete_records_its_terminal_outcome(
    tmp_path: Path, status: str,
) -> None:
    runner = FakeExecutor(tmp_path, result_status=status)
    production = session(tmp_path)

    result = asyncio.run(production.run("Solve only this task.", runner))

    assert result.status == status
    assert runner.result_polls == 2
    assert json.loads((tmp_path / "production-session-outcome.json").read_text()) == {
        "schema_version": "cortex-bench-production-session-outcome/2",
        "trial_id": "trial-direct", "session_id": "ses_production",
        "terminal": True, "status": status,
        "terminal_reason": f"session_{status}", "final_output": "done",
    }
    # The session's evidence is still exported: a failed turn is a recorded attempt.
    assert any("cortex-evidence-export" in call[0] for call in runner.calls)


def test_a_completed_session_writes_no_terminal_outcome(tmp_path: Path) -> None:
    asyncio.run(session(tmp_path).run("Solve only this task.", FakeExecutor(tmp_path)))

    assert not (tmp_path / "production-session-outcome.json").exists()


def test_session_refuses_a_status_reply_for_another_session(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path, result_session_id="ses_other")
    production = session(tmp_path)

    with pytest.raises(ProductionSessionError, match="status identity mismatch"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert production.stopped_cleanly is True


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


def test_session_posts_the_task_with_its_context_and_export_identity(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path)

    asyncio.run(session(tmp_path).run("Solve only this task.", runner))

    assert runner.payloads["production-session-ready.json"] == {"action": "ping"}
    start = runner.payloads["production-session-start.json"]
    status = runner.payloads["production-session-status.json"]
    evidence = runner.payloads["production-evidence-input.json"]
    assert start == {
        "action": "start", "message": "Solve only this task.", "projectId": "general",
        "productionBenchmarkEvidenceContext": EVIDENCE_CONTEXT,
    }
    assert status == {"action": "status", "sessionId": "ses_production"}
    assert set(evidence) == {
        "outputDirectory", "trialId", "rootRunId", "armName", "armCanonicalSha256",
        "bundleManifestHash", "proxyExport",
    }
    assert evidence["outputDirectory"] == "/logs/agent/trajectory"
    assert evidence["trialId"] == "trial-direct"
    assert evidence["rootRunId"] == "root-direct"
    assert evidence["armName"] == "cortex-direct"
    assert evidence["bundleManifestHash"] == "b" * 64
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
    assert all("production-session-start.json" not in command for command in commands)
    assert commands[-1].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


def test_session_waits_for_a_server_that_says_it_is_ready(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path, not_ready=True)
    production = session(tmp_path, readiness_timeout_seconds=0.01)

    with pytest.raises(ProductionSessionError, match="readiness timed out"):
        asyncio.run(production.run("Solve only this task.", runner))

    commands = [call[0] for call in runner.calls]
    assert all("production-session-start.json" not in command for command in commands)
    assert production.stopped_cleanly is True


def test_session_still_stops_the_server_when_export_refuses(tmp_path: Path) -> None:
    runner = FakeExecutor(tmp_path, export_failure=True)
    production = session(tmp_path)

    with pytest.raises(RuntimeError, match="export refused"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert runner.calls[-1][0].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


def test_session_refuses_a_trial_whose_attempt_ran_outside_the_task_workdir(
    tmp_path: Path,
) -> None:
    """A journal that names a different directory than the task workdir voids the trial.

    The evidence used to be free to disagree with the backend about where the model ran, and
    nothing compared them, so an attempt could work in the sealed home while its own header
    claimed the task workdir. Scoring that is scoring the wrong container state.
    """
    runner = FakeExecutor(tmp_path, journal_cwd="/logs/agent/production-cortex-home")
    production = session(tmp_path)

    with pytest.raises(ProductionSessionError, match="but the task workdir is"):
        asyncio.run(production.run("Solve only this task.", runner))

    assert runner.calls[-1][0].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


def test_session_refuses_a_trial_whose_journal_carries_no_attempt_header(
    tmp_path: Path,
) -> None:
    runner = FakeExecutor(tmp_path, journal_cwd=None)
    production = session(tmp_path)

    with pytest.raises(ProductionSessionError, match="carries no run header"):
        asyncio.run(production.run("Solve only this task.", runner))


def test_the_workspace_contract_is_read_where_the_exporter_writes_it(
    tmp_path: Path,
) -> None:
    """The journal is read through the container, on the container's own path.

    The exporter runs as root and gives its output directory mode 700, so the launcher -- an
    ordinary user on the host -- cannot stat the journal across the mount while the trial is
    still live, and by the time the tree is chowned the trial has already been scored. Reading
    it on the side that owns it is what keeps the check able to void the trial at all.
    """
    runner = FakeExecutor(tmp_path)
    production = session(tmp_path)

    asyncio.run(production.run("Solve only this task.", runner))

    reads = [command for command, _, _ in runner.calls if "events.jsonl" in command]
    assert len(reads) == 1
    assert "/logs/agent/trajectory/events.jsonl" in reads[0]


def test_session_refuses_a_trial_whose_journal_was_never_exported(
    tmp_path: Path,
) -> None:
    runner = FakeExecutor(tmp_path, export_journal=False)
    production = session(tmp_path)

    with pytest.raises(ProductionSessionError, match="was not exported"):
        asyncio.run(production.run("Solve only this task.", runner))


def test_session_refuses_a_trial_whose_journal_is_not_the_json_it_claims_to_be(
    tmp_path: Path,
) -> None:
    runner = FakeExecutor(tmp_path, malformed_journal=True)
    production = session(tmp_path)

    with pytest.raises(ProductionSessionError, match="journal is malformed"):
        asyncio.run(production.run("Solve only this task.", runner))


@pytest.mark.parametrize(
    "bundle", (DIRECT_BUNDLE, DIRECT_CODEX_BUNDLE), ids=lambda bundle: bundle.key,
)
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

    assert (result.session_id, result.status, result.final_output) == (
        "ses_production", "deadline_exhausted", None,
    )
    assert json.loads((tmp_path / "production-session-outcome.json").read_text()) == {
        "schema_version": "cortex-bench-production-session-outcome/2",
        "trial_id": "trial-direct", "session_id": "ses_production",
        "terminal": True, "status": "deadline_exhausted",
        "terminal_reason": "run_deadline_reached", "final_output": None,
    }
    commands = [call[0] for call in runner.calls]
    assert all("cortex-evidence-export" not in command for command in commands)
    assert commands[-1].startswith("kill -TERM -- -4242")
    assert production.stopped_cleanly is True


@pytest.mark.parametrize("orchestration", [
    {"mode": "coder-review", "coder_review_variant": "audit-retry", "ask_manager": False},
    {"mode": "manager", "ask_manager": False},
])
def test_session_refuses_an_arm_no_bundle_declares(
    tmp_path: Path, orchestration: dict[str, object],
) -> None:
    arm = direct_arm()
    arm["orchestration"] = orchestration

    with pytest.raises(ProductionArmError, match="production launcher"):
        session(tmp_path, arm=arm)


def test_session_refuses_a_materialized_home_from_another_arm(tmp_path: Path) -> None:
    with pytest.raises(ProductionSessionError, match="materialized home.*arm"):
        session(tmp_path, arm=direct_arm(), bundle=DIRECT_CODEX_BUNDLE)
