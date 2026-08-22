# input:  real Docker PI image, synthetic upstream, lifecycle failures
# output: prompt transport, timeout containment, resume, revoke proofs
# pos:    Real-container boundary test for vendor trial lifecycle
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import asyncio
import json
import shlex
import time
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path

import pytest
import yaml
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.docker.docker import DockerEnvironment
from harbor.trial.hooks import TrialEvent
from harbor.trial.trial import Trial

import cortex_bench_harness.host_finalization as finalization
import cortex_bench_harness.vendor_agents as vendor_agents
from cortex_bench_harness import campaign
from cortex_bench_harness.host_finalization import OUTER_ENVELOPE_FILENAME
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    AdmittedDockerEnvironment,
    VendorRuntimeProjection,
)
from cortex_bench_harness.synthetic_deepseek import SyntheticDeepSeekUpstream
from cortex_bench_harness.vendor_agents import PreinstalledPi, VendorLifecycleMixin
from docker_gate import docker_opt_in

PI_IMAGE_DIGEST = "sha256:5f16cd3f75c54b22866a823b35e39305155c784886d1db5f894272d89f7cbbed"
PI_IMAGE = f"cortex-terminal-bench-2.1@{PI_IMAGE_DIGEST}"
CREDENTIAL_ENV = "CORTEX_BENCH_VENDOR_DOCKER_CREDENTIAL"
FORBIDDEN_ENV = "CORTEX_BENCH_VENDOR_DOCKER_FORBIDDEN"
FORBIDDEN_ARGV_ENV = "CORTEX_BENCH_VENDOR_DOCKER_ARGV"
CHECKOUT_ENV = "CORTEX_BENCH_VENDOR_DOCKER_CHECKOUT"
IDENTITY_ENV = "CORTEX_BENCH_VENDOR_DOCKER_IDENTITY"
TRIAL_ID = "vendor-docker-task-pure-pi"
TIMEOUT_TRIAL_ID = "vendor-docker-timeout-task-pure-pi"
ARM_NAME = "pure-pi"

pytestmark = docker_opt_in


def _write_task(
    root: Path, *, verifier: str | None = None,
    instruction: str = "Write the exact text `one` into `/tmp/answer.txt`.",
) -> Path:
    task = root / "task"
    tests = task / "tests"
    tests.mkdir(parents=True)
    (task / "instruction.md").write_text(instruction + "\n", encoding="utf-8")
    (task / "task.toml").write_text(
        "[environment]\n"
        f"docker_image = {json.dumps(PI_IMAGE)}\n"
        'network_mode = "public"\n'
        'os = "linux"\n\n'
        "[agent]\n"
        "timeout_sec = 30\n\n"
        "[verifier]\n"
        "timeout_sec = 30\n",
        encoding="utf-8",
    )
    script = verifier or (
        "#!/bin/sh\nset -eu\n"
        "test \"$(cat /tmp/answer.txt)\" = one\n"
        "printf '1\\n' > /logs/verifier/reward.txt\n"
    )
    test_path = tests / "test.sh"
    test_path.write_text(script, encoding="utf-8")
    test_path.chmod(0o755)
    return task


def _write_inputs(root: Path) -> dict[str, str]:
    paths = {
        "wheel_path": root / "harness.whl",
        "lockfile_path": root / "uv.lock",
        "npm_artifact_path": root / "server.tgz",
    }
    for path in paths.values():
        path.write_bytes(b"zero-paid vendor Docker fixture\n")
    return {
        **{key: str(path) for key, path in paths.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
    }


def _host_scan_policy() -> dict[str, object]:
    return {
        "secret_environment": {"provider_credential": CREDENTIAL_ENV},
        "forbidden_environment": {"ambient": FORBIDDEN_ENV},
        "forbidden_argv_environment": {"argv": FORBIDDEN_ARGV_ENV},
        "repository_checkout_environment": CHECKOUT_ENV,
        "host_identity_environment": {"machine": IDENTITY_ENV},
    }


def _vendor_arm(version: str) -> dict[str, object]:
    return {
        "name": ARM_NAME, "kind": "vendor-baseline", "vendor_agent": "pi",
        "vendor_cli_version": version, "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "limits": {
            "max_provider_requests": 4, "max_cost_usd": "0.01",
            "deadline_seconds": 30, "max_output_tokens": 8192,
        },
    }


