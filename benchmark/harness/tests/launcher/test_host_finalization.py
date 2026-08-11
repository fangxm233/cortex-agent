# input:  production Harbor agent, fake inner outputs, live offline proxy
# output: outer admission, refusal, redaction, and durability proofs
# pos:    Production host-finalization contract tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import hashlib
import json
import socket
from collections.abc import Callable, Mapping
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

import cortex_bench_harness.host_finalization as finalization
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.host_finalization import (
    OUTER_ENVELOPE_FILENAME,
    HostFinalizationError,
)
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    environment_digest,
)
from cortex_bench_harness.launcher.trial_proxy import (
    PROXY_ARTIFACT_SOURCES,
    TrialProxySession,
)
from cortex_bench_harness.proxy.lease import LEASE_ECHO_SCHEMA_VERSION, LEASE_ECHO_TARGET
from capability_admission import admit_every_capability

DIGEST = f"sha256:{'a' * 64}"
ROOT_RUN_ID = "root-host-finalization"
TRIAL_ID = "trial-host-finalization"
ARM_NAME = "cortex-direct"
MODEL_HASH = "1" * 64
ROLE_HASH = "2" * 64
BUNDLE_HASH = "3" * 64
CREDENTIAL_ENV = "CORTEX_BENCH_FINALIZATION_CREDENTIAL"
FORBIDDEN_ENV_NAME = "CORTEX_BENCH_FINALIZATION_FORBIDDEN_ENV"
FORBIDDEN_ARGV_NAME = "CORTEX_BENCH_FINALIZATION_FORBIDDEN_ARGV"
HOST_CHECKOUT_NAME = "CORTEX_BENCH_FINALIZATION_HOST_CHECKOUT"
HOST_IDENTITY_NAME = "CORTEX_BENCH_FINALIZATION_HOST_IDENTITY"
REAL_CREDENTIAL = "sk-ant-FINALIZATION-REAL-CREDENTIAL"
FORBIDDEN_ENV = "forbidden-environment-value-unique"
FORBIDDEN_ARGV = "forbidden-argv-value-unique"
HOST_CHECKOUT = "/srv/private/cortex-checkout"
HOST_HOME = "/private/host-home/fangxin"
HOSTNAME = "private-hostname-unique"
HOST_IDENTITY = "machine-identity-unique"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
DIRECT_CHECK_IDS = (
    "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8",
    "D1", "D2", "D3", "D4", "D5", "D6",
)


def closed_upstream() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


def arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": ARM_NAME, "backend": "claude",
        "provider": "anthropic", "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 120,
        },
    }


def trial_seed(upstream: str) -> dict[str, object]:
    return {
        "arm": arm(), "arm_path": f"arm://{ARM_NAME}", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
        "task": {"task_id": "terminal-task", "image_ref": f"task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {
            "upstream_base_url": upstream, "route_identity_host": "api.anthropic.com",
            "proxy_base_url": "http://proxy.invalid", "dummy_token_ref": "dummy-ref",
        },
        "model_alias_policy": {"kind": "exact"},
    }


def manifest_seed(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl", "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"finalization fixture")
    return {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID, "arm": ARM_NAME,
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": len(b"finalization fixture"),
    }


def proxy_spec() -> dict[str, object]:
    return {
        "credential_env": CREDENTIAL_ENV, "bound_source_ip": "127.0.0.1",
        "max_request_cost_usd": "1.00", "input_cost_per_million_usd": "3",
        "output_cost_per_million_usd": "15",
    }


def scan_policy() -> dict[str, object]:
    return {
        "secret_environment": {"provider_credential": CREDENTIAL_ENV},
        "forbidden_environment": {"ambient_forbidden": FORBIDDEN_ENV_NAME},
        "forbidden_argv_environment": {"host_argv": FORBIDDEN_ARGV_NAME},
        "repository_checkout_environment": HOST_CHECKOUT_NAME,
        "host_identity_environment": {"machine": HOST_IDENTITY_NAME},
    }


