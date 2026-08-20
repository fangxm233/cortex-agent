# input:  host finalizer fixtures, roots, proxy revocation
# output: Cortex/vendor envelope and fail-closed assertions
# pos:    Host finalization recording tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import gzip
import hashlib
import io
import json
import socket
import tarfile
from collections.abc import Callable, Mapping
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

import cortex_bench_harness.host_finalization as finalization
from cortex_bench_harness.container_boundary import ContainerBoundaryObservation
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.host_finalization import (
    OUTER_ENVELOPE_FILENAME,
    OUTER_ENVELOPE_SCHEMA_VERSION,
    HostFinalizationError,
    finalize_host_trial,
)
from cortex_bench_harness.launcher.production_arms import (
    PRODUCTION_ARM_BUNDLES,
    ProductionArmBundle,
    production_arm_bundle,
)
from cortex_bench_harness.launcher.production_home import (
    ProductionArmLaunchFacts,
    committed_input_bundle_files,
    materialize_production_home,
)
from cortex_bench_harness.launcher.production_session import ProductionServerSession
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    ADMISSION_SCHEMA_VERSION,
    environment_digest,
)
from cortex_bench_harness.launcher.trial_proxy import (
    ADAPTER_SELECTION_FILENAME,
    ADAPTER_SELECTION_SCHEMA_VERSION,
    AUDIT_LOG_FILENAME,
    EXPORT_FILENAME,
    LEASE_ECHO_FILENAME,
    LEASE_ECHO_RECORD_SCHEMA_VERSION,
    TrialProxySession,
    TrialRevocation,
)
from cortex_bench_harness.manifest import MANIFEST_FILENAME, SCHEMA_VERSION
from cortex_bench_harness.outcome import TrialOutcomeReader
from cortex_bench_harness.proxy.lease import LEASE_ECHO_SCHEMA_VERSION, LEASE_ECHO_TARGET
from cortex_bench_harness.scan import ScanPolicy
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
HOST_HOME = "/private/host-home/operator"
HOSTNAME = "private-hostname-unique"
HOST_IDENTITY = "machine-identity-unique"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
DIRECT_CLAUDE_SYSTEM_PROMPT = "defaults/prompts/systemPrompts/benchmark-direct.md"
DIRECT_CLAUDE_DIRECTIVE = "defaults/prompts/directives/benchmark-direct.md"
COMMON_PLUGIN, CODER_PLUGIN = (
    "defaults/plugins/cortex-common", "defaults/plugins/cortex-coder",
)
SEALED_ENVIRONMENT_KEYS = (
    "CORTEX_BENCH_BACKEND", "CORTEX_BENCH_TRIAL_ID", "CORTEX_HOME", "HOME", "PATH",
)
UNAVAILABLE = "unavailable"
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
        "kind": "cortex", "name": ARM_NAME, "backend": "pi",
        "provider": "deepseek", "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_provider_requests": 8, "max_cost_usd": "2.50",
            "deadline_seconds": 120, "max_output_tokens": 65536,
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
            "upstream_base_url": upstream, "route_identity_host": "api.deepseek.com",
            "proxy_base_url": "http://proxy.invalid", "dummy_token_ref": "dummy-ref",
        },
        "model_alias_policy": {"kind": "exact"},
    }


def bundle_members() -> dict[str, bytes]:
    """A bundle shaped like the shipped one: the composition's prompts and plugin trees, plus the
    product code that dwarfs them and that no trial has any reason to carry a copy of.
    """
    return {
        DIRECT_CLAUDE_SYSTEM_PROMPT: b"# benchmark direct system prompt\nfixture body\n",
        DIRECT_CLAUDE_DIRECTIVE: b"# benchmark direct directive\nfixture body\n",
        f"{COMMON_PLUGIN}/.claude-plugin/plugin.json": b'{"name":"cortex-common"}\n',
        f"{COMMON_PLUGIN}/skills/compound/SKILL.md": b"# compound\nfixture skill\n",
        f"{CODER_PLUGIN}/.claude-plugin/plugin.json": b'{"name":"cortex-coder"}\n',
        f"{CODER_PLUGIN}/skills/develop/SKILL.md": b"# develop\nfixture skill\n",
        "dist/index.js": b"// product code the model never reads\n" * 64,
        "node_modules/left-pad/index.js": b"// a dependency, likewise\n" * 64,
    }


def write_npm_artifact(path: Path, members: Mapping[str, bytes] | None = None) -> None:
    with tarfile.open(path, "w:gz") as tar:
        for relative, payload in sorted((members or bundle_members()).items()):
            info = tarfile.TarInfo(f"package/{relative}")
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))


def write_deterministic_npm_artifact(
    path: Path, members: Mapping[str, bytes] | None = None,
) -> None:
    with path.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w") as tar:
            for relative, payload in sorted((members or bundle_members()).items()):
                info = tarfile.TarInfo(f"package/{relative}")
                info.size = len(payload)
                tar.addfile(info, io.BytesIO(payload))


def sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_sha256(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def manifest_seed(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl", "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"finalization fixture")
    write_npm_artifact(files["npm_artifact_path"])
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
        "advertised_host": f"{TRIAL_ID}.proxy.invalid",
        "request_body_limit_bytes": 16 * 1024 * 1024,
        "response_body_limit_bytes": 16 * 1024 * 1024,
    }


def scan_policy_document() -> dict[str, object]:
    return {
        "secret_environment": {"provider_credential": CREDENTIAL_ENV},
        "forbidden_environment": {"ambient_forbidden": FORBIDDEN_ENV_NAME},
        "forbidden_argv_environment": {"host_argv": FORBIDDEN_ARGV_NAME},
        "repository_checkout_environment": HOST_CHECKOUT_NAME,
        "host_identity_environment": {"machine": HOST_IDENTITY_NAME},
    }


