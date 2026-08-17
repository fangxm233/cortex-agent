# input:  production home, v2 evidence, attestations and proxy proof
# output: production admission and dynamic-name refusal proofs
# pos:    Host finalization tests for the production direct launcher
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import io
import json
import tarfile
from collections.abc import Callable, Mapping
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
from cortex_bench_harness.scan import ScanPolicy
from cortex_bench_harness.trial_assets import canonical_sha256

TRIAL_ID = "trial-production-finalization"
ROOT_RUN_ID = "root-production-finalization"
ARM_NAME = "cortex-direct"
THREAD_ID = "thr_0123abcd"
ATTEMPT_ID = f"thread-{THREAD_ID}"
MODEL_HASH = hashlib.sha256(b"production-model-identity").hexdigest()
ROLE_HASH = hashlib.sha256(b"production-role-surface").hexdigest()
LIVE_CREDENTIAL = "sk-live-production-finalization-secret"
SERVER_BEARER = "production-server-bearer-secret"
HOST_PATH = "/private/host-checkout/cortex"
SYNTHETIC_HASH = "f" * 64
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
TOOLS = "agent,bash,edit,glob,grep,read,skill,todo_write,write".split(",")
DIRECT_CHECK_IDS = (
    "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8",
    "D1", "D2", "D3", "D4", "D5", "D6",
)


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


def journal_bytes(home: Path, bundle_hash: str) -> bytes:
    system_prompt = home / "prompts/systemPrompts/benchmark-direct.md"
    header = {
        "schema_version": "cortex-bench-journal/1", "type": "run_header",
        "root_run_id": ROOT_RUN_ID, "thread_id": THREAD_ID,
        "agent_slot": "benchmark-direct",
        "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH,
        "bundle_manifest_hash": bundle_hash,
        "system_prompt_sha256": hashlib.sha256(system_prompt.read_bytes()).hexdigest(),
        "tool_manifest_sha256": canonical_sha256(TOOLS),
        "plugin_manifest_sha256": canonical_sha256({"plugin_dirs": [], "skills": []}),
    }
    event = {"schema_version": "cortex-bench-journal/1", "type": "event"}
    return (json.dumps(header, sort_keys=True) + "\n" + json.dumps(event) + "\n").encode()


def terminal_document(journal: bytes, bundle_hash: str) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-manifest/2", "state": "completed",
        "started_at": "2026-08-17T00:00:00.000Z",
        "ended_at": "2026-08-17T00:00:01.000Z", "journal_path": "events.jsonl",
        "journal_sha256": hashlib.sha256(journal).hexdigest(), "event_count": 1,
        "steps": 1, "cost_usd": 0,
        "tokens": {"input": 3, "output": 2, "cache_read": 0, "cache_creation": 0},
        "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH,
        "bundle_manifest_hash": bundle_hash, "terminal_reason": "ok",
    }


def accounting() -> dict[str, object]:
    unavailable = {"status": "unavailable", "reason": "counter_unreadable"}
    return {
        "schema_version": "cortex-bench-accounting/2", "trial_id": TRIAL_ID,
        "proxy": {
            "requests": unavailable, "cached_tokens": unavailable,
            "input_tokens": unavailable, "output_tokens": unavailable,
            "audit_log": unavailable, "lease_echo": unavailable,
            "source": "proxy_export",
        },
        "journal": {
            "requests": {"status": "unavailable", "reason": "journal_underivable"},
            "cost_usd": {"status": "available", "value": "0"},
            "steps": {"status": "available", "value": 1},
            "tokens": {
                "input": {"status": "available", "value": 3},
                "output": {"status": "available", "value": 2},
                "cached": {"status": "available", "value": 0},
            },
            "source": "trajectory_merge",
        },
        "unaccounted_roles": [],
    }