def canonical_sha256(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def journal_bytes() -> bytes:
    header = {
        "schema_version": "cortex-bench-journal/1", "type": "run_header",
        "root_run_id": ROOT_RUN_ID, "thread_id": None, "agent_slot": "parent",
        "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH, "bundle_manifest_hash": BUNDLE_HASH,
    }
    return (json.dumps(header, sort_keys=True) + "\n").encode()


def terminal_document(journal: bytes) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-manifest/1", "state": "completed",
        "started_at": "2026-08-11T00:00:00.000Z",
        "ended_at": "2026-08-11T00:00:01.000Z", "journal_path": "events.jsonl",
        "journal_sha256": hashlib.sha256(journal).hexdigest(), "event_count": 0,
        "supervisor": {"quiescent": True, "descendants": 0}, "steps": 1,
        "cost_usd": 0, "tokens": {"input": 0, "output": 0},
        "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH, "bundle_manifest_hash": BUNDLE_HASH,
        "terminal_reason": "ok",
    }


def accounting() -> dict[str, object]:
    unavailable = {"status": "unavailable", "reason": "counter_unreadable"}
    available_zero = {"status": "available", "value": "0"}
    unavailable_delta = {"status": "unavailable", "reason": "operand_unavailable"}
    return {
        "schema_version": "cortex-bench-accounting/1", "trial_id": TRIAL_ID,
        "proxy": {"requests": unavailable, "cost_usd": unavailable,
                  "input_tokens": unavailable, "output_tokens": unavailable,
                  "audit_log": unavailable, "lease_echo": unavailable,
                  "source": "proxy_export"},
        "journal": {"requests": {"status": "unavailable", "reason": "journal_underivable"},
                    "cost_usd": available_zero, "steps": {"status": "available", "value": 1},
                    "tokens": {"input": {"status": "available", "value": 0},
                               "output": {"status": "available", "value": 0},
                               "cached": {"status": "available", "value": 0}},
                    "source": "trajectory_merge"},
        "tolerance": {"requests_abs": 0, "cost_usd_rel": "0.01",
                      "cost_usd_abs_floor": "0.000001"},
        "deltas": {"requests": unavailable_delta, "cost_usd": unavailable_delta},
        "reconciled": unavailable_delta, "unaccounted_roles": [],
        "checks": [{"check_id": "accounting_operand_unavailable", "passed": False,
                    "failure_code": 41,
                    "detail": "proxy.requests, proxy.cost_usd, proxy.lease_echo"}],
    }


def production_predicate(*, all_pass: bool = False) -> dict[str, object]:
    checks = []
    for check_id in DIRECT_CHECK_IDS:
        passed = all_pass or check_id == "D2"
        checks.append({
            "check_id": check_id, "result": "pass" if passed else "unavailable",
            "detail": None if passed else "not evaluated at this pin",
        })
    return {"mode": "direct", "checks": checks}


def attempt_node(terminal_sha256: str) -> dict[str, object]:
    terminal = terminal_document(journal_bytes())
    return {
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID, "task_id": TRIAL_ID,
        "parent_task_id": None, "dispatch_generation": None,
        "attempt_id": f"run-{ROOT_RUN_ID}", "attempt_ordinal": 1,
        "thread_id": None, "parent_thread_id": None, "root_thread_id": None,
        "task_ancestry": [TRIAL_ID], "template": None, "role": "parent", "stage": None,
        "backend": "claude", "provider": "anthropic", "requested_model": "claude-sonnet",
        "reported_model": None, "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH, "bundle_manifest_hash": BUNDLE_HASH,
        "terminal_state": "completed", "terminal_reason": "ok", "disposition": "none",
        "superseded_by": None, "artifact_path": None, "artifact_sha256": None,
        "journal_path": "events.jsonl", "journal_sha256": terminal["journal_sha256"],
        "event_count": 0, "terminal_manifest_path": f"run-{ROOT_RUN_ID}.terminal.json",
        "terminal_manifest_sha256": terminal_sha256, "edges": [],
        "started_at": terminal["started_at"], "ended_at": terminal["ended_at"],
        "steps": 1, "cost_usd": 0,
        "tokens": {"input": 0, "output": 0, "cache_read": None, "cache_creation": None},
        "provider_requests": None,
    }


