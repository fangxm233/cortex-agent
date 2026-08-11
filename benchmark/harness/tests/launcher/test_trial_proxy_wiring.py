# input:  shipped agent, arm, trial seed and host proxy spec
# output: route production, accounting and proven revocation tests
# pos:    Production start/revoke boundary tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# Harbor constructs the agent inside `Trial.__init__` (trial/trial.py:123,801) and creates the
# container much later, when `Trial.run()` reaches `DockerEnvironment.start` (trial.py:351,1155;
# environments/docker/docker.py:908). Construction is therefore strictly before container creation,
# which is what makes `CortexBenchAgent.__init__` a lawful place to arm the credential route.
# No container, no Docker and no network egress is used by this file: the trial's upstream is a
# closed loopback port, so a forwarded request fails to connect instead of reaching a provider.

import asyncio
import json
import socket
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.lease_bound import SETUP_TIMEOUT_MS, TEARDOWN_GRACE_MS
from cortex_bench_harness.launcher.trial_proxy import (
    PROXY_ARTIFACT_SOURCES,
    TrialProxySession,
    arm_trial_proxy,
    parse_trial_proxy_spec,
    revoke_trial_proxy,
)
from cortex_bench_harness.manifest import MANIFEST_FILENAME
from cortex_bench_harness.proxy.adapters import AdapterUnavailable
from cortex_bench_harness.proxy.manifest import fill_proxy_manifest
from cortex_bench_harness.proxy.models import PROXY_SCHEMA_VERSION, utc_text
from capability_admission import admit_every_capability

DIGEST = f"sha256:{'a' * 64}"
ROOT_RUN_ID = "trial-wiring.cortex-direct"
TRIAL_ID = "trial-wiring"
ARM_NAME = "cortex-direct"
MODEL = "claude-sonnet"
DEADLINE_SECONDS = 90
CREDENTIAL_ENV = "CORTEX_BENCH_WIRING_CREDENTIAL"
REAL_CREDENTIAL = "sk-ant-WIRING-BOUNDARY-UNIQUE"
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
CLI_PATH = "/usr/local/bin/claude"
CLI_VERSION = "1.2.3 (Claude Code)"
# A fixed host instant, so the provisional bound is an exact arithmetic expectation rather than a
# window. It is a host reading; nothing in this file derives it from a container clock.
H0_EPOCH_MS = 1_800_000_000_000


@pytest.fixture(autouse=True)
def admitted_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every shipped row is `unsupported` and the arming point now refuses one, so a wiring test
    would otherwise never reach the wiring. The refusal itself is proven against the shipped
    registry in `test_capability_state_gate.py`."""
    admit_every_capability(monkeypatch)


def closed_upstream() -> str:
    """A loopback port with nothing listening: a forwarded request fails to connect."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


def cortex_arm(credential_capability: str = "claude-api-key") -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": ARM_NAME, "backend": "claude",
        "provider": "anthropic", "model": MODEL,
        "credential_capability": credential_capability,
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8, "max_resident_agent_processes": 1,
            "max_cost_usd": "2.50", "deadline_seconds": DEADLINE_SECONDS,
        },
    }


def seed_credential(upstream: str) -> dict[str, object]:
    return {
        "upstream_base_url": upstream,
        "route_identity_host": "api.anthropic.com",
        "proxy_base_url": "http://trial-proxy.invalid",
        "dummy_token_ref": "offline-token-handle",
    }


def trial_seed(upstream: str, **overrides: object) -> dict[str, object]:
    return {
        "arm": cortex_arm(), "arm_path": f"arm://{ARM_NAME}", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": seed_credential(upstream), "model_alias_policy": {"kind": "exact"},
        **overrides,
    }


def manifest_seed(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"wiring fixture")
    return {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID, "arm": ARM_NAME,
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"registry.invalid/task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": len(b"wiring fixture"),
    }


def proxy_spec(**overrides: object) -> dict[str, object]:
    return {
        "credential_env": CREDENTIAL_ENV, "bound_source_ip": "127.0.0.1",
        "max_request_cost_usd": "1.00", "input_cost_per_million_usd": "3",
        "output_cost_per_million_usd": "15", **overrides,
    }