def _campaign_document(
    root: Path, upstream: str, *, vendor_version: str = "0.82.1",
    agent_seconds: int = 30, verifier_seconds: int = 30,
    verifier: str | None = None,
    instruction: str = "Write the exact text `one` into `/tmp/answer.txt`.",
) -> dict[str, object]:
    subnet = uuid.uuid4().int % 512
    subnet_pool = f"198.{18 + subnet // 256}.{subnet % 256}.0/24"
    return {
        "schema_version": "cortex-bench-campaign/1", "campaign": "vendor-docker",
        "paid": False, "trials_dir": str(root / "trials"),
        "cli_version": "unused-vendor-version", "manifest": _write_inputs(root),
        "credential": {"upstream_base_url": upstream, "route_identity_host": "api.deepseek.com",
                       "proxy_host_suffix": "proxy.invalid", "dummy_token_ref": "dummy-only"},
        "host_scan_policy": _host_scan_policy(),
        "docker_network": {"subnet_pool": subnet_pool, "subnet_prefix": 24},
        "proxy": {"credential_env": CREDENTIAL_ENV, "listen_host": "0.0.0.0",
                  "request_body_limit_bytes": 4 * 1024 * 1024,
                  "response_body_limit_bytes": 4 * 1024 * 1024},
        "arms": [_vendor_arm(vendor_version)], "network": {"mode": "filtered"},
        "timeouts": {"agent_seconds": agent_seconds, "verifier_seconds": verifier_seconds},
        "tasks": [{
            "task_id": "task",
            "path": str(_write_task(root, verifier=verifier, instruction=instruction)),
            "image_ref": PI_IMAGE,
        }],
        "comparisons": [],
    }


def _write_campaign(root: Path, document: Mapping[str, object]) -> Path:
    path = root / "campaign.yaml"
    path.write_text(yaml.safe_dump(dict(document)), encoding="utf-8")
    return path