def composite_document(terminal_sha256: str) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-composite-manifest/1", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID, "arm_name": ARM_NAME,
        "arm_canonical_sha256": canonical_sha256(arm()),
        "identity": {"model_execution_identity_hash": {"parent": MODEL_HASH},
                     "role_tool_surface_hash": {"parent": ROLE_HASH},
                     "bundle_manifest_hash": BUNDLE_HASH},
        "nodes": [attempt_node(terminal_sha256)], "edges": [],
        "roots": {"parent_attempt_id": f"run-{ROOT_RUN_ID}", "root_task_id": None},
        "accounting": accounting(), "predicate": production_predicate(),
    }


def write_json(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")


def write_trial_state_outputs(logs_dir: Path) -> None:
    state = logs_dir / "trial-home/cortex-home/state"
    for name in ("tasks", "threads", "sessions", "executions"):
        write_json(state / f"{name}.json", {})
    write_json(logs_dir / "trial-home/cortex-home/config/profiles.json", {
        "defaultProfile": "benchmark", "profiles": {"benchmark": {"backend": "claude"}},
    })
    (logs_dir / "trial-home/tmp").mkdir(parents=True)
    (logs_dir / "trial-home/tmp/backend-cache.txt").write_text("clean optional state\n")


def write_inner_outputs(logs_dir: Path, mutation: Callable[[Path], None] | None) -> None:
    write_trial_state_outputs(logs_dir)
    root = logs_dir / "trajectory"
    root.mkdir(parents=True, exist_ok=True)
    journal = journal_bytes()
    (root / "events.jsonl").write_bytes(journal)
    write_json(root / f"run-{ROOT_RUN_ID}.started.json", {
        "root_run_id": ROOT_RUN_ID, "thread_id": None,
        "ts": "2026-08-11T00:00:00.000Z", "journal_path": "events.jsonl",
    })
    terminal_path = root / f"run-{ROOT_RUN_ID}.terminal.json"
    write_json(terminal_path, terminal_document(journal))
    terminal_sha = hashlib.sha256(terminal_path.read_bytes()).hexdigest()
    write_json(root / "composite-manifest.json", composite_document(terminal_sha))
    write_json(root / "trajectory.json", {"schema_version": "ATIF-v1.2", "steps": []})
    if mutation is not None:
        mutation(root)


class FinalizationEnvironment:
    def __init__(self, logs_dir: Path, mutation: Callable[[Path], None] | None = None) -> None:
        self.logs_dir = logs_dir
        self.mutation = mutation
        self.calls: list[str] = []
        self.run_return_code = 0
        self.workspace_return_code = 0
        self.workspace_payload = "clean collected workspace output\n"

    async def exec(self, command: str, **_kwargs: object) -> ExecResult:
        self.calls.append(command)
        if command.endswith("pwd") or "realpath -- /app" in command:
            return ExecResult(stdout="/app\n", return_code=0)
        if "npm ls --global" in command:
            return ExecResult(stdout=f"{BUNDLE_ROOT}\n", return_code=0)
        if command.endswith("cortex daemon --version"):
            return ExecResult(stdout="2026.8.11\n", return_code=0)
        if "command -v claude" in command:
            return ExecResult(stdout="/usr/local/bin/claude\n", return_code=0)
        if command.endswith("claude --version"):
            return ExecResult(stdout="1.2.3 (Claude Code)\n", return_code=0)
        if "cortex agent-run" in command and "--prompt-file" in command:
            if self.run_return_code == 0:
                write_inner_outputs(self.logs_dir, self.mutation)
            return ExecResult(
                stdout="clean stdout\n", stderr="clean stderr\n",
                return_code=self.run_return_code,
            )
        if "cortex-bench-workspace-evidence/1" in command:
            if self.workspace_return_code == 0:
                header = b'{"schema_version":"cortex-bench-workspace-evidence/1"}\n'
                entry = b'{"path":"solution.txt","kind":"file"}\n'
                (self.logs_dir / "workspace.diff").write_bytes(
                    header + entry + self.workspace_payload.encode() + b"\n")
            return ExecResult(return_code=self.workspace_return_code)
        return ExecResult(return_code=0)

    async def upload_file(self, _source_path: Path | str, _target_path: str) -> None:
        return None


def post_lease(session: TrialProxySession) -> None:
    listener = urlsplit(session.handle.base_url)
    connection = HTTPConnection(listener.hostname, listener.port, timeout=5)
    body = json.dumps({
        "schema_version": LEASE_ECHO_SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "compiled_at_epoch_ms": 1_800_000_000_000,
        "absolute_epoch_ms": 1_800_000_120_000, "remaining_ms": 115_000,
    }).encode()
    connection.request("POST", LEASE_ECHO_TARGET, body=body, headers={
        "authorization": f"Bearer {session.handle.dummy_token}",
        "content-type": "application/json", "content-length": str(len(body)),
    })
    response = connection.getresponse()
    response.read()
    connection.close()
    assert response.status == 200


def make_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    mutation: Callable[[Path], None] | None = None,
) -> tuple[CortexBenchAgent, FinalizationEnvironment]:
    admit_every_capability(monkeypatch)
    for name, value in {
        CREDENTIAL_ENV: REAL_CREDENTIAL, FORBIDDEN_ENV_NAME: FORBIDDEN_ENV,
        FORBIDDEN_ARGV_NAME: FORBIDDEN_ARGV, HOST_CHECKOUT_NAME: HOST_CHECKOUT,
        HOST_IDENTITY_NAME: HOST_IDENTITY, "HOME": HOST_HOME,
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(finalization.socket, "gethostname", lambda: HOSTNAME)
    upstream = closed_upstream()
    logs_dir = tmp_path / "agent"
    (tmp_path / "verifier").mkdir()
    agent = CortexBenchAgent(
        logs_dir=logs_dir, artifact_dir=tmp_path / "artifacts",
        manifest=manifest_seed(tmp_path), trial_seed=trial_seed(upstream),
        trial_proxy=proxy_spec(), host_scan_policy=scan_policy(),
        admission_environment_digest=environment_digest({}),
    )
    environment = FinalizationEnvironment(logs_dir, mutation)
    asyncio.run(agent.setup(environment))
    write_json(tmp_path / "artifacts" / ADMISSION_EVIDENCE_FILENAME, {
        "schema_version": "cortex-harbor-launch-admission/1", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
    })
    post_lease(agent.proxy_session)
    return agent, environment


def run_agent(agent: CortexBenchAgent, environment: FinalizationEnvironment) -> None:
    asyncio.run(agent.run("Complete the task.", environment, AgentContext()))


def envelope_path(tmp_path: Path) -> Path:
    return tmp_path / "artifacts" / OUTER_ENVELOPE_FILENAME


def assert_refused(
    tmp_path: Path, agent: CortexBenchAgent, environment: FinalizationEnvironment,
    sensitive: str | None = None,
) -> None:
    with pytest.raises(HostFinalizationError) as raised:
        run_agent(agent, environment)
    assert not agent.grader_admitted
    assert not envelope_path(tmp_path).exists()
    if sensitive is not None:
        assert sensitive not in str(raised.value)


def assert_outer_evidence(envelope: Mapping[str, object]) -> None:
    assert envelope["schema_version"] == "cortex-bench-outer-envelope/1"
    assert envelope["identity"] == {
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID, "arm_name": ARM_NAME,
    }
    assert envelope["inner"]["composite_sha256"] and envelope["proxy_usage"]["reconciled"] is True
    assert envelope["revocation"] == {
        "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": TRIAL_ID,
        "route_active": False, "listener_present": False, "serving_thread_alive": False,
        "active_handlers": 0, "body_handlers": 0,
    }
    assert envelope["classification"]["ok"] is True
    assert envelope["publication"] == {
        "source": "outer_envelope", "root": "artifacts",
        "relative_path": OUTER_ENVELOPE_FILENAME, "classification": "required",
        "atomic": True, "post_publication_reread": True,
    }
    assert envelope["grader_admission"] == {"admitted": True}


def test_production_run_publishes_and_rereads_one_outer_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    assert type(agent) is CortexBenchAgent
    run_agent(agent, environment)
    payload = envelope_path(tmp_path).read_bytes()
    envelope = json.loads(payload)

    assert agent.grader_admitted and agent.outer_envelope_sha256 == hashlib.sha256(payload).hexdigest()
    assert_outer_evidence(envelope)
    scanned = {source["source"] for source in envelope["leak_scan"]["sources"]}
    assert {"harbor_launch_admission", "manifest", *PROXY_ARTIFACT_SOURCES,
            "workspace_diff"} <= scanned
    assert any(source.startswith("trial_state:") for source in scanned)
    assert any(file["classification"] == "optional-classified"
               for file in envelope["classification"]["files"])
    assert any("cortex-bench-workspace-evidence/1" in call for call in environment.calls)


def corrupt_self_consistent_journal(
    root: Path, composite: dict[str, object],
) -> None:
    journal = root / "events.jsonl"
    journal.write_bytes(b"not-json\n")
    digest = hashlib.sha256(journal.read_bytes()).hexdigest()
    terminal_path = root / f"run-{ROOT_RUN_ID}.terminal.json"
    terminal = json.loads(terminal_path.read_text())
    terminal["journal_sha256"] = digest
    write_json(terminal_path, terminal)
    composite["nodes"][0]["journal_sha256"] = digest
    composite["nodes"][0]["terminal_manifest_sha256"] = hashlib.sha256(
        terminal_path.read_bytes()).hexdigest()


def corrupt_composite(root: Path, kind: str) -> None:
    path = root / "composite-manifest.json"
    composite = json.loads(path.read_text())
    composite["predicate"] = production_predicate(all_pass=True)
    if kind == "malformed_node":
        del composite["nodes"][0]["task_id"]
    elif kind == "accounting_identity_mismatch":
        composite["accounting"]["trial_id"] = "foreign-trial"
    else:
        corrupt_self_consistent_journal(root, composite)
    write_json(path, composite)


def mutate_inner(kind: str) -> Callable[[Path], None]:
    def mutation(root: Path) -> None:
        terminal = root / f"run-{ROOT_RUN_ID}.terminal.json"
        if kind == "missing_required":
            terminal.unlink()
        elif kind == "digest_mismatch":
            (root / "events.jsonl").write_bytes(b"changed after terminal\n")
        elif kind in {"identity_mismatch", "non_quiescent"}:
            document = json.loads(terminal.read_text())
            key = "bundle_manifest_hash" if kind == "identity_mismatch" else "supervisor"
            document[key] = "4" * 64 if kind == "identity_mismatch" else {
                "quiescent": False, "descendants": 1,
            }
            write_json(terminal, document)
        elif kind == "wrong_composite_shape":
            write_json(root / "composite-manifest.json", {"schema_version": "wrong"})
        else:
            corrupt_composite(root, kind)
    return mutation


@pytest.mark.parametrize(
    "kind", ["missing_required", "digest_mismatch", "identity_mismatch", "non_quiescent",
             "wrong_composite_shape", "malformed_node", "accounting_identity_mismatch",
             "invalid_journal"],
)
def test_inner_truth_failure_never_admits_grading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch, mutate_inner(kind))
    assert_refused(tmp_path, agent, environment)