def launch_attestation(npm_artifact: Path) -> dict[str, object]:
    inputs = {
        "npm_artifact_sha256": sha256_hex(npm_artifact.read_bytes()),
        "backend_cli": {"name": "claude", "version": "1.2.3"},
        "pre_boot_input_bundle_sha256": "4" * 64,
    }
    return {
        "schema_version": "cortex-bench-launch-attestation/4", "trial_id": TRIAL_ID,
        "capture_boundary": "launcher_pre_boot",
        "arm_bundle": production_arm_bundle("direct-pi-deepseek").attested_record(),
        "arm_confinement": production_arm_bundle(
            "direct-pi-deepseek").confinement_record(),
        **inputs,
        "input_bundle_file_count": 7, "cortex_home_tree_sha256": "5" * 64,
        "cortex_home_file_count": 9, "bundle_manifest_hash": canonical_sha256(inputs),
    }


def admission_evidence() -> dict[str, object]:
    return {
        "schema_version": ADMISSION_SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
        "image": {"reference": f"task@{DIGEST}", "pinned": True},
        "environment": {
            "admitted_keys": list(SEALED_ENVIRONMENT_KEYS),
            "configured_keys": list(SEALED_ENVIRONMENT_KEYS),
            "inheritance": "none",
        },
        "mounts": [], "network": {"default": "deny", "loopback": "allow"},
    }


def container_boundary_observation(
    *, descendants_alive: int = 0, namespace_alive: bool = False, exit_code: int = 0,
) -> ContainerBoundaryObservation:
    return ContainerBoundaryObservation(
        observed_at="2026-08-11T00:00:02.000Z", exit_code=exit_code,
        descendants_alive=descendants_alive, process_namespace_alive=namespace_alive,
    )


def journal_bytes() -> bytes:
    header = {
        "schema_version": "cortex-bench-journal/1", "type": "run_header",
        "root_run_id": ROOT_RUN_ID, "thread_id": "thr-production-root", "agent_slot": "parent",
        "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH, "bundle_manifest_hash": BUNDLE_HASH,
    }
    event = {"schema_version": "cortex-bench-journal/1", "type": "event"}
    return (json.dumps(header, sort_keys=True) + "\n" + json.dumps(event) + "\n").encode()


def terminal_document(journal: bytes) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-manifest/2", "state": "completed",
        "started_at": "2026-08-11T00:00:00.000Z",
        "ended_at": "2026-08-11T00:00:01.000Z", "journal_path": "events.jsonl",
        "journal_sha256": sha256_hex(journal), "event_count": 1,
        "steps": 1, "cost_usd": None,
        "tokens": {"input": None, "output": None, "cache_read": None,
                   "cache_creation": None},
        "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH, "bundle_manifest_hash": BUNDLE_HASH,
        "terminal_reason": "ok",
    }


def accounting() -> dict[str, object]:
    unavailable = {"status": UNAVAILABLE, "reason": "counter_unreadable"}
    return {
        "schema_version": "cortex-bench-accounting/2", "trial_id": TRIAL_ID,
        "proxy": {"requests": unavailable, "cached_tokens": unavailable,
                  "input_tokens": unavailable, "output_tokens": unavailable,
                  "audit_log": unavailable, "lease_echo": unavailable,
                  "source": "proxy_export"},
        "journal": {"requests": {"status": UNAVAILABLE, "reason": "journal_underivable"},
                    "cost_usd": {"status": "available", "value": "0"},
                    "steps": {"status": "available", "value": 1},
                    "tokens": {"input": {"status": "available", "value": 0},
                               "output": {"status": "available", "value": 0},
                               "cached": {"status": "available", "value": 0}},
                    "source": "trajectory_merge"},
        "unaccounted_roles": [],
    }


def production_predicate() -> dict[str, object]:
    return {"mode": "direct", "checks": [
        {"check_id": check_id, "result": "pass" if check_id == "D2" else "unavailable",
         "detail": None if check_id == "D2" else "not evaluated at this pin"}
        for check_id in DIRECT_CHECK_IDS
    ]}


def attempt_node(terminal_sha256: str, journal: bytes | None = None) -> dict[str, object]:
    terminal = terminal_document(journal if journal is not None else journal_bytes())
    return {
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID, "task_id": TRIAL_ID,
        "parent_task_id": None, "dispatch_generation": None,
        "attempt_id": "thread-thr-production-root", "attempt_ordinal": 1,
        "thread_id": "thr-production-root", "parent_thread_id": None,
        "root_thread_id": "thr-production-root", "task_ancestry": [TRIAL_ID],
        "template": "benchmark-direct", "role": "parent", "stage": None,
        "backend": "claude", "provider": "anthropic", "requested_model": "claude-sonnet",
        "reported_model": None, "model_execution_identity_hash": MODEL_HASH,
        "role_tool_surface_hash": ROLE_HASH, "bundle_manifest_hash": BUNDLE_HASH,
        "terminal_state": "completed", "terminal_reason": "ok", "disposition": "none",
        "superseded_by": None, "artifact_path": None, "artifact_sha256": None,
        "journal_path": "events.jsonl", "journal_sha256": terminal["journal_sha256"],
        "event_count": 1, "terminal_manifest_path": f"run-{ROOT_RUN_ID}.terminal.json",
        "terminal_manifest_sha256": terminal_sha256, "edges": [],
        "started_at": terminal["started_at"], "ended_at": terminal["ended_at"],
        "steps": 1, "cost_usd": None,
        "tokens": {"input": None, "output": None, "cache_read": None, "cache_creation": None},
        "provider_requests": None,
    }


