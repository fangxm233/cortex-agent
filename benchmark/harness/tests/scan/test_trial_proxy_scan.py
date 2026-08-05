# input:  an offline trial driven through the shipped agent class and its armed proxy
# output: closed-inventory scan proofs for the four new proxy sources and the container surface
# pos:    Leak-scan extension over the credential-proxy flows
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The trial here runs with no container, no Docker and no network egress: the upstream is a closed
# loopback port, so the one forwarded request exercises route, body and auth injection and then
# fails to connect. Every assertion is against files the production path actually wrote.

import asyncio
import json
import socket
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.trial_proxy import (
    ADAPTER_SELECTION_RECORD_SOURCE,
    LEASE_ECHO_RECORD_SOURCE,
    PROXY_ARTIFACT_SOURCES,
    PROXY_AUDIT_LOG_SOURCE,
    PROXY_EXPORT_SOURCE,
)
from cortex_bench_harness.manifest import MANIFEST_FILENAME
from cortex_bench_harness.proxy.lease import LEASE_ECHO_SCHEMA_VERSION, LEASE_ECHO_TARGET
from cortex_bench_harness.scan.models import ArtifactInventory, ScanPolicy
from cortex_bench_harness.scan.scanner import scan_trial_artifacts

DIGEST = f"sha256:{'a' * 64}"
ROOT_RUN_ID = "trial-scan.cortex-direct"
TRIAL_ID = "trial-scan"
ARM_NAME = "cortex-direct"
MODEL = "claude-sonnet"
DEADLINE_SECONDS = 120
CREDENTIAL_ENV = "CORTEX_BENCH_SCAN_CREDENTIAL"
REAL_CREDENTIAL = "sk-ant-SCAN-BOUNDARY-UNIQUE"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
CLI_PATH = "/usr/local/bin/claude"
MESSAGES_TARGET = "/v1/messages?beta=true"
COMPILED_AT_EPOCH_MS = 1_800_000_240_000


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def closed_upstream() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


def cortex_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": ARM_NAME, "backend": "claude",
        "provider": "anthropic", "model": MODEL,
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8, "max_resident_agent_processes": 1,
            "max_cost_usd": "2.50", "deadline_seconds": DEADLINE_SECONDS,
        },
    }


def trial_seed(upstream: str) -> dict[str, object]:
    return {
        "arm": cortex_arm(), "arm_path": f"arm://{ARM_NAME}", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {
            "upstream_base_url": upstream, "route_identity_host": "api.anthropic.com",
            "proxy_base_url": "http://trial-proxy.invalid",
            "dummy_token_ref": "offline-token-handle",
        },
        "model_alias_policy": {"kind": "exact"},
    }


def manifest_seed(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"scan fixture")
    return {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID, "arm": ARM_NAME,
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"registry.invalid/task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": len(b"scan fixture"),
    }