def install_accounting_leak(
    monkeypatch: pytest.MonkeyPatch, target: str, value: str,
) -> None:
    original = TrialProxySession.write_accounting

    def write(self: TrialProxySession) -> tuple[Path, Path]:
        paths = original(self)
        path = self.export_path if target == "proxy_export" else self.lease_echo_path
        document = json.loads(path.read_text())
        if target == "proxy_export":
            document["audit_log"]["value"]["diagnostic"] = value
        else:
            document["diagnostic"] = value
        write_json(path, document)
        return paths

    monkeypatch.setattr(TrialProxySession, "write_accounting", write)


def plant_pre_revoke_leak(tmp_path: Path, source: str, value: str) -> None:
    paths = {
        "manifest": tmp_path / "artifacts/cortex-bench-harness-manifest.json",
        "proxy_audit_log": tmp_path / "artifacts/proxy/proxy-audit.jsonl",
        "adapter_selection_record": tmp_path / "artifacts/proxy/adapter-selection.json",
    }
    with paths[source].open("a") as handle:
        planted = json.dumps({"diagnostic": value}) if source == "proxy_audit_log" else value
        handle.write(planted + "\n")


@pytest.mark.parametrize(
    ("source", "value"),
    [
        ("manifest", REAL_CREDENTIAL),
        ("proxy_audit_log", FORBIDDEN_ENV),
        ("proxy_export", FORBIDDEN_ARGV),
        ("lease_echo_record", f"{HOST_CHECKOUT}\n{HOST_HOME}"),
        ("adapter_selection_record", HOSTNAME),
        ("workspace_diff", HOST_IDENTITY),
    ],
)
def test_every_host_and_collected_surface_rejects_redacted_leaks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str, value: str,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    if source in {"proxy_export", "lease_echo_record"}:
        install_accounting_leak(monkeypatch, source, value)
    elif source == "workspace_diff":
        environment.workspace_payload = value
    else:
        plant_pre_revoke_leak(tmp_path, source, value)

    assert_refused(tmp_path, agent, environment, value)