class ContainerEnvironment:
    """The container the agent probes, answering with container paths only, so no host path can
    enter the documents the agent writes."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.uploads: list[tuple[Path | str, str]] = []

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
            return ExecResult(stdout=f"{CLI_VERSION}\n", return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((source_path, target_path))


def public_agent(
    tmp_path: Path, upstream: str, *, proxy: dict[str, object] | None = None,
    **seed_overrides: object,
) -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest=manifest_seed(tmp_path), trial_seed=trial_seed(upstream, **seed_overrides),
        trial_proxy=proxy_spec() if proxy is None else proxy,
    )


def arm_session(
    tmp_path: Path, upstream: str, *, arm: dict[str, object] | None = None,
    proxy_dir: Path | None = None, trial_roots: tuple[Path, ...] | None = None,
    now_ms: int = H0_EPOCH_MS, spec: dict[str, object] | None = None,
) -> TrialProxySession:
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    return arm_trial_proxy(
        arm=arm or cortex_arm(), trial_id=TRIAL_ID, upstream_base_url=upstream,
        spec=parse_trial_proxy_spec(spec or proxy_spec()),
        proxy_dir=proxy_dir or artifacts / "proxy",
        trial_roots=trial_roots or (artifacts,),
        environ={CREDENTIAL_ENV: REAL_CREDENTIAL}, now_ms=lambda: now_ms,
    )


def epoch_datetime(epoch_ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=epoch_ms)


# W1 — the launcher arms the provisional bound P, never a container-derived instant.


def test_arms_the_provisional_bound_and_not_a_container_derived_instant(tmp_path: Path) -> None:
    session = arm_session(tmp_path, closed_upstream())
    try:
        expected = H0_EPOCH_MS + SETUP_TIMEOUT_MS + DEADLINE_SECONDS * 1000 + TEARDOWN_GRACE_MS
        armed = session.handle.manifest_block["absolute_deadline"]

        assert session.provisional_bound_ms == expected
        # The value the proxy actually armed, read back off the block it publishes rather than
        # off the argument the launcher computed.
        assert armed == utc_text(epoch_datetime(expected))
    finally:
        session.handle.stop()


def test_records_the_selected_adapter_at_arm_time(tmp_path: Path) -> None:
    session = arm_session(tmp_path, closed_upstream())
    try:
        record = json.loads(session.adapter_selection_path.read_text())
    finally:
        session.handle.stop()

    assert record["adapter_id"] == "anthropic-messages/api-key-bearer"
    assert record["trial_id"] == TRIAL_ID
    assert record["capability_key"]["proxy_adapter_version"] == PROXY_SCHEMA_VERSION
    assert REAL_CREDENTIAL not in json.dumps(record)


# W2 — the credential block producer.


def test_credential_block_producer_emits_exactly_the_four_declared_members(
    tmp_path: Path,
) -> None:
    upstream = closed_upstream()
    session = arm_session(tmp_path, upstream)
    try:
        block = session.credential_block(seed_credential(upstream))
    finally:
        session.handle.stop()

    assert set(block) == {
        "upstream_base_url", "route_identity_host", "proxy_base_url", "dummy_token_ref",
    }
    assert block["upstream_base_url"] == upstream
    assert block["route_identity_host"] == "api.anthropic.com"
    assert block["proxy_base_url"] == session.handle.base_url
    # The dummy token is the container-visible surface; the real credential is not in the document.
    assert block["dummy_token_ref"] == session.handle.dummy_token
    assert REAL_CREDENTIAL not in json.dumps(block)


def test_credential_block_refuses_a_seed_naming_a_different_upstream(tmp_path: Path) -> None:
    session = arm_session(tmp_path, closed_upstream())
    try:
        with pytest.raises(ValueError, match="upstream"):
            session.credential_block(seed_credential("https://other.invalid"))
    finally:
        session.handle.stop()


def test_public_entry_writes_the_produced_credential_block(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    upstream = closed_upstream()
    agent = public_agent(tmp_path, upstream)
    try:
        asyncio.run(agent.setup(ContainerEnvironment()))
        document = json.loads((agent.logs_dir / "arm-resolution.json").read_text())
    finally:
        agent.proxy_session.handle.stop()

    credential = document["credential"]
    assert credential["proxy_base_url"] == agent.proxy_session.handle.base_url
    assert credential["dummy_token_ref"] == agent.proxy_session.handle.dummy_token
    assert credential["upstream_base_url"] == upstream
    # The seed's placeholder members were replaced by the live handle's, which is the whole point
    # of the producer: before this, nothing filled them.
    assert credential["proxy_base_url"] != "http://trial-proxy.invalid"
    assert credential["dummy_token_ref"] != "offline-token-handle"


# W3 — the manifest's null block becomes the credential-free block.


def test_public_entry_fills_the_manifest_proxy_block(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    try:
        asyncio.run(agent.setup(ContainerEnvironment()))
        payload = (tmp_path / "artifacts" / MANIFEST_FILENAME).read_bytes()
        block = json.loads(payload)["proxy"]
        handle = agent.proxy_session.handle
    finally:
        agent.proxy_session.handle.stop()

    assert block == handle.manifest_block
    assert block["schema_version"] == PROXY_SCHEMA_VERSION
    assert block["base_url"] == handle.base_url
    assert REAL_CREDENTIAL.encode() not in payload
    assert handle.dummy_token.encode() not in payload


def test_double_fill_guard_still_raises_after_the_production_fill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    other = arm_session(tmp_path / "second", closed_upstream())
    try:
        asyncio.run(agent.setup(ContainerEnvironment()))
        manifest_path = tmp_path / "artifacts" / MANIFEST_FILENAME
        filled = manifest_path.read_text()

        with pytest.raises(ValueError, match="already populated"):
            fill_proxy_manifest(manifest_path, other.handle)

        assert manifest_path.read_text() == filled
    finally:
        other.handle.stop()
        agent.proxy_session.handle.stop()


# W4 — the finally-ordered revoke.


class RecordingHandle:
    """A handle stand-in that records the order in which the revoke reads it."""

    def __init__(self, calls: list[str], *, stop_error: bool = False) -> None:
        self.calls = calls
        self.base_url = "http://127.0.0.1:1"
        self.dummy_token = "dummy-recording"
        self.trial_id = TRIAL_ID
        self._stop_error = stop_error
        self._stopped = False

    @property
    def lease_echo_record(self) -> dict[str, object]:
        return {"status": "unavailable", "reason": "no_echo_received"}

    @property
    def accounting_export(self) -> dict[str, object]:
        self.calls.append("export")
        return {"schema_version": "cortex-bench-proxy-export/1", "trial_id": TRIAL_ID}

    @property
    def final_accounting_export(self) -> dict[str, object]:
        self.calls.append("freeze_handlers")
        return self.accounting_export

    @property
    def revocation_evidence(self) -> dict[str, object]:
        if not self._stopped:
            raise RuntimeError("proxy revocation has not been proven")
        return {
            "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": TRIAL_ID,
            "route_active": False, "listener_present": False,
            "serving_thread_alive": False, "active_handlers": 0, "body_handlers": 0,
        }

    def stop(self) -> None:
        self.calls.append("stop")
        if self._stop_error:
            raise RuntimeError("proxy client handlers did not stop")
        self._stopped = True


def recording_session(tmp_path: Path, calls: list[str], *, stop_error: bool = False):
    proxy_dir = tmp_path / "artifacts" / "proxy"
    proxy_dir.mkdir(parents=True, exist_ok=True)
    return TrialProxySession(
        handle=RecordingHandle(calls, stop_error=stop_error),
        upstream_base_url="http://127.0.0.1:1",
        absolute_deadline=epoch_datetime(H0_EPOCH_MS),
        provisional_bound_ms=H0_EPOCH_MS,
        proxy_dir=proxy_dir,
    )


def test_revoke_captures_the_inventory_then_exports_then_stops(tmp_path: Path) -> None:
    calls: list[str] = []
    session = recording_session(tmp_path, calls)

    revocation = revoke_trial_proxy(
        session, capture_inventory=lambda: calls.append("inventory") or "captured",
    )

    assert calls == ["inventory", "freeze_handlers", "export", "stop"]
    assert revocation.inventory == "captured"
    assert revocation.export_path.is_file()
    assert revocation.lease_echo_path.is_file()


def test_stop_failure_propagates_after_the_export_is_written(tmp_path: Path) -> None:
    calls: list[str] = []
    session = recording_session(tmp_path, calls, stop_error=True)

    with pytest.raises(RuntimeError, match="did not stop"):
        revoke_trial_proxy(session, capture_inventory=lambda: calls.append("inventory"))

    assert calls == ["inventory", "freeze_handlers", "export", "stop"]
    assert session.export_path.is_file()


def test_an_accounting_failure_still_takes_the_route_down(tmp_path: Path) -> None:
    """The mandated order says the export is written before the stop, not instead of it. A route
    left live because the artifact dir would not take the write is the worse of the two failures,
    so the stop still runs and the accounting error is the one that reaches the trial."""
    calls: list[str] = []
    session = recording_session(tmp_path, calls)
    # The export write fails the way a full or read-only artifact dir fails it.
    session.export_path.mkdir()

    with pytest.raises(OSError):
        revoke_trial_proxy(session, capture_inventory=lambda: calls.append("inventory"))

    assert calls == ["inventory", "freeze_handlers", "export", "stop"]


def test_public_entry_revokes_the_route_when_the_run_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    environment = ContainerEnvironment()
    asyncio.run(agent.setup(environment))
    session = agent.proxy_session
    listener = session.handle.base_url.rsplit(":", 1)

    asyncio.run(agent.run("Complete the task.", environment, AgentContext()))

    assert session.export_path.is_file()
    assert session.lease_echo_path.is_file()
    assert set(agent.captured_inventory.expected_sources) >= set(PROXY_ARTIFACT_SOURCES)
    with pytest.raises(OSError):
        socket.create_connection((listener[0].removeprefix("http://"), int(listener[1])), 2).close()


def test_public_entry_run_does_not_swallow_a_stop_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The revoke is in a `finally`, but a failure to stop is a trial failure, not a cleanup
    detail: the handle is replaced by one whose stop raises, and the run must surface it."""
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    environment = ContainerEnvironment()
    asyncio.run(agent.setup(environment))
    calls: list[str] = []
    live = agent.proxy_session
    try:
        agent._proxy_session = recording_session(tmp_path, calls, stop_error=True)

        with pytest.raises(RuntimeError, match="did not stop"):
            asyncio.run(agent.run("Complete the task.", environment, AgentContext()))
    finally:
        live.handle.stop()

    assert calls[-1] == "stop"


