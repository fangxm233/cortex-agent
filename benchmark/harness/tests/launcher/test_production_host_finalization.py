# input:  production home, v2 evidence, attestations and proxy proof
# output: production admission and dynamic-name refusal proofs
# pos:    Host finalization tests for the production direct launcher
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import io
import json
import subprocess
import tarfile
from collections.abc import Mapping
from pathlib import Path

import pytest

from cortex_bench_harness.host_finalization import (
    CONTAINER_BOUNDARY_ATTESTATION_FILENAME,
    OUTER_ENVELOPE_FILENAME,
    HostFinalizationError,
    finalize_host_trial,
)
from cortex_bench_harness.launcher.production_home import (
    DIRECT_ARM_BUNDLE_DIR,
    DirectArmLaunchFacts,
    materialize_direct_arm_home,
)
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    ADMISSION_SCHEMA_VERSION,
)
from cortex_bench_harness.launcher.trial_proxy import (
    ADAPTER_SELECTION_FILENAME,
    ADAPTER_SELECTION_SCHEMA_VERSION,
    AUDIT_LOG_FILENAME,
    EXPORT_FILENAME,
    LEASE_ECHO_FILENAME,
    LEASE_ECHO_RECORD_SCHEMA_VERSION,
    TrialRevocation,
)
from cortex_bench_harness.manifest import MANIFEST_FILENAME, SCHEMA_VERSION
from cortex_bench_harness.production_output_layout import (
    ProductionOutputLayoutError,
    _production_thread_id,
)
from cortex_bench_harness.scan import ScanPolicy
from cortex_bench_harness.trial_assets import canonical_sha256

TRIAL_ID = "trial-production-finalization"
ROOT_RUN_ID = "root-production-finalization"
ARM_NAME = "cortex-direct"
THREAD_ID = "thr_0123abcd"
ATTEMPT_ID = "execution-exec-production-finalization"
LIVE_CREDENTIAL = "sk-live-production-finalization-secret"
SERVER_BEARER = "production-server-bearer-secret"
HOST_PATH = "/private/host-checkout/cortex"
SYNTHETIC_HASH = "f" * 64
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PRODUCTION_EVIDENCE_FIXTURE = Path(__file__).with_name("production_evidence_fixture.ts")


def arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": ARM_NAME, "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0,
            "max_task_depth": 0, "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 90, "max_output_tokens": 65536,
        },
    }


def write_json(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def write_npm_artifact(path: Path) -> None:
    members = {
        "defaults/prompts/directives/benchmark-direct.md": (
            DIRECT_ARM_BUNDLE_DIR / "prompts/directives/benchmark-direct.md"
        ).read_bytes(),
        "defaults/prompts/systemPrompts/benchmark-direct.md": (
            DIRECT_ARM_BUNDLE_DIR / "prompts/systemPrompts/benchmark-direct.md"
        ).read_bytes(),
    }
    with tarfile.open(path, "w:gz") as archive:
        for relative, payload in sorted(members.items()):
            info = tarfile.TarInfo(f"package/{relative}")
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))


def write_production_evidence(
    logs_dir: Path, home: Path, bundle_hash: str, *, failed: bool = False,
) -> Mapping[str, object]:
    fixture_input = logs_dir.parent / "production-evidence-input.json"
    write_json(fixture_input, {
        "home": str(home), "outputDirectory": str(logs_dir / "trajectory"),
        "trialId": TRIAL_ID, "rootRunId": ROOT_RUN_ID, "armName": ARM_NAME,
        "armCanonicalSha256": canonical_sha256(arm()),
        "bundleManifestHash": bundle_hash, "failed": failed,
    })
    subprocess.run(
        ["node", "--import", "tsx", str(PRODUCTION_EVIDENCE_FIXTURE), str(fixture_input)],
        cwd=REPOSITORY_ROOT / "agent-server", check=True,
        capture_output=True, text=True,
    )
    composite = json.loads(
        (logs_dir / "trajectory/composite-manifest.json").read_text(encoding="utf-8")
    )
    return composite["nodes"][0]