def classification_mutation(kind: str, outside: Path) -> Callable[[Path], None]:
    def mutation(root: Path) -> None:
        if kind == "unknown":
            (root.parent / "unknown.bin").write_bytes(b"unknown")
        elif kind == "forbidden":
            (root.parent.parent / "artifacts/credentials.json").write_text("clean")
        elif kind == "symlink":
            (root / "unexpected-link").symlink_to(root / "events.jsonl")
        elif kind == "physical_escape":
            outside.mkdir()
            (outside / "escaped.txt").write_text("clean")
            (root / "escaped-directory").symlink_to(outside, target_is_directory=True)
        elif kind == "required_symlink":
            outside.mkdir()
            manifest = root / "composite-manifest.json"
            target = outside / manifest.name
            target.write_bytes(manifest.read_bytes())
            manifest.unlink()
            manifest.symlink_to(target)
    return mutation


@pytest.mark.parametrize("kind", ["unknown", "forbidden", "symlink", "physical_escape"])
def test_closed_world_classification_refuses_every_invalid_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str,
) -> None:
    agent, environment = make_agent(
        tmp_path, monkeypatch, classification_mutation(kind, tmp_path / "outside"),
    )
    assert_refused(tmp_path, agent, environment)


def force_legacy_pass_predicate(root: Path) -> None:
    path = root / "composite-manifest.json"
    document = json.loads(path.read_text())
    document["predicate"] = production_predicate(all_pass=True)
    write_json(path, document)