def composite_document(
    terminal_sha256: str, journal: bytes | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-composite-manifest/2", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID, "arm_name": ARM_NAME,
        "arm_canonical_sha256": canonical_sha256(arm()),
        "identity": {"model_execution_identity_hash": {"parent": MODEL_HASH},
                     "role_tool_surface_hash": {"parent": ROLE_HASH},
                     "bundle_manifest_hash": BUNDLE_HASH},
        "nodes": [attempt_node(terminal_sha256, journal)], "edges": [],
        "roots": {"root_attempt_id": "thread-thr-production-root", "root_task_id": None},
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
    terminal_sha = sha256_hex(terminal_path.read_bytes())
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
        self.publish_terminal_on_failure = False
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
        if "command -v pi" in command:
            return ExecResult(stdout="/usr/local/bin/pi\n", return_code=0)
        if command.endswith("pi --version"):
            return ExecResult(stdout="0.82.1\n", return_code=0)
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
    host, port = session.handle._server.server_address
    connection = HTTPConnection(host, port, timeout=5)
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
    manifest = manifest_seed(tmp_path)
    agent = CortexBenchAgent(
        logs_dir=logs_dir, artifact_dir=tmp_path / "artifacts",
        manifest=manifest, trial_seed=trial_seed(upstream),
        trial_proxy=proxy_spec(), host_scan_policy=scan_policy_document(),
        admission_environment_digest=environment_digest({}),
    )
    environment = FinalizationEnvironment(logs_dir, mutation)

    async def run_production(_self: object, _instruction: str, _execute: object) -> None:
        if environment.run_return_code != 0 and not environment.publish_terminal_on_failure:
            raise RuntimeError("production run failed")
        write_inner_outputs(logs_dir, mutation)
        _self._stopped_cleanly = True

    monkeypatch.setattr(ProductionServerSession, "run", run_production)
    agent._require_production_proxy_traffic = lambda: None
    asyncio.run(agent.setup(environment))
    write_json(tmp_path / "artifacts" / ADMISSION_EVIDENCE_FILENAME, admission_evidence())
    post_lease(agent.proxy_session)
    return agent, environment


def run_agent_phase(agent: CortexBenchAgent, environment: FinalizationEnvironment) -> None:
    asyncio.run(agent.run("Complete the task.", environment, AgentContext()))


def run_agent(
    agent: CortexBenchAgent, environment: FinalizationEnvironment,
    observation: ContainerBoundaryObservation | None = ...,
) -> None:
    run_agent_phase(agent, environment)
    agent.finalize_after_container_stop(
        container_boundary_observation() if observation is ... else observation,
    )


def envelope_path(tmp_path: Path) -> Path:
    return tmp_path / "artifacts" / OUTER_ENVELOPE_FILENAME


def published(tmp_path: Path) -> Mapping[str, object]:
    return json.loads(envelope_path(tmp_path).read_bytes())


def recorded_files(envelope: Mapping[str, object]) -> dict[tuple[str, str], Mapping[str, object]]:
    return {
        (str(entry["root"]), str(entry["relative_path"])): entry
        for entry in envelope["evidence"]["files"]
    }


def unavailable(reason: str) -> dict[str, str]:
    return {"status": UNAVAILABLE, "reason": reason}


def test_a_run_records_every_collected_file_and_publishes_one_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    run_agent_phase(agent, environment)
    assert not envelope_path(tmp_path).exists()
    agent.finalize_after_container_stop(container_boundary_observation())

    payload = envelope_path(tmp_path).read_bytes()
    envelope = json.loads(payload)
    assert envelope["schema_version"] == OUTER_ENVELOPE_SCHEMA_VERSION
    assert envelope["identity"] == {
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID, "arm_name": ARM_NAME,
    }
    assert agent.grader_admitted
    assert agent.outer_envelope_sha256 == hashlib.sha256(payload).hexdigest()
    # What the campaign driver reads back out of a published envelope.
    assert envelope["grader_admission"] == {"admitted": True, "reason": "recorded"}
    assert isinstance(envelope["proxy_usage"]["requests"], int)
    assert envelope["publication"] == {
        "root": "artifacts", "relative_path": OUTER_ENVELOPE_FILENAME,
        "atomic": True, "post_publication_reread": True,
    }
    files = recorded_files(envelope)
    expected = {
        ("agent", "instruction.md"), ("agent", "workspace.diff"),
        ("agent", "trajectory/events.jsonl"), ("agent", "trajectory/composite-manifest.json"),
        ("agent", "production-cortex-home/config/profiles.json"),
        ("artifacts", MANIFEST_FILENAME), ("artifacts", ADMISSION_EVIDENCE_FILENAME),
        ("artifacts", f"proxy/{EXPORT_FILENAME}"),
    }
    assert expected <= set(files)
    entry = files[("agent", "trajectory/events.jsonl")]
    assert entry["kind"] == "file"
    assert entry["size_bytes"] == len(journal_bytes())
    assert entry["sha256"] == sha256_hex(journal_bytes())
    assert {root["root"] for root in envelope["evidence"]["roots"]} == {
        "agent", "verifier", "artifacts",
    }


def test_container_home_env_launcher_is_collected_and_scans_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    launcher = tmp_path / "agent/trial-home/home/.local/bin/env"
    launcher.parent.mkdir(parents=True)
    launcher.write_text('export PATH="/logs/agent/trial-home/home/.local/bin:$PATH"\n')

    run_agent(agent, environment)

    envelope = published(tmp_path)
    assert envelope["leak_scan"]["clean"] is True
    assert ("agent", "trial-home/home/.local/bin/env") in recorded_files(envelope)


def test_launch_parameters_are_recorded_as_the_launcher_emitted_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    run_agent(agent, environment)

    launch = published(tmp_path)["launch"]
    attestation = json.loads(
        (tmp_path / "artifacts/cortex-bench-launch-attestation.json").read_text())
    artifact = tmp_path / "server.tgz"
    assert launch["npm_artifact"] == {
        "filename": "server.tgz", "sha256": sha256_hex(artifact.read_bytes()),
    }
    assert launch["config_bundle"]["canonical_sha256"] == attestation[
        "pre_boot_input_bundle_sha256"]
    assert launch["config_bundle"]["file_count"] == attestation["input_bundle_file_count"]
    assert launch["confinement"] == {
        "injection": "thread-root",
        "webhook_endpoints": ["POST /webhook/thread-op"],
        "writable_home_paths": [],
    }
    assert launch["sealed_environment_allowlist"] == list(SEALED_ENVIRONMENT_KEYS)
    assert launch["image"] == {
        "reference": f"task@{DIGEST}", "digest": DIGEST, "pinned": True,
    }
    assert launch["container_exit"] == {
        "status": "exited", "exit_code": 0, "running": False, "pid": 0,
    }
    assert launch["post_stop_census"] == {
        "descendants_alive": 0, "process_namespace_alive": False,
    }


def test_the_npm_digest_is_recorded_from_the_launcher_not_rediscovered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    attestation = json.loads(
        (tmp_path / "artifacts/cortex-bench-launch-attestation.json").read_text())
    (tmp_path / "server.tgz").write_bytes(b"changed after launcher capture")
    run_agent(agent, environment)

    assert published(tmp_path)["launch"]["npm_artifact"] == {
        "filename": "server.tgz", "sha256": attestation["npm_artifact_sha256"],
    }


def test_a_parameter_the_launcher_never_emitted_is_marked_unavailable_not_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    (tmp_path / "artifacts" / "cortex-bench-launch-attestation.json").unlink()
    (tmp_path / "artifacts" / ADMISSION_EVIDENCE_FILENAME).unlink()
    run_agent(agent, environment)

    launch = published(tmp_path)["launch"]
    assert launch["npm_artifact"]["sha256"] == unavailable("launch_attestation_absent")
    assert launch["config_bundle"]["canonical_sha256"] == unavailable("launch_attestation_absent")
    assert launch["config_bundle"]["files"] == unavailable("launch_attestation_absent")
    assert launch["confinement"] == unavailable("launch_attestation_absent")
    assert launch["sealed_environment_allowlist"] == unavailable("admission_evidence_absent")
    assert launch["image"]["reference"] == unavailable("admission_evidence_absent")
    assert launch["image"]["digest"] == DIGEST


def corrupt_inner(kind: str) -> Callable[[Path], None]:
    def mutation(root: Path) -> None:
        if kind == "terminal_malformed":
            (root / f"run-{ROOT_RUN_ID}.terminal.json").write_text("{not json")
        elif kind == "composite_missing":
            (root / "composite-manifest.json").unlink()
        elif kind == "journal_digest_drift":
            (root / "events.jsonl").write_bytes(b'{"type":"other"}\n')
        elif kind == "unknown_output":
            (root.parent / "unknown.bin").write_bytes(b"unknown")
        elif kind == "forbidden_lookalike":
            (root.parent / "credentials.json").write_text("clean fixture body\n")
        elif kind == "started_marker_missing":
            (root / f"run-{ROOT_RUN_ID}.started.json").unlink()
    return mutation


@pytest.mark.parametrize("kind", [
    "terminal_malformed", "composite_missing", "journal_digest_drift",
    "unknown_output", "forbidden_lookalike", "started_marker_missing",
])
def test_inner_evidence_that_used_to_be_refused_is_now_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str,
) -> None:
    """Every one of these ended the trial before an envelope existed. The evidence tree is now a
    record: what the container emitted is what is written down, and provenance comes from the
    record plus the pinned code rather than from a per-trial gate.
    """
    agent, environment = make_agent(tmp_path, monkeypatch, corrupt_inner(kind))
    run_agent(agent, environment)

    files = recorded_files(published(tmp_path))
    if kind == "unknown_output":
        assert ("agent", "unknown.bin") in files
    if kind == "forbidden_lookalike":
        assert ("agent", "credentials.json") in files
    if kind == "composite_missing":
        assert ("agent", "trajectory/composite-manifest.json") not in files