class ContainerEnvironment:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def exec(self, command: str, **_kwargs: object) -> ExecResult:
        self.calls.append(command)
        if command.endswith("pwd") or "realpath -- /app" in command:
            return ExecResult(stdout="/app\n", return_code=0)
        if "npm ls --global" in command:
            return ExecResult(stdout=f"{BUNDLE_ROOT}\n", return_code=0)
        if command.endswith("cortex daemon --version"):
            return ExecResult(stdout="2026.8.3-2\n", return_code=0)
        if "command -v claude" in command:
            return ExecResult(stdout=f"{CLI_PATH}\n", return_code=0)
        if command.endswith("claude --version"):
            return ExecResult(stdout="1.2.3 (Claude Code)\n", return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        return None


def post(base_url: str, token: str, target: str, document: dict[str, object]) -> int:
    listener = urlsplit(base_url)
    connection = HTTPConnection(listener.hostname, listener.port, timeout=5)
    connection.request(
        "POST", target, body=json.dumps(document).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    response = connection.getresponse()
    response.read()
    connection.close()
    return response.status


def lease_echo_document() -> dict[str, object]:
    budget_ms = DEADLINE_SECONDS * 1000
    return {
        "schema_version": LEASE_ECHO_SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "compiled_at_epoch_ms": COMPILED_AT_EPOCH_MS,
        "absolute_epoch_ms": COMPILED_AT_EPOCH_MS + budget_ms,
        "remaining_ms": budget_ms - 5_000,
    }


class OfflineTrial:
    def __init__(self, agent: CortexBenchAgent, tmp_path: Path) -> None:
        self.agent = agent
        self.artifact_dir = tmp_path / "artifacts"
        self.logs_dir = tmp_path / "agent"
        self.dummy_token = agent.proxy_session.handle.dummy_token
        self.proxy_base_url = agent.proxy_session.handle.base_url

    @property
    def manifest_path(self) -> Path:
        return self.artifact_dir / MANIFEST_FILENAME

    @property
    def arm_resolution_path(self) -> Path:
        return self.logs_dir / "arm-resolution.json"

    def artifact_files(self) -> list[Path]:
        roots = (self.artifact_dir, self.logs_dir)
        return sorted(path for root in roots for path in root.rglob("*") if path.is_file())


def offline_trial(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> OfflineTrial:
    """One whole trial through the shipped class: arm at construction, compose and fill at setup,
    exercise the lease-echo and model routes, then revoke in the run's `finally`."""
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    upstream = closed_upstream()
    agent = CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest=manifest_seed(tmp_path), trial_seed=trial_seed(upstream),
        trial_proxy={
            "credential_env": CREDENTIAL_ENV, "bound_source_ip": "127.0.0.1",
            "max_request_cost_usd": "1.00", "input_cost_per_million_usd": "3",
            "output_cost_per_million_usd": "15",
        },
    )
    environment = ContainerEnvironment()
    asyncio.run(agent.setup(environment))
    trial = OfflineTrial(agent, tmp_path)
    assert post(
        trial.proxy_base_url, trial.dummy_token, LEASE_ECHO_TARGET, lease_echo_document(),
    ) == 200
    # Route, body and auth injection all run; the upstream port is closed, so the attempt is
    # recorded as unreachable instead of reaching any provider.
    assert post(
        trial.proxy_base_url, trial.dummy_token, MESSAGES_TARGET,
        {"model": MODEL, "prompt": "offline"},
    ) == 502
    asyncio.run(agent.run("Complete the task.", environment, AgentContext()))
    return trial


def scan_policy() -> ScanPolicy:
    return ScanPolicy(
        secrets={"provider_credential": REAL_CREDENTIAL},
        repository_checkout=str(repo_root()), hostname=socket.gethostname(),
    )


def test_trial_scan_is_clean_and_looked_at_every_new_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = offline_trial(tmp_path, monkeypatch)
    inventory = trial.agent.captured_inventory

    report = scan_trial_artifacts(inventory, scan_policy())

    assert set(inventory.expected_sources) >= set(PROXY_ARTIFACT_SOURCES)
    assert report.clean, report.as_dict()
    scanned = {source.source: source.bytes_scanned for source in report.sources}
    # bytes_scanned is what tells a clean report apart from one that never looked.
    assert all(scanned[source] > 0 for source in PROXY_ARTIFACT_SOURCES), scanned


@pytest.mark.parametrize("source", PROXY_ARTIFACT_SOURCES)
def test_removing_any_new_source_fails_the_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str,
) -> None:
    trial = offline_trial(tmp_path, monkeypatch)
    inventory = trial.agent.captured_inventory
    inventory.sources[source].unlink()

    report = scan_trial_artifacts(inventory, scan_policy())

    assert not report.clean
    assert report.missing_sources == (source,)
    assert report.exit_code == 1


def test_proxy_log_and_export_are_written_under_a_trial_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = offline_trial(tmp_path, monkeypatch)
    inventory = trial.agent.captured_inventory

    for source in PROXY_ARTIFACT_SOURCES:
        path = inventory.sources[source]
        assert path.is_file()
        assert any(path.is_relative_to(root) for root in inventory.trial_roots), path
    # The scanner rejects an inventory whose source escapes every trial root, so a report at all
    # is itself the containment proof rather than a claim about placement.
    assert scan_trial_artifacts(inventory, scan_policy()).clean


def test_container_visible_surface_is_only_a_scoped_endpoint_and_a_dummy_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The offline half of the containment claim. It does NOT cover the two in-container egress
    differentials — a real model endpoint refused from inside the container, and an arbitrary
    internet host refused from inside the container — which are properties of the trial network
    namespace and carry the Gate-10 obligation O-G10-EGRESS."""
    trial = offline_trial(tmp_path, monkeypatch)
    resolution = json.loads(trial.arm_resolution_path.read_text())
    credential = resolution["credential"]

    assert set(credential) == {
        "upstream_base_url", "route_identity_host", "proxy_base_url", "dummy_token_ref",
    }
    assert credential["proxy_base_url"] == trial.proxy_base_url
    assert credential["dummy_token_ref"] == trial.dummy_token
    for path in (trial.arm_resolution_path, trial.manifest_path):
        payload = path.read_bytes()
        assert REAL_CREDENTIAL.encode() not in payload
        assert str(repo_root()).encode() not in payload
        assert socket.gethostname().encode() not in payload
        assert b"/home/" not in payload


def test_no_artifact_carries_the_dummy_to_real_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = offline_trial(tmp_path, monkeypatch)

    files = trial.artifact_files()

    assert files
    for path in files:
        payload = path.read_bytes()
        assert REAL_CREDENTIAL.encode() not in payload, path
        assert not (
            trial.dummy_token.encode() in payload and REAL_CREDENTIAL.encode() in payload
        ), path


def test_scan_output_reports_positions_and_never_the_matched_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = offline_trial(tmp_path, monkeypatch)
    inventory = trial.agent.captured_inventory
    planted = inventory.sources[PROXY_EXPORT_SOURCE]
    planted.write_text(planted.read_text().replace(
        '"source"', f'"leaked": "{REAL_CREDENTIAL}", "source"', 1))

    report = scan_trial_artifacts(inventory, scan_policy())

    assert not report.clean
    document = json.dumps(report.as_dict())
    assert REAL_CREDENTIAL not in document
    assert [match["rule_id"] for match in report.as_dict()["matches"]] == [
        "secret:provider_credential",
    ]
    assert set(report.as_dict()["matches"][0]) == {
        "source", "rule_id", "category", "line", "column",
    }


def test_the_new_sources_are_the_four_the_flows_produce() -> None:
    assert PROXY_ARTIFACT_SOURCES == (
        PROXY_AUDIT_LOG_SOURCE, PROXY_EXPORT_SOURCE, LEASE_ECHO_RECORD_SOURCE,
        ADAPTER_SELECTION_RECORD_SOURCE,
    )