def test_verifier_root_output_cannot_escape_closed_world_classification(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch, force_legacy_pass_predicate)
    (tmp_path / "verifier/escaped-output.txt").write_text("unclassified")

    assert_refused(tmp_path, agent, environment)


@pytest.mark.parametrize("stage", ["inner_run", "workspace_collection"])
def test_pre_envelope_stage_failure_is_not_a_gradeable_agent_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    if stage == "inner_run":
        environment.run_return_code = 17
    else:
        environment.workspace_return_code = 17

    with pytest.raises(HostFinalizationError):
        run_agent(agent, environment)
    assert not agent.grader_admitted and not envelope_path(tmp_path).exists()
    assert agent.proxy_session.handle.revocation_evidence["listener_present"] is False


@pytest.mark.parametrize("source", ["manifest", "admission", "adapter_selection"])
def test_host_owned_identity_mismatch_refuses_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    paths = {
        "manifest": tmp_path / "artifacts/cortex-bench-harness-manifest.json",
        "admission": tmp_path / "artifacts" / ADMISSION_EVIDENCE_FILENAME,
        "adapter_selection": tmp_path / "artifacts/proxy/adapter-selection.json",
    }
    path = paths[source]
    document = json.loads(path.read_text())
    document["trial_id"] = "foreign-trial"
    write_json(path, document)

    assert_refused(tmp_path, agent, environment)