def composite_document(
    terminal_sha256: str, journal: bytes, bundle_hash: str,
) -> dict[str, object]:
    terminal = terminal_document(journal, bundle_hash)
    node = {
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID, "task_id": TRIAL_ID,
        "parent_task_id": None, "dispatch_generation": None,
        "attempt_id": ATTEMPT_ID, "attempt_ordinal": 1,
        "thread_id": THREAD_ID, "parent_thread_id": None,
        "root_thread_id": THREAD_ID, "task_ancestry": [TRIAL_ID],
        "template": "benchmark-direct", "role": "benchmark-direct", "stage": None,
        "backend": "pi", "provider": "deepseek",
        "requested_model": "deepseek-v4-flash", "reported_model": "deepseek-v4-flash",
        "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH, "bundle_manifest_hash": bundle_hash,
        "terminal_state": "completed", "terminal_reason": "ok", "disposition": "none",
        "superseded_by": None, "artifact_path": None, "artifact_sha256": None,
        "journal_path": "events.jsonl", "journal_sha256": terminal["journal_sha256"],
        "event_count": 1, "terminal_manifest_path": f"run-{ROOT_RUN_ID}.terminal.json",
        "terminal_manifest_sha256": terminal_sha256, "edges": [],
        "started_at": terminal["started_at"], "ended_at": terminal["ended_at"],
        "steps": 1, "cost_usd": 0, "tokens": terminal["tokens"],
        "provider_requests": None,
    }
    return {
        "schema_version": "cortex-bench-composite-manifest/2", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID, "arm_name": ARM_NAME,
        "arm_canonical_sha256": canonical_sha256(arm()),
        "identity": {
            "model_execution_identity_hash": {"benchmark-direct": MODEL_HASH},
            "role_tool_surface_hash": {"benchmark-direct": ROLE_HASH},
            "bundle_manifest_hash": bundle_hash,
        },
        "nodes": [node], "edges": [],
        "roots": {"root_attempt_id": ATTEMPT_ID, "root_task_id": None},
        "accounting": accounting(),
        "predicate": {"mode": "direct", "checks": [
            {"check_id": check_id, "result": "pass", "detail": None}
            for check_id in DIRECT_CHECK_IDS
        ]},
    }


def write_trajectory(logs_dir: Path, home: Path, bundle_hash: str) -> None:
    root = logs_dir / "trajectory"
    root.mkdir(parents=True)
    journal = journal_bytes(home, bundle_hash)
    (root / "events.jsonl").write_bytes(journal)
    write_json(root / f"run-{ROOT_RUN_ID}.started.json", {
        "root_run_id": ROOT_RUN_ID, "thread_id": THREAD_ID,
        "ts": "2026-08-17T00:00:00.000Z", "journal_path": "events.jsonl",
    })
    terminal_path = root / f"run-{ROOT_RUN_ID}.terminal.json"
    write_json(terminal_path, terminal_document(journal, bundle_hash))
    terminal_sha = hashlib.sha256(terminal_path.read_bytes()).hexdigest()
    write_json(root / "composite-manifest.json", composite_document(
        terminal_sha, journal, bundle_hash,
    ))
    write_json(root / "trajectory.json", {"schema_version": "ATIF-v1.2", "steps": []})


def write_production_runtime_outputs(home: Path) -> None:
    exact_json = (
        "data/versions.json", "data/threads.json", "data/executions.json",
        "data/pi/settings.json", "data/pi/models.json",
    )
    for relative in exact_json:
        write_json(home / relative, {})
    write_json(home / "data/threads.json", {
        THREAD_ID: {"steps": [{
            "agentSlotId": "benchmark-direct", "sessionId": "track-production",
            "backendSessionId": "pi-production-session",
        }]},
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
        "data/benchmark-attempt-identities.jsonl",
        "data/benchmark-attempt-journals.jsonl",
        f"data/benchmark-attempt-journals/{hashlib.sha256(ATTEMPT_ID.encode()).hexdigest()}.ndjson",
        "data/conversation-history/track-production.jsonl",
        "logs/server-20260817.log", "logs/gateway.log",
        "logs/sessions-pi/pi-production-session.jsonl",
        f"tmp/threads/{THREAD_ID}/artifact.md",
    ):
        path = home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n", encoding="utf-8")


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


def prepare_trial(tmp_path: Path) -> tuple[Path, Path, Path, Path, TrialRevocation]:
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
    write_production_runtime_outputs(materialized.cortex_home)
    write_trajectory(logs_dir, materialized.cortex_home, materialized.bundle_manifest_hash)
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
        f"production-cortex-home/tmp/threads/{THREAD_ID}/artifact.md"
    ] == "production_thread_artifact"
    serialized = result.path.read_text(encoding="utf-8")
    assert not (tmp_path / "agent/production-server-auth.json").exists()
    assert all(value not in serialized for value in (
        SERVER_BEARER, LIVE_CREDENTIAL, HOST_PATH, "synthetic-evidence-value",
    ))


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
    ("production-cortex-home/logs/server-20260817.log", "required_output_missing"),
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
    (logs / "production-cortex-home/logs/server-20260817.log").unlink()
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