def write_production_runtime_outputs(
    home: Path, node: Mapping[str, object], *, failed: bool,
) -> None:
    exact_json = (
        "data/versions.json", "data/threads.json", "data/executions.json",
        "data/pi/settings.json", "data/pi/models.json",
    )
    for relative in exact_json:
        write_json(home / relative, {})
    settled_steps = [] if failed else [{
        "agentSlotId": "benchmark-direct", "sessionId": "track-production",
        "backendSessionId": "pi-production-session",
    }]
    write_json(home / "data/threads.json", {
        THREAD_ID: {
            "agents": {"benchmark-direct": {
                "sessionId": "track-production", "backendSessionId": None,
            }},
            "steps": settled_steps,
        },
    })
    for relative in (
        "data/pi/agents/explore.md", "data/pi/agents/general-purpose.md",
        "data/pi/agents/plan.md",
    ):
        path = home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("clean production role\n", encoding="utf-8")
    for relative in (
        "data/session-registry.jsonl", "data/costs.jsonl",
        "data/conversation-history/track-production.jsonl", "logs/gateway.log",
        "logs/sessions-pi/pi-production-session.jsonl",
        f"tmp/threads/{THREAD_ID}/artifact.md",
    ):
        path = home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n", encoding="utf-8")
    date_tag = str(node["started_at"])[0:10].replace("-", "")
    (home / f"logs/server-{date_tag}.log").write_text(
        "clean production server log\n", encoding="utf-8",
    )


def write_proxy_outputs(artifact_dir: Path) -> TrialRevocation:
    proxy = artifact_dir / "proxy"
    proxy.mkdir(parents=True)
    (proxy / AUDIT_LOG_FILENAME).write_text("{}\n", encoding="utf-8")
    lease = {"status": "available", "value": {"remaining_ms": 1}}
    lease_path = proxy / LEASE_ECHO_FILENAME
    write_json(lease_path, {
        "schema_version": LEASE_ECHO_RECORD_SCHEMA_VERSION,
        "trial_id": TRIAL_ID, "lease_echo": lease,
    })
    export_path = proxy / EXPORT_FILENAME
    write_json(export_path, {
        "schema_version": "cortex-bench-proxy-export/1", "trial_id": TRIAL_ID,
        "requests": {"status": "available", "value": 1},
        "input_tokens": {"status": "available", "value": 3},
        "output_tokens": {"status": "available", "value": 2},
        "cached_tokens": {"status": "available", "value": 0},
        "audit_log": {"status": "available", "value": {
            "entries": 1, "outcomes": {}, "durable_requests": 1,
            "durable_tokens": {"input": 3, "output": 2},
            "agrees_with_counters": True,
        }},
        "lease_echo": lease,
    })
    write_json(proxy / ADAPTER_SELECTION_FILENAME, {
        "schema_version": ADAPTER_SELECTION_SCHEMA_VERSION, "trial_id": TRIAL_ID,
    })
    revocation = {
        "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": TRIAL_ID,
        "route_active": False, "listener_present": False,
        "serving_thread_alive": False, "active_handlers": 0, "body_handlers": 0,
    }
    return TrialRevocation(None, export_path, lease_path, revocation)


def scan_policy() -> ScanPolicy:
    return ScanPolicy(
        secrets={"provider_credential": LIVE_CREDENTIAL},
        repository_checkout=HOST_PATH, hostname="private-hostname",
        forbidden_environment={"ambient": "forbidden-environment-value"},
        forbidden_argv={"argv": "forbidden-argv-value"},
        home_path="/private/host-home",
        host_identities={"machine": "private-machine-identity"},
    )