def test_physical_inventory_rejects_a_required_symlink_before_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    mutation = classification_mutation("required_symlink", tmp_path / "outside-required")
    agent, environment = make_agent(tmp_path, monkeypatch, mutation)
    original = Path.read_bytes
    followed = False

    def observe(path: Path) -> bytes:
        nonlocal followed
        followed = followed or path.is_symlink()
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", observe)
    assert_refused(tmp_path, agent, environment)
    assert not followed


def test_proxy_reconciliation_uncertainty_refuses_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    original = TrialProxySession.write_accounting

    def disagree(self: TrialProxySession) -> tuple[Path, Path]:
        paths = original(self)
        document = json.loads(self.export_path.read_text())
        document["audit_log"]["value"]["agrees_with_counters"] = False
        write_json(self.export_path, document)
        return paths

    monkeypatch.setattr(TrialProxySession, "write_accounting", disagree)
    assert_refused(tmp_path, agent, environment)


def test_revocation_uncertainty_refuses_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    handle_type = type(agent.proxy_session.handle)
    original = handle_type.stop

    def uncertain(self: object) -> None:
        original(self)
        raise RuntimeError("revocation proof unavailable")

    monkeypatch.setattr(handle_type, "stop", uncertain)
    assert_refused(tmp_path, agent, environment)


def fail_once() -> Callable[..., None]:
    failed = False

    def failure(*_args: object, **_kwargs: object) -> None:
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("injected publication failure")

    return failure


@pytest.mark.parametrize(
    "operation", ["_write_all", "_flush_descriptor", "_close_descriptor", "_link_publication"],
)
def test_outer_publication_io_failure_leaves_no_admissible_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    monkeypatch.setattr(finalization, operation, fail_once())

    assert_refused(tmp_path, agent, environment)
    assert not tuple((tmp_path / "artifacts").glob(f"{OUTER_ENVELOPE_FILENAME}.tmp.*"))


def test_failed_post_publication_reread_never_admits_grading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    monkeypatch.setattr(finalization, "_reread_publication", lambda _path: b"different")

    with pytest.raises(HostFinalizationError):
        run_agent(agent, environment)
    assert not agent.grader_admitted


def test_preexisting_partial_outer_envelope_is_not_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    output = envelope_path(tmp_path)
    output.write_bytes(b"partial")

    with pytest.raises(HostFinalizationError):
        run_agent(agent, environment)
    assert output.read_bytes() == b"partial"
    assert not agent.grader_admitted


def test_root_walk_failure_never_admits_grading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    monkeypatch.setattr(finalization.os, "scandir", lambda _path: (_ for _ in ()).throw(
        OSError("injected root walk failure")))

    assert_refused(tmp_path, agent, environment)


def test_source_open_failure_never_admits_grading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    original = Path.open

    def fail_open(path: Path, mode: str = "r", *args: object, **kwargs: object):
        if path.name == "stdout.txt" and "r" in mode:
            raise OSError("injected open failure")
        return original(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", fail_open)
    assert_refused(tmp_path, agent, environment)


class ReadFailure:
    def __init__(self, handle: object) -> None:
        self.handle = handle

    def __enter__(self):
        return self

    def __exit__(self, *_args: object) -> None:
        self.handle.close()

    def read(self, *_args: object) -> bytes:
        raise OSError("injected read failure")


def test_source_read_failure_never_admits_grading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    original = Path.open

    def fail_read(path: Path, mode: str = "r", *args: object, **kwargs: object):
        handle = original(path, mode, *args, **kwargs)
        if path.name != "stdout.txt" or "r" not in mode:
            return handle
        return ReadFailure(handle)

    monkeypatch.setattr(Path, "open", fail_read)
    assert_refused(tmp_path, agent, environment)


def test_hash_failure_never_admits_grading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    monkeypatch.setattr(finalization, "_sha256_file", lambda _path: (_ for _ in ()).throw(
        OSError("injected hash failure")))

    assert_refused(tmp_path, agent, environment)