def test_run_takes_the_keyword_call_harbor_actually_makes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Harbor never calls the agent positionally: `run(instruction=…, environment=…, context=…)`
    at harbor/trial/trial.py:451-455, against the parameter names `BaseAgent.run` declares
    (harbor/agents/base.py:137-142). A renamed parameter is a TypeError raised before the body
    runs, which would leave the revoke in its `finally` unreachable in production while every
    positional test still passed."""
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    environment = ContainerEnvironment()
    asyncio.run(agent.setup(environment))
    session = agent.proxy_session

    asyncio.run(agent.run(
        instruction="Complete the task.", environment=environment, context=AgentContext(),
    ))

    assert route_is_dead(session)


class BrokenContainerEnvironment(ContainerEnvironment):
    """A container whose bundle-root probe answers nothing, which is how a mis-installed image
    fails: inside `setup()`, after the route has been armed."""

    async def exec(self, command: str, **kwargs: object) -> ExecResult:
        if "npm ls --global" in command:
            self.calls.append(command)
            return ExecResult(stdout="", return_code=0)
        return await super().exec(command, **kwargs)


def route_is_dead(session: TrialProxySession) -> bool:
    host, port = session.handle.base_url.removeprefix("http://").split(":")
    try:
        socket.create_connection((host, int(port)), 2).close()
    except OSError:
        return True
    return False


def test_public_entry_revokes_the_route_when_install_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    session = agent.proxy_session

    with pytest.raises(RuntimeError, match="bundle root probe"):
        asyncio.run(agent.install(BrokenContainerEnvironment()))

    assert route_is_dead(session)
    assert session.export_path.is_file()


def test_public_entry_revokes_the_route_when_setup_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Harbor never reaches `run()` when `setup()` raises, and it offers no teardown hook, so a
    revoke that only hangs off `run()` would leave the route live for the rest of the process —
    on the most common trial failure there is."""
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    session = agent.proxy_session

    with pytest.raises(RuntimeError, match="bundle root probe"):
        asyncio.run(agent.setup(BrokenContainerEnvironment()))

    assert route_is_dead(session)
    assert session.export_path.is_file()
    assert set(agent.captured_inventory.expected_sources) >= set(PROXY_ARTIFACT_SOURCES)