def _install_scan_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    values = {
        CREDENTIAL_ENV: "synthetic-host-credential",
        FORBIDDEN_ENV: "forbidden-environment-literal",
        FORBIDDEN_ARGV_ENV: "forbidden-argv-literal",
        CHECKOUT_ENV: "/private/vendor-docker-checkout",
        IDENTITY_ENV: "private-vendor-docker-machine",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def _install_first_cli_observer(monkeypatch: pytest.MonkeyPatch) -> None:
    original = VendorLifecycleMixin._setup_command
    wrapper = (
        "#!/bin/sh\nset -eu\n"
        "test -s /logs/agent/trial-home/pi-agent/auth.json\n"
        "test -s /logs/agent/trial-home/pi-agent/models.json\n"
        "test -s /logs/agent/vendor-runtime-files.json\n"
        "if test ! -e /logs/agent/first-vendor-cli.txt; then "
        "printf 'dummy-config-present-before-cli\\n' > /logs/agent/first-vendor-cli.txt; fi\n"
        "exec /usr/local/bin/pi.real \"$@\"\n"
    )

    def observed(self: VendorLifecycleMixin, files: object) -> str:
        command = original(self, files)  # type: ignore[arg-type]
        return (
            f"{command}; mv /usr/local/bin/pi /usr/local/bin/pi.real; "
            f"printf %s {shlex.quote(wrapper)} > /usr/local/bin/pi; "
            "chmod 0755 /usr/local/bin/pi"
        )

    monkeypatch.setattr(VendorLifecycleMixin, "_setup_command", observed)


def _track_routes(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    counts = {"arm": 0, "revoke": 0}
    original_arm = vendor_agents.arm_trial_proxy
    original_revoke = vendor_agents.revoke_trial_proxy

    def arm(*args: object, **kwargs: object) -> object:
        counts["arm"] += 1
        return original_arm(*args, **kwargs)

    def revoke(*args: object, **kwargs: object) -> object:
        counts["revoke"] += 1
        return original_revoke(*args, **kwargs)

    monkeypatch.setattr(vendor_agents, "arm_trial_proxy", arm)
    monkeypatch.setattr(vendor_agents, "revoke_trial_proxy", revoke)
    return counts


def _run_document(root: Path, document: Mapping[str, object]) -> dict[str, object]:
    path = _write_campaign(root, document)
    return campaign.run(argparse.Namespace(config=str(path), dry_run=False))


def _trial_root(root: Path) -> Path:
    return root / "trials" / TRIAL_ID


def _envelope_path(root: Path) -> Path:
    return _trial_root(root) / "artifacts" / OUTER_ENVELOPE_FILENAME


def _assert_one_route(counts: Mapping[str, int]) -> None:
    assert counts["arm"] <= 1
    assert counts["revoke"] == 1


def _assert_runtime_evidence(root: Path) -> None:
    evidence = json.loads(
        (_trial_root(root) / "artifacts" / ADMISSION_EVIDENCE_FILENAME).read_text()
    )
    projection = evidence["environment"]["runtime_projection"]
    assert projection["vendor_agent"] == "pi"
    assert set(projection["environment"]) == {
        "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
    }
    admitted = evidence["environment"]["admitted_keys"]
    assert not any(key.startswith("CORTEX_") for key in admitted)
    agent_root = _trial_root(root) / "agent"
    assert (agent_root / "first-vendor-cli.txt").read_text() == (
        "dummy-config-present-before-cli\n"
    )
    runtime = json.loads((agent_root / "vendor-runtime-files.json").read_text())
    assert runtime["recorded_before_vendor_cli"] is True


def test_real_docker_vendor_trial_reseals_prepares_cli_and_resumes_without_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_scan_environment(monkeypatch)
    _install_first_cli_observer(monkeypatch)
    counts = _track_routes(monkeypatch)
    with SyntheticDeepSeekUpstream() as upstream:
        document = _campaign_document(
            tmp_path, upstream.base_url,
            instruction="- Write the exact text `one` into `/tmp/answer.txt`.",
        )
        first = _run_document(tmp_path, document)
        paths = (_envelope_path(tmp_path), _trial_root(tmp_path) / "result.json")
        assert all(path.exists() for path in paths), first
        before = {path: path.read_bytes() for path in paths}
        resumed = _run_document(tmp_path, document)
    _assert_one_route(counts)
    assert upstream.request_count == 2
    assert first["trials"][0]["outcome_state"] == "terminal-success"
    assert first["trials"][0]["verifier_rewards"] == {"reward": 1.0}
    assert resumed["trials"][0]["state"] == "skipped"
    assert {path: path.read_bytes() for path in paths} == before
    _assert_runtime_evidence(tmp_path)


def test_timed_out_vendor_process_group_stops_before_verifier(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_scan_environment(monkeypatch)
    _install_first_cli_observer(monkeypatch)
    command = (
        ": pi --print; trap '' TERM; "
        "printf '%s\\n' \"$$\" > /logs/agent/timeout-process-group.txt; "
        ": > /logs/agent/timeout-session.log; "
        "while :; do printf 'agent-write\\n' >> /logs/agent/timeout-session.log; "
        "sleep 0.05; done"
    )
    monkeypatch.setattr(vendor_agents.PreinstalledPi, "_pi_text_command", lambda _: command)
    verifier = (
        "#!/bin/sh\nset -eu\n"
        "pgid=$(cat /logs/agent/timeout-process-group.txt)\n"
        "if kill -0 -- \"-$pgid\" 2>/dev/null; then exit 41; fi\n"
        "before=$(wc -c < /logs/agent/timeout-session.log)\n"
        "printf '%s\\n' \"$before\" > /logs/verifier/session-size-start.txt\n"
        "sleep 1\n"
        "after=$(wc -c < /logs/agent/timeout-session.log)\n"
        "printf '%s\\n' \"$after\" > /logs/verifier/session-size-end.txt\n"
        "test \"$before\" = \"$after\"\n"
        "printf '1\\n' > /logs/verifier/reward.txt\n"
    )
    agent_end_sizes: list[int] = []
    original_emit = Trial._emit

    async def observe_agent_end(self: Trial, event: TrialEvent) -> None:
        await original_emit(self, event)
        if event != TrialEvent.AGENT_END:
            return
        session = self.paths.agent_dir / "timeout-session.log"
        if not session.exists():
            return
        agent_end_sizes.append(session.stat().st_size)
        await asyncio.sleep(0.3)
        agent_end_sizes.append(session.stat().st_size)

    monkeypatch.setattr(Trial, "_emit", observe_agent_end)
    with SyntheticDeepSeekUpstream() as upstream:
        document = _campaign_document(
            tmp_path, upstream.base_url, agent_seconds=5, verifier=verifier,
        )
        document["tasks"][0]["task_id"] = "timeout-task"  # type: ignore[index]
        result = _run_document(tmp_path, document)

    trial = tmp_path / "trials" / TIMEOUT_TRIAL_ID
    harbor_result = json.loads((trial / "result.json").read_text())
    session = trial / "agent/timeout-session.log"
    size_after_agent_end = session.stat().st_size
    time.sleep(0.3)
    assert session.stat().st_size == size_after_agent_end
    assert len(agent_end_sizes) == 2
    assert agent_end_sizes[0] == agent_end_sizes[1] == size_after_agent_end
    assert harbor_result["exception_info"]["exception_type"] == "AgentTimeoutError"
    assert (
        harbor_result["agent_execution"]["finished_at"]
        <= harbor_result["verifier"]["started_at"]
    )
    assert (trial / "verifier/session-size-start.txt").read_text() == (
        trial / "verifier/session-size-end.txt"
    ).read_text()
    assert result["trials"][0]["verifier_rewards"] == {"reward": 1.0}


def test_unknown_vendor_projection_key_is_refused_before_docker_start_and_revoked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_scan_environment(monkeypatch)
    counts = _track_routes(monkeypatch)
    original = VendorLifecycleMixin.project_vendor_runtime

    def unknown(self: VendorLifecycleMixin, session: object) -> VendorRuntimeProjection:
        projection = original(self, session)
        assert isinstance(projection, VendorRuntimeProjection)
        return VendorRuntimeProjection(
            projection.vendor_agent, {**projection.environment, "UNKNOWN_VENDOR_KEY": "x"},
        )

    monkeypatch.setattr(VendorLifecycleMixin, "project_vendor_runtime", unknown)
    with SyntheticDeepSeekUpstream() as upstream:
        result = _run_document(tmp_path, _campaign_document(tmp_path, upstream.base_url))

    _assert_one_route(counts)
    assert result["trials"][0]["outcome_state"] == "harness-incomplete"
    harbor_result = json.loads((_trial_root(tmp_path) / "result.json").read_text())
    assert "unknown keys" in harbor_result["exception_info"]["exception_message"]
    assert not _envelope_path(tmp_path).exists()


def _fail_environment_start(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    async def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("synthetic environment start failure")
    monkeypatch.setattr(DockerEnvironment, "start", fail)
    return {}


def _fail_setup(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    monkeypatch.setattr(VendorLifecycleMixin, "_setup_command", lambda *_: "exit 19")
    return {}


def _fail_run(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    async def fail(*_args: object, **_kwargs: object) -> None:
        raise NonZeroAgentExitCodeError("synthetic vendor exit 23")
    monkeypatch.setattr(PreinstalledPi, "_run_vendor_instruction", fail)
    return {}


def _fail_timeout(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    async def hang(*_args: object, **_kwargs: object) -> None:
        await asyncio.sleep(60)
    monkeypatch.setattr(PreinstalledPi, "_run_vendor_instruction", hang)
    return {"agent_seconds": 1}


def _fail_scanner(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    monkeypatch.setattr(finalization, "_scan_collected", lambda *_: {
        "ok": True, "clean": False, "matches": [{"rule": "synthetic"}],
        "missing_sources": [], "unclassified_files": [],
    })
    return {}


def _fail_docker_stop(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    original = AdmittedDockerEnvironment._run_docker_compose_command
    failed = False

    async def fail(self: object, command: list[str], **kwargs: object) -> object:
        nonlocal failed
        if command == ["stop"] and not failed:
            failed = True
            raise RuntimeError("synthetic Docker stop failure")
        return await original(self, command, **kwargs)

    monkeypatch.setattr(AdmittedDockerEnvironment, "_run_docker_compose_command", fail)
    return {}


def _fail_publication(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    original = Path.write_text

    def fail_result(path: Path, *args: object, **kwargs: object) -> int:
        if path.name == "result.json":
            raise OSError("synthetic result publication failure")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", fail_result)
    return {}


FailureInjector = Callable[[pytest.MonkeyPatch], dict[str, object]]
FAILURE_INJECTORS: dict[str, FailureInjector] = {
    "environment-start": _fail_environment_start,
    "version-mismatch": lambda _: {"vendor_version": "9.9.9"},
    "setup": _fail_setup, "run-nonzero": _fail_run, "timeout-cancel": _fail_timeout,
    "verifier-exception": lambda _: {"verifier": "#!/bin/sh\nexit 31\n"},
    "verifier-timeout": lambda _: {
        "verifier": "#!/bin/sh\nsleep 60\n", "verifier_seconds": 1,
    },
    "scanner-finding": _fail_scanner, "docker-stop": _fail_docker_stop,
    "publication": _fail_publication,
}


def _inject_failure(
    failure: str, monkeypatch: pytest.MonkeyPatch,
) -> dict[str, object]:
    return FAILURE_INJECTORS[failure](monkeypatch)


@pytest.mark.parametrize(
    ("failure", "gradable"),
    [
        ("environment-start", False), ("version-mismatch", False),
        ("setup", False), ("run-nonzero", True), ("timeout-cancel", True),
        ("verifier-exception", True), ("verifier-timeout", True),
        ("scanner-finding", False), ("docker-stop", False),
        ("publication", False),
    ],
)
def test_real_docker_vendor_failure_matrix_arms_at_most_once_and_revokes_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str, gradable: bool,
) -> None:
    _install_scan_environment(monkeypatch)
    _install_first_cli_observer(monkeypatch)
    counts = _track_routes(monkeypatch)
    options = _inject_failure(failure, monkeypatch)
    with SyntheticDeepSeekUpstream() as upstream:
        document = _campaign_document(tmp_path, upstream.base_url, **options)
        result = _run_document(tmp_path, document)

    _assert_one_route(counts)
    assert _envelope_path(tmp_path).exists() is gradable
    assert result["trials"][0]["outcome_state"] != "terminal-success"
    if not gradable:
        assert result["trials"][0]["outcome_state"] == "harness-incomplete"