def test_host_owned_identity_that_disagrees_is_recorded_not_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    path = tmp_path / "artifacts" / MANIFEST_FILENAME
    document = json.loads(path.read_text())
    document["trial_id"] = "foreign-trial"
    write_json(path, document)
    run_agent(agent, environment)

    assert published(tmp_path)["identity"]["trial_id"] == TRIAL_ID


def test_an_output_under_the_verifier_root_is_collected_like_any_other(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    (tmp_path / "verifier/notes.txt").write_text("clean verifier note\n")
    run_agent(agent, environment)

    assert ("verifier", "notes.txt") in recorded_files(published(tmp_path))


def test_the_verifier_reward_is_recorded_when_it_is_on_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    write_json(tmp_path / "verifier/reward.json", {"reward": 1.0})
    run_agent(agent, environment)

    verifier = published(tmp_path)["verifier"]
    assert verifier["reward"] == {"reward": 1.0}
    assert verifier["evidence_paths"] == ["verifier/reward.json", "verifier/reward.txt"]


def test_the_verifier_evidence_path_is_recorded_when_the_reward_is_not_yet_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    run_agent(agent, environment)

    verifier = published(tmp_path)["verifier"]
    assert verifier["reward"] == unavailable("verifier_reward_absent")
    assert verifier["evidence_paths"] == ["verifier/reward.json", "verifier/reward.txt"]


def test_the_text_verifier_reward_is_recorded_when_json_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    (tmp_path / "verifier/reward.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "verifier/reward.txt").write_text("0.75\n", encoding="utf-8")
    run_agent(agent, environment)

    assert published(tmp_path)["verifier"]["reward"] == "0.75"


def asset_paths(envelope: Mapping[str, object]) -> set[str]:
    return {
        relative for root, relative in recorded_files(envelope)
        if root == "agent" and relative.startswith("assets/")
    }


def test_the_model_visible_assets_are_copied_and_inventoried_without_a_witness(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The lift stays: a trial answers "what did the model see" out of its own directory. What is
    gone is holding it against the run journal's own digests, which was the host reimplementing the
    container's hashing to check the container against itself.
    """
    agent, environment = make_agent(tmp_path, monkeypatch)
    run_agent(agent, environment)
    envelope = published(tmp_path)

    lifted = asset_paths(envelope)
    assert f"assets/bundle/{DIRECT_CLAUDE_SYSTEM_PROMPT}" in lifted
    assert f"assets/bundle/{DIRECT_CLAUDE_DIRECTIVE}" in lifted
    assert not any(path.endswith("node_modules/left-pad/index.js") for path in lifted)
    assert envelope["assets"]["manifest_path"] == "agent/assets/manifest.json"
    assert envelope["assets"]["file_count"] == len(lifted) - 1
    manifest = json.loads((tmp_path / "agent/assets/manifest.json").read_text())
    assert "witnesses" not in manifest and "witnessed_slot" not in manifest


def test_the_proxy_revocation_and_audit_records_land_in_the_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    run_agent(agent, environment)
    envelope = published(tmp_path)

    assert envelope["revocation"] == {
        "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": TRIAL_ID,
        "route_active": False, "listener_present": False, "serving_thread_alive": False,
        "active_handlers": 0, "body_handlers": 0,
    }
    usage = envelope["proxy_usage"]
    assert usage["trial_id"] == TRIAL_ID
    assert usage["requests"] == 0
    assert usage["audit_entries"] == 1
    assert usage["audit_outcomes"] == {}
    assert usage["lease_echo"] == {
        "status": UNAVAILABLE, "reason": "unavailable_by_design",
    }
    assert agent.proxy_session.handle.revocation_evidence["listener_present"] is False


def test_an_unaccountable_proxy_export_is_recorded_and_still_published(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    original = TrialProxySession.write_accounting

    def write(self: TrialProxySession) -> tuple[Path, Path]:
        paths = original(self)
        document = json.loads(self.export_path.read_text())
        document["requests"] = {"status": UNAVAILABLE, "reason": "counter_unreadable"}
        write_json(self.export_path, document)
        return paths

    monkeypatch.setattr(TrialProxySession, "write_accounting", write)
    run_agent(agent, environment)

    assert published(tmp_path)["proxy_usage"]["requests"] == {
        "status": UNAVAILABLE, "reason": "counter_unreadable",
    }


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
        "manifest": tmp_path / "artifacts" / MANIFEST_FILENAME,
        "proxy_audit_log": tmp_path / "artifacts/proxy" / AUDIT_LOG_FILENAME,
        "adapter_selection_record": tmp_path / "artifacts/proxy" / ADAPTER_SELECTION_FILENAME,
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
        ("trajectory", HOST_IDENTITY),
    ],
)
def test_a_leak_on_any_collected_surface_still_refuses_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str, value: str,
) -> None:
    """The one refusal that survives. Everything else about the trial is a record; a credential or
    a host identity reaching a collected artifact is real damage, so it is still a gate.
    """
    mutation = None
    if source == "trajectory":
        def mutation(root: Path) -> None:
            (root / "leaked.txt").write_text(f"{value}\n")
    agent, environment = make_agent(tmp_path, monkeypatch, mutation)
    if source in {"proxy_export", "lease_echo_record"}:
        install_accounting_leak(monkeypatch, source, value)
    elif source == "workspace_diff":
        environment.workspace_payload = value
    elif source != "trajectory":
        plant_pre_revoke_leak(tmp_path, source, value)

    with pytest.raises(HostFinalizationError) as raised:
        run_agent(agent, environment)

    assert raised.value.reason == "output_leak_detected"
    assert value not in str(raised.value)
    assert not envelope_path(tmp_path).exists()


def test_a_sensitive_relative_path_still_refuses_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def mutation(root: Path) -> None:
        (root / HOST_IDENTITY).write_text("clean body\n", encoding="utf-8")

    agent, environment = make_agent(tmp_path, monkeypatch, mutation)

    with pytest.raises(HostFinalizationError) as raised:
        run_agent(agent, environment)

    assert raised.value.reason == "output_leak_detected"
    assert not envelope_path(tmp_path).exists()


@pytest.mark.parametrize("observation", [
    None,
    container_boundary_observation(descendants_alive=3),
    container_boundary_observation(namespace_alive=True, exit_code=137),
])
def test_a_container_boundary_that_is_not_quiescent_is_recorded_and_still_published(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    observation: ContainerBoundaryObservation | None,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    run_agent(agent, environment, observation)

    launch = published(tmp_path)["launch"]
    if observation is None:
        assert launch["post_stop_census"] == unavailable(
            "container_boundary_attestation_absent")
        return
    assert launch["post_stop_census"] == {
        "descendants_alive": observation.descendants_alive,
        "process_namespace_alive": observation.process_namespace_alive,
    }
    assert launch["container_exit"]["exit_code"] == observation.exit_code


def test_the_envelope_is_published_atomically_exactly_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    run_agent(agent, environment)
    payload = envelope_path(tmp_path).read_bytes()
    boundary = tmp_path / "artifacts" / finalization.CONTAINER_BOUNDARY_ATTESTATION_FILENAME
    boundary_payload = boundary.read_bytes()

    agent.finalize_after_container_stop(container_boundary_observation())

    assert envelope_path(tmp_path).read_bytes() == payload
    assert boundary.read_bytes() == boundary_payload
    assert not list((tmp_path / "artifacts").glob(f"{OUTER_ENVELOPE_FILENAME}.tmp*"))


def test_a_preexisting_envelope_is_never_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    (tmp_path / "artifacts").mkdir(parents=True, exist_ok=True)
    envelope_path(tmp_path).write_text("partial\n")

    with pytest.raises(HostFinalizationError) as raised:
        run_agent(agent, environment)

    assert raised.value.reason == "outer_publication_exists"
    assert envelope_path(tmp_path).read_text() == "partial\n"


@pytest.mark.parametrize(
    "target", ["_write_all", "_flush_descriptor", "_link_publication", "_sync_directory"],
)
def test_a_publication_io_failure_leaves_no_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)

    def fail(*_args: object, **_kwargs: object) -> None:
        raise OSError("publication failure")

    monkeypatch.setattr(finalization, target, fail)

    with pytest.raises(HostFinalizationError) as raised:
        run_agent(agent, environment)

    assert raised.value.reason == "outer_publication_failed"
    assert not envelope_path(tmp_path).exists()
    assert not list((tmp_path / "artifacts").glob(f"{OUTER_ENVELOPE_FILENAME}.tmp*"))


def test_a_failed_post_publication_reread_never_leaves_an_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    monkeypatch.setattr(finalization, "_reread_publication", lambda _path: b"different\n")

    with pytest.raises(HostFinalizationError) as raised:
        run_agent(agent, environment)

    assert raised.value.reason == "outer_reread_failed"
    assert not envelope_path(tmp_path).exists()


def test_an_unavailable_evidence_root_is_recorded_without_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    (tmp_path / "verifier").rmdir()
    run_agent(agent, environment)

    roots = {entry["root"]: entry["status"] for entry in published(tmp_path)["evidence"]["roots"]}
    assert roots == {"agent": "collected", "verifier": "unavailable", "artifacts": "collected"}


@pytest.mark.parametrize("stage", ["inner_run", "workspace_collection"])
def test_a_stage_failure_before_collection_publishes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str,
) -> None:
    agent, environment = make_agent(tmp_path, monkeypatch)
    if stage == "inner_run":
        environment.run_return_code = 17
    else:
        environment.workspace_return_code = 17

    with pytest.raises(HostFinalizationError):
        run_agent(agent, environment)

    assert not envelope_path(tmp_path).exists()
    assert agent.proxy_session.handle.revocation_evidence["listener_present"] is False


def production_scan_policy() -> ScanPolicy:
    return ScanPolicy(
        secrets={"provider_credential": "sk-live-production-finalization-secret"},
        repository_checkout="/private/host-checkout/cortex", hostname="private-hostname",
        forbidden_environment={"ambient": "forbidden-environment-value"},
        forbidden_argv={"argv": "forbidden-argv-value"},
        home_path="/private/host-home",
        host_identities={"machine": "private-machine-identity"},
    )


def production_proxy_outputs(artifact_dir: Path) -> TrialRevocation:
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
    return TrialRevocation(None, export_path, lease_path, {
        "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": TRIAL_ID,
        "route_active": False, "listener_present": False,
        "serving_thread_alive": False, "active_handlers": 0, "body_handlers": 0,
    })


def production_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": ARM_NAME, "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_provider_requests": 8, "max_cost_usd": "2.50",
            "deadline_seconds": 90, "max_output_tokens": 65536,
        },
    }


def vendor_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "vendor-baseline",
        "name": "pi-vendor", "vendor_agent": "pi", "vendor_cli_version": "0.82.1",
        "provider": "deepseek", "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "limits": {
            "max_provider_requests": 8, "max_cost_usd": "2.50",
            "deadline_seconds": 90, "max_output_tokens": 65536,
        },
    }


def production_arm_for(bundle: ProductionArmBundle) -> dict[str, object]:
    arm = production_arm()
    arm["orchestration"] = dict(bundle.orchestration)
    return arm


def agent_prompt_members(bundle: ProductionArmBundle) -> dict[str, bytes]:
    """The prompts the arm's own agents name, as the pinned npm bundle ships them."""
    return {
        f"defaults/prompts/{kind}/{role}.md": (
            bundle.bundle_dir / f"prompts/{kind}/{role}.md"
        ).read_bytes()
        for role in bundle.expected_roles
        for kind in ("directives", "systemPrompts")
    }


def finalize_production_trial(
    tmp_path: Path, bundle: ProductionArmBundle,
    *, npm_prompt_members: dict[str, bytes] | None = None,
    runtime_auth_alias: bool = False,
) -> tuple[dict[str, object], object]:
    logs_dir = tmp_path / "agent"
    verifier_dir = tmp_path / "verifier"
    artifact_dir = tmp_path / "artifacts"
    verifier_dir.mkdir()
    npm_artifact = tmp_path / "server.tgz"
    write_npm_artifact(npm_artifact, npm_prompt_members or agent_prompt_members(bundle))
    materialized = materialize_production_home(
        cortex_home=logs_dir / "production-cortex-home",
        runtime_cortex_home=Path("/logs/agent/production-cortex-home"),
        artifacts_dir=artifact_dir,
        facts=ProductionArmLaunchFacts(
            arm_bundle=bundle,
            trial_id=TRIAL_ID, root_run_id=ROOT_RUN_ID, npm_artifact=npm_artifact,
            backend_cli_version="0.82.1",
            proxy_base_url=f"http://{TRIAL_ID}.proxy.invalid:49152",
            dummy_token_ref="trial-dummy-token", model_alias_policy={"policy": "exact"},
        ),
        inherited_environment={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    if runtime_auth_alias:
        auth = logs_dir / "production-cortex-home/data/pi/auth.json"
        auth.unlink()
        auth.symlink_to(
            "/logs/agent/production-cortex-home/container-home/.pi/agent/auth.json")
    (logs_dir / "instruction.md").write_text("Solve the task.\n", encoding="utf-8")
    (logs_dir / "workspace.diff").write_text(
        '{"schema_version":"cortex-bench-workspace-evidence/1"}\n', encoding="utf-8")
    write_json(artifact_dir / MANIFEST_FILENAME, {
        "schema_version": SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID, "arm": ARM_NAME,
        "container": {"image_ref": f"task@{DIGEST}", "image_digest": DIGEST},
    })
    write_json(artifact_dir / ADMISSION_EVIDENCE_FILENAME, admission_evidence())
    write_json(
        artifact_dir / finalization.CONTAINER_BOUNDARY_ATTESTATION_FILENAME,
        container_boundary_observation().document(TRIAL_ID),
    )
    revocation = production_proxy_outputs(artifact_dir)

    result = finalize_host_trial(
        logs_dir=logs_dir, verifier_dir=verifier_dir, artifact_dir=artifact_dir,
        root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=production_arm_for(bundle),
        npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT, revocation=revocation,
        scan_policy=production_scan_policy(), container_logs_dir=Path("/logs/agent"),
    )
    return json.loads(result.path.read_bytes()), materialized


def finalize_vendor_trial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    *, revocation_failure: str | None = None,
    mutation: Callable[[Path], None] | None = None,
) -> Mapping[str, object]:
    logs_dir = tmp_path / "agent"
    verifier_dir = tmp_path / "verifier"
    artifact_dir = tmp_path / "artifacts"
    logs_dir.mkdir()
    verifier_dir.mkdir()
    (logs_dir / "instruction.md").write_text("Solve the task.\n", encoding="utf-8")
    write_json(artifact_dir / MANIFEST_FILENAME, {
        "schema_version": SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID, "arm": "pi-vendor",
        "container": {"image_ref": f"task@{DIGEST}", "image_digest": DIGEST},
    })
    write_json(artifact_dir / ADMISSION_EVIDENCE_FILENAME, admission_evidence())
    write_json(
        artifact_dir / finalization.CONTAINER_BOUNDARY_ATTESTATION_FILENAME,
        container_boundary_observation().document(TRIAL_ID),
    )
    revocation = production_proxy_outputs(artifact_dir)
    if revocation_failure is not None:
        field, value = (
            ("listener_present", True) if revocation_failure == "active"
            else ("trial_id", "foreign-trial")
        )
        revocation = TrialRevocation(
            revocation.inventory, revocation.export_path, revocation.lease_echo_path,
            {**revocation.revocation, field: value},
        )
    if mutation is not None:
        mutation(tmp_path)
    monkeypatch.setattr(finalization.socket, "gethostname", lambda: "fixture-host")
    result = finalize_host_trial(
        logs_dir=logs_dir, verifier_dir=verifier_dir, artifact_dir=artifact_dir,
        root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=vendor_arm(),
        revocation=revocation, scan_policy=production_scan_policy(),
        container_logs_dir=Path("/logs/agent"),
        task={"task_id": "terminal-task", "image_ref": f"task@{DIGEST}",
              "image_digest": DIGEST},
    )
    return json.loads(result.path.read_bytes())


@pytest.mark.parametrize("bundle", PRODUCTION_ARM_BUNDLES, ids=lambda item: item.key)
def test_the_production_layout_records_through_the_same_collect_and_record_path(
    tmp_path: Path, bundle: ProductionArmBundle,
) -> None:
    """No arm branch survives: a production trial has no `arm-resolution.json` and its roles come
    from the home the launcher materialized, but it walks the same collector and publishes the same
    envelope shape as a legacy trial — for whichever arm's bundle actually ran.
    """
    envelope, materialized = finalize_production_trial(tmp_path, bundle)

    assert envelope["schema_version"] == OUTER_ENVELOPE_SCHEMA_VERSION
    assert not (tmp_path / "agent/arm-resolution.json").exists()
    for role in bundle.expected_roles:
        assert f"assets/bundle/defaults/prompts/systemPrompts/{role}.md" in asset_paths(envelope)
    recorded = envelope["launch"]["config_bundle"]
    assert recorded["canonical_sha256"] == materialized.input_bundle_sha256
    assert recorded["file_count"] == materialized.input_bundle_file_count
    assert len(recorded["files"]) == materialized.input_bundle_file_count
    assert canonical_sha256(recorded["files"]) == materialized.input_bundle_sha256


def test_production_auth_container_alias_scans_clean(tmp_path: Path) -> None:
    bundle = production_arm_bundle("direct-pi-deepseek")

    envelope, _ = finalize_production_trial(
        tmp_path, bundle, runtime_auth_alias=True,
    )

    files = recorded_files(envelope)
    assert files[("agent", "production-cortex-home/data/pi/auth.json")]["kind"] == "symlink"
    assert files[(
        "agent", "production-cortex-home/container-home/.pi/agent/auth.json",
    )]["kind"] == "file"
    assert envelope["leak_scan"]["unclassified_files"] == []
    assert envelope["leak_scan"]["clean"] is True


def test_the_cortex_envelope_bytes_match_the_pre_vendor_baseline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(globals(), "write_npm_artifact", write_deterministic_npm_artifact)
    finalize_production_trial(tmp_path, production_arm_bundle("direct-pi-deepseek"))

    assert sha256_hex(envelope_path(tmp_path).read_bytes()) == (
        "0c31100174176263ef12e345700709fd5da9d9be0f049b16fe7d5a23da6d36af"
    )


def test_vendor_uses_the_shared_envelope_with_explicit_cortex_unavailability(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    envelope = finalize_vendor_trial(tmp_path, monkeypatch)

    assert envelope["identity"] == {
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID,
        "arm_name": "pi-vendor", "arm_kind": "vendor-baseline",
    }
    assert envelope["task"] == {
        "task_id": "terminal-task", "image_ref": f"task@{DIGEST}",
        "image_digest": DIGEST,
    }
    assert envelope["launch"]["image"] == {
        "reference": f"task@{DIGEST}", "digest": DIGEST, "pinned": True,
    }
    assert envelope["launch"]["container_exit"]["status"] == "exited"
    marker = unavailable("not_applicable_to_vendor")
    assert envelope["launch"]["npm_artifact"] == marker
    assert envelope["launch"]["arm_bundle"] == marker
    assert envelope["launch"]["config_bundle"] == marker
    assert envelope["assets"] == marker
    assert envelope["telemetry"] == marker
    assert envelope["leak_scan"]["clean"] is True
    assert envelope["revocation"]["listener_present"] is False
    assert ("agent", "instruction.md") in recorded_files(envelope)
    write_json(tmp_path / "result.json", {
        "verifier_result": {"rewards": {"reward": 0.0}},
    })
    outcome = TrialOutcomeReader(
        trial_id=TRIAL_ID, arm_name="pi-vendor", trial_root=tmp_path,
    ).read()
    assert outcome.outcome_state == "terminal-success"
    assert outcome.verifier_rewards == {"reward": 0.0}


@pytest.mark.parametrize(
    "failure", ["scan-dirty", "scan-incomplete", "revocation-active",
                "revocation-foreign", "harness"],
)
def test_vendor_security_or_harness_failure_publishes_no_gradable_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str,
) -> None:
    if failure.startswith("scan"):
        clean = failure == "scan-incomplete"
        monkeypatch.setattr(finalization, "_scan_collected", lambda *_args: {
            "ok": True, "clean": clean, "matches": [], "missing_sources": [],
            "unclassified_files": ["collected:0000"] if clean else [],
        })
    elif failure == "harness":
        def fail_collection(*_args: object) -> object:
            raise HostFinalizationError("trial_output_collection_failed")
        monkeypatch.setattr(finalization, "_collect_and_scan", fail_collection)

    with pytest.raises(HostFinalizationError):
        revocation_failure = (
            failure.removeprefix("revocation-") if failure.startswith("revocation-") else None
        )
        finalize_vendor_trial(
            tmp_path, monkeypatch, revocation_failure=revocation_failure,
        )

    assert not envelope_path(tmp_path).exists()


def test_collected_provider_credential_refuses_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def inject_credential(root: Path) -> None:
        credential = production_scan_policy().secrets["provider_credential"]
        (root / "agent/provider-output.txt").write_text(credential)

    with pytest.raises(HostFinalizationError) as raised:
        finalize_vendor_trial(tmp_path, monkeypatch, mutation=inject_credential)

    assert raised.value.reason == "output_leak_detected"
    assert not envelope_path(tmp_path).exists()


@pytest.mark.parametrize("target", ["missing-target", "/etc/passwd"])
def test_dangling_or_escaping_collected_symlink_refuses_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str,
) -> None:
    def inject_symlink(root: Path) -> None:
        (root / "agent/unsafe-link").symlink_to(target)

    with pytest.raises(HostFinalizationError) as raised:
        finalize_vendor_trial(tmp_path, monkeypatch, mutation=inject_symlink)

    assert raised.value.reason == "output_scan_untrusted"
    assert not envelope_path(tmp_path).exists()


def test_collected_source_missing_before_scan_refuses_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = finalization._collect_roots

    def remove_after_collection(roots: Mapping[str, Path]) -> object:
        result = original(roots)
        (roots["agent"] / "instruction.md").unlink()
        return result

    monkeypatch.setattr(finalization, "_collect_roots", remove_after_collection)
    with pytest.raises(HostFinalizationError) as raised:
        finalize_vendor_trial(tmp_path, monkeypatch)

    assert raised.value.reason == "output_scan_untrusted"
    assert not envelope_path(tmp_path).exists()


def test_a_coder_review_trial_never_records_the_direct_arm_bundle(tmp_path: Path) -> None:
    """Hazard 4: a recorded file list that belongs to another arm is a fabricated parameter."""
    bundle = production_arm_bundle("coder-review-audit-retry-pi-deepseek")

    envelope, materialized = finalize_production_trial(tmp_path, bundle)

    recorded = envelope["launch"]["config_bundle"]["files"]
    paths = [entry["path"] for entry in recorded]
    assert "config/thread-templates/templates/benchmark-coder-review.json" in paths
    assert not any("benchmark-direct" in path for path in paths)
    assert recorded == list(committed_input_bundle_files(bundle.key))
    assert canonical_sha256(recorded) == materialized.input_bundle_sha256


def test_production_assets_copy_the_materialized_arm_prompts_not_npm_defaults(
    tmp_path: Path,
) -> None:
    bundle = production_arm_bundle("coder-review-audit-retry-pi-deepseek")
    npm_prompts = {
        path: b"different npm default\n" for path in agent_prompt_members(bundle)
    }

    envelope, _ = finalize_production_trial(
        tmp_path, bundle, npm_prompt_members=npm_prompts,
    )

    manifest = json.loads((tmp_path / "agent/assets/manifest.json").read_bytes())
    role = manifest["roles"]["benchmark-coder"]
    asset = tmp_path / "agent" / role["system_prompt"]
    expected = bundle.bundle_dir / "prompts/systemPrompts/benchmark-coder.md"
    assert asset.read_bytes() == expected.read_bytes()
    entry = next(
        item for item in manifest["files"]
        if item["asset_path"] == role["system_prompt"]
    )
    assert entry["container_path"] == (
        "/logs/agent/production-cortex-home/prompts/systemPrompts/benchmark-coder.md"
    )
    assert envelope["assets"]["file_count"] == 4


def test_an_attestation_naming_no_committed_bundle_records_no_other_arms_list(
    tmp_path: Path,
) -> None:
    bundle = production_arm_bundle("direct-pi-deepseek")
    logs_dir = tmp_path / "agent"
    (tmp_path / "verifier").mkdir()
    npm_artifact = tmp_path / "server.tgz"
    write_npm_artifact(npm_artifact, agent_prompt_members(bundle))
    logs_dir.mkdir(parents=True)
    (logs_dir / "instruction.md").write_text("Solve the task.\n", encoding="utf-8")
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    attestation = launch_attestation(npm_artifact)
    attestation["arm_bundle"] = {
        "key": "retired-arm", "profile_name": "retired", "root_template": "retired",
    }
    write_json(artifact_dir / "cortex-bench-launch-attestation.json", attestation)
    write_json(artifact_dir / ADMISSION_EVIDENCE_FILENAME, admission_evidence())
    revocation = production_proxy_outputs(artifact_dir)

    result = finalize_host_trial(
        logs_dir=logs_dir, verifier_dir=tmp_path / "verifier", artifact_dir=artifact_dir,
        root_run_id=ROOT_RUN_ID, trial_id=TRIAL_ID, arm=production_arm(),
        npm_artifact=npm_artifact, bundle_root=BUNDLE_ROOT, revocation=revocation,
        scan_policy=production_scan_policy(), container_logs_dir=Path("/logs/agent"),
    )

    recorded = json.loads(result.path.read_bytes())["launch"]["config_bundle"]
    assert recorded["files"] == unavailable("committed_input_bundle_unreadable")


@pytest.mark.parametrize("bundle", PRODUCTION_ARM_BUNDLES, ids=lambda item: item.key)
def test_the_committed_config_bundle_list_is_read_never_derived(
    bundle: ProductionArmBundle,
) -> None:
    entries = committed_input_bundle_files(bundle.key)
    on_disk = sorted(
        path.relative_to(bundle.bundle_dir).as_posix()
        for path in bundle.bundle_dir.rglob("*") if path.is_file()
    )

    assert [entry["path"] for entry in entries] == on_disk
    for entry in entries:
        assert entry["sha256"] == sha256_hex(
            (bundle.bundle_dir / entry["path"]).read_bytes())