class CancelledContainerEnvironment(ContainerEnvironment):
    """The container as it behaves under Harbor's setup timeout: the awaited call is cancelled."""

    async def exec(self, command: str, **kwargs: object) -> ExecResult:
        if "npm ls --global" in command:
            raise asyncio.CancelledError
        return await super().exec(command, **kwargs)


def test_a_cancelled_setup_still_revokes_the_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Harbor bounds setup with `asyncio.wait_for` (harbor/trial/trial.py:1180-1183), so a slow
    setup ends in a `CancelledError` — a BaseException, not an Exception. Catching only Exception
    would leak the route on every timed-out trial."""
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    session = agent.proxy_session

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(agent.setup(CancelledContainerEnvironment()))

    assert route_is_dead(session)
    assert session.export_path.is_file()


def test_a_route_already_revoked_is_not_revoked_a_second_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second revoke would re-read registers that went with the stopped process and rewrite the
    documents the first one published, so the revoked trial stays revoked."""
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    agent = public_agent(tmp_path, closed_upstream())
    with pytest.raises(RuntimeError, match="bundle root probe"):
        asyncio.run(agent.setup(BrokenContainerEnvironment()))

    calls: list[str] = []
    agent._proxy_session = recording_session(tmp_path, calls)
    with pytest.raises(RuntimeError, match="setup"):
        asyncio.run(agent.run("Complete the task.", ContainerEnvironment(), AgentContext()))

    assert calls == []