def prepare_trial(
    tmp_path: Path, *, failed: bool = False,
) -> tuple[Path, Path, Path, Path, TrialRevocation]:
    logs_dir = tmp_path / "agent"
    verifier_dir = tmp_path / "verifier"
    artifact_dir = tmp_path / "artifacts"
    verifier_dir.mkdir()
    npm_artifact = tmp_path / "server.tgz"
    write_npm_artifact(npm_artifact)
    materialized = materialize_direct_arm_home(
        cortex_home=logs_dir / "production-cortex-home",
        runtime_cortex_home=Path("/logs/agent/production-cortex-home"),
        artifacts_dir=artifact_dir,
        facts=DirectArmLaunchFacts(
            trial_id=TRIAL_ID, root_run_id=ROOT_RUN_ID, npm_artifact=npm_artifact,
            backend_cli_version="0.82.1",
            proxy_base_url=f"http://{TRIAL_ID}.proxy.invalid:49152",
            dummy_token_ref="trial-dummy-token",
            model_alias_policy={"policy": "exact"},
        ),
        inherited_environment={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    node = write_production_evidence(
        logs_dir, materialized.cortex_home, materialized.bundle_manifest_hash, failed=failed,
    )
    write_production_runtime_outputs(materialized.cortex_home, node, failed=failed)
    (logs_dir / "instruction.md").write_text("Solve the task.\n", encoding="utf-8")
    (logs_dir / "stdout.txt").write_text("clean stdout\n", encoding="utf-8")
    (logs_dir / "stderr.txt").write_text("clean stderr\n", encoding="utf-8")
    (logs_dir / "workspace.diff").write_text(
        '{"schema_version":"cortex-bench-workspace-evidence/1"}\n', encoding="utf-8",
    )
    write_json(artifact_dir / MANIFEST_FILENAME, {
        "schema_version": SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID, "arm": ARM_NAME,
    })
    write_json(artifact_dir / ADMISSION_EVIDENCE_FILENAME, {
        "schema_version": ADMISSION_SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
    })
    write_json(artifact_dir / CONTAINER_BOUNDARY_ATTESTATION_FILENAME, {
        "schema_version": "cortex-bench-container-boundary-attestation/1",
        "trial_id": TRIAL_ID, "observed_at": "2026-08-17T00:00:02.000Z",
        "container_exit": {"status": "exited", "exit_code": 0, "running": False, "pid": 0},
        "post_stop": {"descendants_alive": 0, "process_namespace_alive": False},
    })
    return logs_dir, verifier_dir, artifact_dir, npm_artifact, write_proxy_outputs(artifact_dir)


def set_attempt_times(logs: Path, started_at: str, ended_at: str) -> None:
    terminal_path = logs / "trajectory" / f"run-{ROOT_RUN_ID}.terminal.json"
    terminal = json.loads(terminal_path.read_text(encoding="utf-8"))
    terminal.update({"started_at": started_at, "ended_at": ended_at})
    write_json(terminal_path, terminal)
    composite_path = logs / "trajectory/composite-manifest.json"
    composite = json.loads(composite_path.read_text(encoding="utf-8"))
    composite["nodes"][0].update({"started_at": started_at, "ended_at": ended_at})
    composite["nodes"][0]["terminal_manifest_sha256"] = hashlib.sha256(
        terminal_path.read_bytes()
    ).hexdigest()
    write_json(composite_path, composite)


def rewrite_exported_journal_witness(
    logs: Path, witness: str, replacement: str,
) -> None:
    journal_path = logs / "trajectory/events.jsonl"
    rows = [json.loads(line) for line in journal_path.read_text().splitlines()]
    rows[0][witness] = replacement
    journal_path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )
    terminal_path = logs / "trajectory" / f"run-{ROOT_RUN_ID}.terminal.json"
    terminal = json.loads(terminal_path.read_text(encoding="utf-8"))
    terminal["journal_sha256"] = hashlib.sha256(journal_path.read_bytes()).hexdigest()
    write_json(terminal_path, terminal)
    composite_path = logs / "trajectory/composite-manifest.json"
    composite = json.loads(composite_path.read_text(encoding="utf-8"))
    composite["nodes"][0]["journal_sha256"] = terminal["journal_sha256"]
    composite["nodes"][0]["terminal_manifest_sha256"] = hashlib.sha256(
        terminal_path.read_bytes()
    ).hexdigest()
    write_json(composite_path, composite)


def finalize(tmp_path: Path):
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    return finalize_host_trial(
        logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
        root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
        npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
        revocation=revocation, scan_policy=scan_policy(),
    )


def test_exact_production_direct_layout_reaches_grader_admission(tmp_path: Path) -> None:
    result = finalize(tmp_path)
    envelope = json.loads(result.path.read_bytes())
    classified = {
        item["relative_path"]: item["source"]
        for item in envelope["classification"]["files"] if item["root"] == "agent"
    }

    assert result.admitted is True
    assert envelope["grader_admission"]["admitted"] is True
    assert "arm-resolution.json" not in classified
    assert not any(path.startswith("trial-home/") for path in classified)
    assert classified["production-cortex-home/config/profiles.json"] == (
        "production_profile"
    )
    assert classified["production-cortex-home/data/pi/auth.json"] == (
        "production_pi_dummy_auth"
    )
    assert classified["production-cortex-home/data/benchmark-attempt-identities.jsonl"] == (
        "production_attempt_identities"
    )
    assert classified[
        "production-cortex-home/data/conversation-history/track-production.jsonl"
    ] == "production_conversation_history"
    assert classified[
        "production-cortex-home/logs/sessions-pi/pi-production-session.jsonl"
    ] == "production_pi_session"
    assert classified[
        f"production-cortex-home/tmp/threads/{THREAD_ID}/artifact.md"
    ] == "production_thread_artifact"
    serialized = result.path.read_text(encoding="utf-8")
    raw_journal = (
        tmp_path / "agent/production-cortex-home/data/benchmark-attempt-journals"
        / f"{hashlib.sha256(ATTEMPT_ID.encode()).hexdigest()}.ndjson"
    )
    assert raw_journal.read_bytes() == (
        tmp_path / "agent/trajectory/events.jsonl"
    ).read_bytes()
    assert not (tmp_path / "agent/production-server-auth.json").exists()
    assert all(value not in serialized for value in (
        SERVER_BEARER, LIVE_CREDENTIAL, HOST_PATH, "synthetic-evidence-value",
    ))


@pytest.mark.parametrize("source", ["journal", "identity"])
def test_production_direct_rejects_substituted_authoritative_evidence(
    tmp_path: Path, source: str,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    home = logs / "production-cortex-home"
    if source == "journal":
        journal = home / "data/benchmark-attempt-journals" / (
            f"{hashlib.sha256(ATTEMPT_ID.encode()).hexdigest()}.ndjson"
        )
        journal.write_bytes(journal.read_bytes() + b"{}\n")
    else:
        identity = home / "data/benchmark-attempt-identities.jsonl"
        row = json.loads(identity.read_text(encoding="utf-8"))
        row["role_tool_surface_hash"] = SYNTHETIC_HASH
        identity.write_text(json.dumps(row) + "\n", encoding="utf-8")

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert raised.value.reason == "collected_output_invalid"
    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


def test_production_direct_rejects_a_structured_spawn_config_witness(
    tmp_path: Path,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    system_prompt = (
        logs / "production-cortex-home/prompts/systemPrompts/benchmark-direct.md"
    ).read_text(encoding="utf-8")
    incompatible = hashlib.sha256(json.dumps({
        "systemPrompt": system_prompt, "appendSystemPrompt": None,
    }, separators=(",", ":")).encode()).hexdigest()
    rewrite_exported_journal_witness(logs, "system_prompt_sha256", incompatible)

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert raised.value.reason == "trial_asset_mismatch"
    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


def test_failed_production_direct_publishes_unchanged_non_admitted_envelope(
    tmp_path: Path,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path, failed=True)
    composite_path = logs / "trajectory/composite-manifest.json"
    expected_composite = hashlib.sha256(composite_path.read_bytes()).hexdigest()

    result = finalize_host_trial(
        logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
        root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
        npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
        revocation=revocation, scan_policy=scan_policy(),
    )
    envelope = json.loads(result.path.read_bytes())

    assert result.admitted is False
    assert envelope["inner"]["composite_sha256"] == expected_composite
    assert envelope["grader_admission"] == {
        "admitted": False, "reason": "inner_terminal_not_ok",
        "terminal_state": "failed", "terminal_reason": "rate_limited",
    }


@pytest.mark.parametrize("mutation", ["missing", "malformed"])
def test_failed_production_direct_requires_a_valid_composite(
    tmp_path: Path, mutation: str,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path, failed=True)
    composite_path = logs / "trajectory/composite-manifest.json"
    if mutation == "missing":
        composite_path.unlink()
    else:
        write_json(composite_path, {"synthetic": True})

    with pytest.raises(HostFinalizationError):
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


@pytest.mark.parametrize(("relative", "reason"), [
    ("production-cortex-home/config/profiles.json", "launch_attestation_invalid"),
    ("production-cortex-home/data/pi/auth.json", "launch_attestation_invalid"),
    ("production-cortex-home/data/benchmark-attempt-identities.jsonl", "required_output_missing"),
    (
        f"production-cortex-home/data/benchmark-attempt-journals/"
        f"{hashlib.sha256(ATTEMPT_ID.encode()).hexdigest()}.ndjson",
        "required_output_missing",
    ),
    ("production-cortex-home/data/conversation-history/track-production.jsonl", "required_output_missing"),
    ("production-cortex-home/logs/sessions-pi/pi-production-session.jsonl", "required_output_missing"),
    (f"production-cortex-home/tmp/threads/{THREAD_ID}/artifact.md", "required_output_missing"),
])
def test_production_direct_refuses_missing_authoritative_outputs(
    tmp_path: Path, relative: str, reason: str,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    target = logs / relative
    target.parent.chmod(0o755)
    target.unlink()

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert raised.value.reason == reason
    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


@pytest.mark.parametrize("relative", [
    "production-cortex-home/auth.json",
    "production-cortex-home/data/pi/credential.json",
    "production-cortex-home/home/.env",
    "production-server-auth.json",
    "production-cortex-home/data/pi/auth-copy.json",
])
def test_production_direct_refuses_forbidden_lookalikes(
    tmp_path: Path, relative: str,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    path = logs / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("clean lookalike\n", encoding="utf-8")

    with pytest.raises(HostFinalizationError):
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


@pytest.mark.parametrize(("started_at", "ended_at", "log_dates"), [
    (
        "2026-08-17T23:59:59.000Z", "2026-08-18T00:00:01.000Z",
        ("20260817", "20260818"),
    ),
    (
        "2026-08-17T00:00:10.000Z", "2026-08-17T00:00:12.000Z",
        ("20260816", "20260817"),
    ),
    (
        "2026-08-17T12:00:00.000Z", "2026-08-17T12:00:01.000Z",
        ("20260816",),
    ),
])
def test_production_server_logs_are_bound_to_the_utc_attempt_window(
    tmp_path: Path, started_at: str, ended_at: str, log_dates: tuple[str, ...],
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    set_attempt_times(logs, started_at, ended_at)
    for existing in (logs / "production-cortex-home/logs").glob("server-*.log"):
        existing.unlink()
    for date in log_dates:
        (logs / f"production-cortex-home/logs/server-{date}.log").write_text(
            "clean server log\n", encoding="utf-8",
        )

    result = finalize_host_trial(
        logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
        root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
        npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
        revocation=revocation, scan_policy=scan_policy(),
    )

    assert result.admitted is True


def test_missing_production_server_log_refuses_before_publication(tmp_path: Path) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    for existing in (logs / "production-cortex-home/logs").glob("server-*.log"):
        existing.unlink()

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert raised.value.reason == "required_output_missing"
    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


def test_unrelated_server_log_date_remains_unknown(tmp_path: Path) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    set_attempt_times(
        logs, "2026-08-17T12:00:00.000Z", "2026-08-17T12:00:01.000Z",
    )
    (logs / "production-cortex-home/logs/server-20260815.log").write_text(
        "clean unrelated log\n", encoding="utf-8",
    )

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert raised.value.reason == "unknown_output_present"


@pytest.mark.parametrize(("removed", "replacement"), [
    (
        f"production-cortex-home/tmp/threads/{THREAD_ID}/artifact.md",
        "production-cortex-home/tmp/threads/thr_deadbeef/artifact.md",
    ),
    (
        f"production-cortex-home/data/benchmark-attempt-journals/"
        f"{hashlib.sha256(ATTEMPT_ID.encode()).hexdigest()}.ndjson",
        f"production-cortex-home/data/benchmark-attempt-journals/{'e' * 64}.ndjson",
    ),
])
def test_pattern_shaped_replacements_do_not_satisfy_authoritative_outputs(
    tmp_path: Path, removed: str, replacement: str,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    (logs / removed).unlink()
    replacement_path = logs / replacement
    replacement_path.parent.mkdir(parents=True, exist_ok=True)
    replacement_path.write_text("{}\n", encoding="utf-8")

    with pytest.raises(HostFinalizationError):
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )


@pytest.mark.parametrize("relative", [
    "production-cortex-home/logs/sessions-pi/credential.jsonl",
    "production-cortex-home/data/conversation-history/auth.jsonl",
])
def test_dynamic_output_names_not_bound_to_production_state_are_unknown(
    tmp_path: Path, relative: str,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    path = logs / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n", encoding="utf-8")

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert raised.value.reason == "unknown_output_present"


@pytest.mark.parametrize(("identity_key", "identity", "original", "replacement"), [
    (
        "sessionId", "auth",
        "data/conversation-history/track-production.jsonl",
        "data/conversation-history/auth.jsonl",
    ),
    (
        "sessionId", ".env",
        "data/conversation-history/track-production.jsonl",
        "data/conversation-history/.env.jsonl",
    ),
    (
        "sessionId", "auth$",
        "data/conversation-history/track-production.jsonl",
        "data/conversation-history/auth_.jsonl",
    ),
    (
        "sessionId", "a-u-t-h",
        "data/conversation-history/track-production.jsonl",
        "data/conversation-history/a-u-t-h.jsonl",
    ),
    (
        "sessionId", "cre-den-tial",
        "data/conversation-history/track-production.jsonl",
        "data/conversation-history/cre-den-tial.jsonl",
    ),
    (
        "backendSessionId", "credential",
        "logs/sessions-pi/pi-production-session.jsonl",
        "logs/sessions-pi/credential.jsonl",
    ),
])
def test_production_state_cannot_bind_forbidden_dynamic_output_names(
    tmp_path: Path, identity_key: str, identity: str,
    original: str, replacement: str,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    home = logs / "production-cortex-home"
    threads_path = home / "data/threads.json"
    threads = json.loads(threads_path.read_text(encoding="utf-8"))
    threads[THREAD_ID]["steps"][0][identity_key] = identity
    write_json(threads_path, threads)
    (home / original).unlink()
    replacement_path = home / replacement
    replacement_path.parent.mkdir(parents=True, exist_ok=True)
    replacement_path.write_text("{}\n", encoding="utf-8")

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert raised.value.reason == "collected_output_invalid"
    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


@pytest.mark.parametrize("thread_id", [".env", "thr_auth"])
def test_production_thread_output_identity_uses_the_exact_runtime_grammar(
    thread_id: str,
) -> None:
    with pytest.raises(ProductionOutputLayoutError):
        _production_thread_id({"thread_id": thread_id})


@pytest.mark.parametrize("value", [SERVER_BEARER, LIVE_CREDENTIAL, HOST_PATH])
def test_production_direct_never_admits_sensitive_values(tmp_path: Path, value: str) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    (logs / "stdout.txt").write_text(value + "\n", encoding="utf-8")
    policy = scan_policy()
    if value == SERVER_BEARER:
        policy = ScanPolicy(
            secrets={**policy.secrets, "server_bearer": SERVER_BEARER},
            repository_checkout=policy.repository_checkout, hostname=policy.hostname,
            forbidden_environment=policy.forbidden_environment,
            forbidden_argv=policy.forbidden_argv, home_path=policy.home_path,
            host_identities=policy.host_identities,
        )

    with pytest.raises(HostFinalizationError) as raised:
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=policy,
        )

    assert raised.value.reason == "output_leak_or_inventory_failure"


def test_only_the_exact_semantic_direct_arm_selects_the_production_layout(
    tmp_path: Path,
) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    misaligned = arm()
    limits = dict(misaligned["limits"])
    limits["max_output_tokens"] = 8192
    misaligned["limits"] = limits

    with pytest.raises(HostFinalizationError):
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=misaligned,
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()


def test_production_direct_rejects_a_synthetic_identity_value(tmp_path: Path) -> None:
    logs, verifier, artifacts, npm_artifact, revocation = prepare_trial(tmp_path)
    terminal = logs / "trajectory" / f"run-{ROOT_RUN_ID}.terminal.json"
    value = json.loads(terminal.read_text(encoding="utf-8"))
    value["bundle_manifest_hash"] = SYNTHETIC_HASH
    write_json(terminal, value)

    with pytest.raises(HostFinalizationError):
        finalize_host_trial(
            logs_dir=logs, verifier_dir=verifier, artifact_dir=artifacts,
            root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=arm(),
            npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT,
            revocation=revocation, scan_policy=scan_policy(),
        )

    assert not (artifacts / OUTER_ENVELOPE_FILENAME).exists()