# W5 — adapter selection at start, and refusal when nothing matches.


@pytest.mark.parametrize(
    "capability",
    ["claude-subscription", "pi-api-key", "pi-openai-codex-oauth", "codex-subscription"],
)
def test_refuses_to_start_when_no_adapter_matches_the_capability_key(
    tmp_path: Path, capability: str,
) -> None:
    with pytest.raises(AdapterUnavailable):
        arm_session(tmp_path, closed_upstream(), arm=cortex_arm(capability))

    # Nothing was started and nothing was written: an unadapted route is never opened.
    assert not (tmp_path / "artifacts" / "proxy").exists()


def test_refuses_an_unknown_capability_id(tmp_path: Path) -> None:
    with pytest.raises(LookupError):
        arm_session(tmp_path, closed_upstream(), arm=cortex_arm("no-such-capability"))


def test_refuses_when_the_host_credential_is_absent(tmp_path: Path) -> None:
    upstream = closed_upstream()
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(parents=True)

    with pytest.raises(ValueError, match=CREDENTIAL_ENV):
        arm_trial_proxy(
            arm=cortex_arm(), trial_id=TRIAL_ID, upstream_base_url=upstream,
            spec=parse_trial_proxy_spec(proxy_spec()), proxy_dir=artifacts / "proxy",
            trial_roots=(artifacts,), environ={}, now_ms=lambda: H0_EPOCH_MS,
        )

    assert not (artifacts / "proxy").exists()


# The launcher's own preconditions.


def test_refuses_a_proxy_directory_outside_every_trial_root(tmp_path: Path) -> None:
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()

    with pytest.raises(ValueError, match="trial root"):
        arm_session(
            tmp_path, closed_upstream(), proxy_dir=tmp_path / "outside" / "proxy",
            trial_roots=(artifacts,),
        )

    assert not (tmp_path / "outside").exists()


def test_public_entry_arms_the_route_at_construction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Construction is the last instant before Harbor creates the container, so the route must
    already answer here — before any environment call has been made."""
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_CREDENTIAL)
    environment = ContainerEnvironment()

    agent = public_agent(tmp_path, closed_upstream())

    try:
        host, port = agent.proxy_session.handle.base_url.removeprefix("http://").split(":")
        socket.create_connection((host, int(port)), 2).close()
        assert environment.calls == []
        assert agent.proxy_session.audit_log_path.parent.is_dir()
    finally:
        agent.proxy_session.handle.stop()


def test_paid_trial_refuses_to_construct_without_an_armed_proxy(tmp_path: Path) -> None:
    """A paid trial that starts without a proxy would put a real credential in front of a
    container, so an unwired production entry must fail closed rather than run unmetered."""
    with pytest.raises(ValueError, match="paid"):
        CortexBenchAgent(
            logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
            manifest=manifest_seed(tmp_path),
            trial_seed=trial_seed(closed_upstream(), paid_run=True),
        )


def test_unpaid_trial_without_a_proxy_keeps_the_shipped_behaviour(tmp_path: Path) -> None:
    agent = CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest=manifest_seed(tmp_path), trial_seed=trial_seed(closed_upstream()),
    )

    assert agent.proxy_session is None
    assert agent.captured_inventory is None


def test_spec_rejects_an_unknown_member(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="credential_value"):
        parse_trial_proxy_spec(proxy_spec(credential_value="sk-ant-nope"))
