# input:  Harbor trial builder, synthetic task, hostile inputs
# output: construction, endpoint enforcement and launch evidence
# pos:    Synthetic proof for the production Harbor admission boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import hashlib
import importlib
import json
import os
import socket
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import urlsplit

import pytest
from harbor.environments.base import ExecResult
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import NetworkMode
from harbor.trial.trial import Trial

from capability_admission import admit_capability
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.host_credential_vault import HOST_CREDENTIAL_VAULT
from cortex_bench_harness.launcher import trial_admission
from cortex_bench_harness.launcher.network_policy import NetworkAccess
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    ADMISSION_ENVIRONMENT_IMPORT_PATH,
    AdmittedDockerEnvironment,
    HarborTrialAdmissionError,
    VendorRuntimeProjection,
    build_harbor_trial_config,
    create_harbor_trial,
)

DIGEST = f"sha256:{'a' * 64}"
IMAGE_REF = f"registry.invalid/task@{DIGEST}"
PROXY_HOST = "trial-one.proxy.invalid"
PROXY_URL = f"http://{PROXY_HOST}:4317"
EXPECTED_ENVIRONMENT = {
    "CORTEX_BENCH_BACKEND": "pi",
    "CORTEX_BENCH_DEADLINE_SECONDS": "90",
    "CORTEX_BENCH_ROOT_RUN_ID": "trial-one.cortex-direct",
    "CORTEX_BENCH_TRIAL_ID": "trial-one",
    "CORTEX_HOME": "/logs/agent/trial-home/cortex-home",
    "CORTEX_PROJECTS_DIR": "/logs/agent/trial-home/projects",
    "HOME": "/logs/agent/trial-home/home",
    "HOSTNAME": "trial-one",
    "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "NODE_DISABLE_COMPILE_CACHE": "1",
    "PATH": "/installed-agent/npm/bin:/usr/local/bin:/usr/bin:/bin",
    "TEMP": "/logs/agent/trial-home/tmp", "TMP": "/logs/agent/trial-home/tmp",
    "TMPDIR": "/logs/agent/trial-home/tmp", "TZ": "UTC",
    "XDG_CACHE_HOME": "/logs/agent/trial-home/xdg-cache",
    "XDG_CONFIG_HOME": "/logs/agent/trial-home/xdg-config",
}
EXPECTED_VENDOR_STATIC_ENVIRONMENT = {
    key: value for key, value in EXPECTED_ENVIRONMENT.items()
    if not key.startswith("CORTEX_")
}
VENDOR_PROJECTIONS = {
    "pi": {
        "PI_CODING_AGENT_DIR": "/logs/agent/trial-home/pi-agent",
        "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
    },
    "claude-code": {
        "ANTHROPIC_BASE_URL": PROXY_URL,
        "ANTHROPIC_AUTH_TOKEN": "trial-scoped-dummy-token",
    },
    "codex": {
        "CODEX_HOME": "/logs/agent/trial-home/codex-home",
    },
}
LIVE_PROXY_HANDLES: list[object] = []


@pytest.fixture(autouse=True)
def admitted_fake_proxy(monkeypatch: pytest.MonkeyPatch):
    admit_capability(monkeypatch, "pi-deepseek-api-key")
    for name, value in {
        "CORTEX_BENCH_TEST_CREDENTIAL": "fake-host-credential",
        "CORTEX_BENCH_TEST_FORBIDDEN": "ambient-forbidden-value",
        "CORTEX_BENCH_TEST_ARGV": "argv-forbidden-value",
        "CORTEX_BENCH_TEST_CHECKOUT": "/srv/private/cortex-checkout",
        "CORTEX_BENCH_TEST_IDENTITY": "private-machine-id",
    }.items():
        monkeypatch.setenv(name, value)
    result = subprocess.CompletedProcess(
        args=["docker", "image", "inspect"], returncode=0,
        stdout=json.dumps({
            "Env": ["PATH=/image/path", "LANG=C"], "Volumes": None,
        }) + "\n", stderr="",
    )
    module = importlib.import_module(
        "cortex_bench_harness.launcher.trial_admission_io",
    )
    monkeypatch.setattr(
        module, "subprocess",
        SimpleNamespace(run=lambda *args, **kwargs: result), raising=False,
    )
    monkeypatch.setattr(DockerEnvironment, "start", AsyncMock())
    monkeypatch.setattr(
        AdmittedDockerEnvironment, "_install_proxy_endpoint_filter", AsyncMock(),
    )
    # No container runs in these tests, so the two calls that address a live one are stubbed. What
    # they do inside a real container is proved by the Docker-gated container boundary tests.
    monkeypatch.setattr(
        AdmittedDockerEnvironment, "_install_denylist_filter", AsyncMock(),
    )
    monkeypatch.setattr(DockerEnvironment, "_apply_network_policy", AsyncMock())
    yield
    for handle in LIVE_PROXY_HANDLES:
        handle.stop()
    LIVE_PROXY_HANDLES.clear()


def write_task(
    root: Path, *, network_mode: str = "public",
    allowed_hosts: tuple[str, ...] = (), os_name: str = "linux",
) -> Path:
    task = root / "task"
    (task / "environment").mkdir(parents=True)
    (task / "tests").mkdir()
    (task / "instruction.md").write_text("Make the requested change.\n")
    test_file = "test.bat" if os_name == "windows" else "test.sh"
    test_script = "exit /b 0\n" if os_name == "windows" else "#!/bin/sh\nexit 0\n"
    (task / f"tests/{test_file}").write_text(test_script)
    hosts = ", ".join(json.dumps(host) for host in allowed_hosts)
    (task / "task.toml").write_text(
        "[environment]\n"
        f"docker_image = {json.dumps(IMAGE_REF)}\n"
        f"network_mode = {json.dumps(network_mode)}\n"
        f"allowed_hosts = [{hosts}]\n"
        f"os = {json.dumps(os_name)}\n\n"
        "[agent]\n"
        "timeout_sec = 90\n"
    )
    return task


def write_manifest_inputs(root: Path) -> dict[str, object]:
    root.mkdir(parents=True, exist_ok=True)
    files = {
        "wheel_path": root / "harness.whl",
        "lockfile_path": root / "uv.lock",
        "npm_artifact_path": root / "server.tgz",
    }
    for path in files.values():
        path.write_bytes(b"synthetic admission fixture")
    return {
        **{key: str(value) for key, value in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": IMAGE_REF,
        "image_digest": DIGEST,
        "image_size_bytes": len(b"synthetic admission fixture"),
    }


def arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex",
        "name": "cortex-direct",
        "backend": "pi",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_provider_requests": 8,
            "max_cost_usd": "2.50",
            "deadline_seconds": 90,
            "max_output_tokens": 65536,
        },
    }


def deepseek_arm() -> dict[str, object]:
    value = arm()
    value.update(
        name="cortex-deepseek-direct", backend="pi", provider="deepseek",
        model="deepseek-v4-flash", credential_capability="pi-deepseek-api-key",
    )
    value["limits"] = {**value["limits"], "max_provider_requests": 1,
                       "max_cost_usd": "0.05"}
    return value


def vendor_arm(vendor_agent: str) -> dict[str, object]:
    provider = {"pi": "deepseek", "claude-code": "anthropic", "codex": "openai-codex"}[
        vendor_agent
    ]
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "vendor-baseline",
        "name": f"pure-{vendor_agent}", "vendor_agent": vendor_agent,
        "vendor_cli_version": "1.2.3", "provider": provider,
        "model": "representative-model", "credential_capability": "fixture-capability",
        "limits": dict(arm()["limits"]),
    }


def seed() -> dict[str, object]:
    return {
        "arm": arm(),
        "arm_path": "arm://cortex-direct",
        "trial_id": "trial-one",
        "root_run_id": "trial-one.cortex-direct",
        "task": {
            "task_id": "synthetic-task",
            "image_ref": IMAGE_REF,
            "image_digest": DIGEST,
        },
        "profile_name": "benchmark",
        "paid_run": False,
        "credential": {
            "upstream_base_url": "https://api.anthropic.com",
            "route_identity_host": "api.anthropic.com",
            "proxy_base_url": PROXY_URL,
            "dummy_token_ref": "must-not-appear-in-launch-evidence",
        },
        "model_alias_policy": {"kind": "exact"},
    }


def host_scan_policy() -> dict[str, object]:
    return {
        "secret_environment": {"provider_credential": "CORTEX_BENCH_TEST_CREDENTIAL"},
        "forbidden_environment": {"forbidden": "CORTEX_BENCH_TEST_FORBIDDEN"},
        "forbidden_argv_environment": {"forbidden": "CORTEX_BENCH_TEST_ARGV"},
        "repository_checkout_environment": "CORTEX_BENCH_TEST_CHECKOUT",
        "host_identity_environment": {"machine": "CORTEX_BENCH_TEST_IDENTITY"},
    }


def launch_kwargs(
    root: Path, task: Path | None = None, network: NetworkAccess | None = None,
) -> dict[str, object]:
    manifest = {
        "root_run_id": "trial-one.cortex-direct",
        "trial_id": "trial-one",
        "arm": "cortex-direct",
        **write_manifest_inputs(root),
    }
    return {
        "arm": arm(),
        "task_path": task or write_task(root),
        "trials_dir": root / "trials",
        "manifest": manifest,
        "trial_seed": seed(),
        "cli_version": "2026.8.10", "host_scan_policy": host_scan_policy(),
        "trial_proxy": trial_proxy_spec(),
        "network": network,
    }


def vendor_launch_kwargs(root: Path, vendor_agent: str) -> dict[str, object]:
    kwargs = launch_kwargs(root)
    selected_arm = vendor_arm(vendor_agent)
    vendor_seed = dict(kwargs["trial_seed"])
    vendor_seed.update(
        arm=selected_arm, arm_path=f"arm://pure-{vendor_agent}",
        root_run_id=f"trial-one.pure-{vendor_agent}",
    )
    kwargs.update(arm=selected_arm, trial_seed=vendor_seed)
    return kwargs


class VendorProxyController:
    def __init__(
        self, vendor_agent: str, environment: dict[str, str] | None = None,
        projection_error: BaseException | None = None,
    ) -> None:
        handle = SimpleNamespace(
            base_url=PROXY_URL, trial_id="trial-one",
            dummy_token="trial-scoped-dummy-token",
            manifest_block={"source_binding": {"kind": "ip", "value": "172.19.0.2"}},
        )
        self.session = SimpleNamespace(handle=handle)
        self.projection = VendorRuntimeProjection(
            vendor_agent=vendor_agent,
            environment=environment or VENDOR_PROJECTIONS[vendor_agent],
        )
        self.projection_error = projection_error
        self.calls: list[str] = []
        self.revoke_count = 0
        self.real_credential = "real-provider-secret-must-not-cross"

    def arm_admitted_proxy(self) -> object:
        self.calls.append("arm")
        return self.session

    def project_vendor_runtime(self, session: object) -> VendorRuntimeProjection:
        assert session is self.session
        self.calls.append("project")
        if self.projection_error is not None:
            raise self.projection_error
        return self.projection

    def revoke_admitted_proxy(self) -> None:
        self.revoke_count += 1


def create_vendor_trial(
    root: Path, vendor_agent: str, controller: VendorProxyController,
) -> Trial:
    config = build_harbor_trial_config(**vendor_launch_kwargs(root, vendor_agent))
    trial = asyncio.run(Trial.create(config))
    trial.agent_environment.bind_proxy_controller(controller)
    return trial


def create_trial(
    root: Path, task: Path | None = None, network: NetworkAccess | None = None,
) -> Trial:
    trial = asyncio.run(create_harbor_trial(**launch_kwargs(root, task, network)))
    assert isinstance(trial.agent, CortexBenchAgent)
    assert trial.agent.proxy_session is None
    return trial


def start_trial(trial: Trial) -> None:
    asyncio.run(trial.agent_environment.start(force_build=False))
    assert trial.agent.proxy_session is not None
    LIVE_PROXY_HANDLES.append(trial.agent.proxy_session.handle)


def evidence_path(trial: Trial) -> Path:
    return trial.paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME


def proxy_route_is_dead(session: object) -> bool:
    port = urlsplit(session.handle.base_url).port
    try:
        socket.create_connection(("127.0.0.1", port), 2).close()
    except OSError:
        return True
    return False


def test_serialized_trial_config_contains_no_host_scan_literals(tmp_path: Path) -> None:
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))

    serialized = config.model_dump_json()

    for literal in (
        "fake-host-credential", "ambient-forbidden-value", "argv-forbidden-value",
        "/srv/private/cortex-checkout", "/private/host-home", "private-host",
        "private-machine-id",
    ):
        assert literal not in serialized


def test_public_entry_builds_the_sealed_trial_config(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)

    config = build_harbor_trial_config(**kwargs)

    assert config.trial_name == "trial-one"
    assert config.task.path == Path(kwargs["task_path"]).resolve()
    assert config.environment.import_path == ADMISSION_ENVIRONMENT_IMPORT_PATH
    assert config.environment.type is None
    assert config.environment.mounts is None
    assert config.environment.extra_allowed_hosts == []
    # The campaign's network block is the only statement of what a trial may reach, so the agent
    # config states nothing: Harbor's plan is PUBLIC and would discard these anyway.
    assert config.agent.extra_allowed_hosts == []
    assert config.agent.env == config.environment.env
    assert config.agent.env == EXPECTED_ENVIRONMENT


@pytest.mark.parametrize("vendor_agent", ["pi", "claude-code", "codex"])
def test_vendor_projection_is_recorded_before_start_and_reseals_exec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor_agent: str,
) -> None:
    controller = VendorProxyController(vendor_agent)
    trial = create_vendor_trial(tmp_path, vendor_agent, controller)
    docker_start_observations: list[dict[str, object]] = []

    async def observe_projection(*_args: object, **_kwargs: object) -> None:
        controller.calls.append("docker-start")
        docker_start_observations.append(json.loads(evidence_path(trial).read_text()))
    monkeypatch.setattr(DockerEnvironment, "start", AsyncMock(side_effect=observe_projection))
    asyncio.run(trial.agent_environment.start(force_build=False))
    compose_exec = AsyncMock(return_value=ExecResult(return_code=0))
    monkeypatch.setattr(trial.agent_environment, "_compose_exec", compose_exec)
    asyncio.run(trial.agent_environment.exec("vendor --version"))
    final_environment = {**EXPECTED_VENDOR_STATIC_ENVIRONMENT, **VENDOR_PROJECTIONS[vendor_agent]}
    observed = docker_start_observations[0]["environment"]
    assert controller.calls == ["arm", "project", "docker-start"]
    class_name = {
        "pi": "PreinstalledPi", "claude-code": "PreinstalledClaudeCode",
        "codex": "PreinstalledCodex",
    }[vendor_agent]
    assert trial.config.agent.import_path == (
        f"cortex_bench_harness.vendor_agents:{class_name}"
    )
    assert trial.config.agent.kwargs["version"] == "1.2.3"
    assert set(trial.config.agent.kwargs) == {
        "version", "artifact_dir", "manifest", "trial_seed", "trial_proxy",
        "host_scan_policy", "admission_environment_digest", "defer_proxy_arm",
    }
    assert trial.config.environment.env == EXPECTED_VENDOR_STATIC_ENVIRONMENT
    assert trial.agent_environment._persistent_env == final_environment
    assert observed["runtime_projection"] == {
        "vendor_agent": vendor_agent,
        "environment": VENDOR_PROJECTIONS[vendor_agent],
    }
    assert observed["admitted_keys"] == sorted(final_environment)
    assert all(not key.startswith("CORTEX_") for key in final_environment)
    command = compose_exec.await_args.args[0]
    assert "real-provider-secret-must-not-cross" not in command


@pytest.mark.parametrize(
    ("environment", "message"),
    [
        ({**VENDOR_PROJECTIONS["pi"], "UNEXPECTED": "value"}, "unknown keys"),
        ({**VENDOR_PROJECTIONS["pi"], "PI_OFFLINE": "0"}, "value drift"),
    ],
)
def test_vendor_projection_drift_revokes_before_container_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    environment: dict[str, str], message: str,
) -> None:
    controller = VendorProxyController("pi", environment)
    trial = create_vendor_trial(tmp_path, "pi", controller)
    start = patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    with pytest.raises(HarborTrialAdmissionError, match=message):
        asyncio.run(trial.agent_environment.start(force_build=False))

    assert controller.calls == ["arm", "project"]
    assert controller.revoke_count == 1
    start.assert_not_awaited()


def test_vendor_projection_failure_revokes_before_container_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = VendorProxyController(
        "codex", projection_error=RuntimeError("projection failed"),
    )
    trial = create_vendor_trial(tmp_path, "codex", controller)
    start = patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    with pytest.raises(RuntimeError, match="projection failed"):
        asyncio.run(trial.agent_environment.start(force_build=False))

    assert controller.calls == ["arm", "project"]
    assert controller.revoke_count == 1
    start.assert_not_awaited()


def test_vendor_projection_cannot_reseal_concurrent_static_environment_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = VendorProxyController("pi")
    trial = create_vendor_trial(tmp_path, "pi", controller)
    start = patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    def project_with_drift(session: object) -> VendorRuntimeProjection:
        controller.calls.append("project")
        trial.agent_environment._persistent_env["AWS_SECRET_ACCESS_KEY"] = "host-secret"
        return controller.projection

    monkeypatch.setattr(controller, "project_vendor_runtime", project_with_drift)

    with pytest.raises(HarborTrialAdmissionError, match="sealed allowlist"):
        asyncio.run(trial.agent_environment.start(force_build=False))

    assert controller.calls == ["arm", "project"]
    assert controller.revoke_count == 1
    start.assert_not_awaited()


def test_vendor_arm_with_cortex_composition_field_is_refused(tmp_path: Path) -> None:
    kwargs = vendor_launch_kwargs(tmp_path, "claude-code")
    selected_arm = dict(kwargs["arm"])
    selected_arm["backend"] = "claude"
    selected_seed = dict(kwargs["trial_seed"])
    selected_seed["arm"] = selected_arm
    kwargs.update(arm=selected_arm, trial_seed=selected_seed)

    with pytest.raises(ValueError, match="Cortex composition"):
        build_harbor_trial_config(**kwargs)


def test_vendor_config_rejects_selected_arm_seed_mismatch(tmp_path: Path) -> None:
    kwargs = vendor_launch_kwargs(tmp_path, "pi")
    mismatched_seed = dict(kwargs["trial_seed"])
    mismatched_seed["arm"] = vendor_arm("codex")
    kwargs["trial_seed"] = mismatched_seed

    with pytest.raises(ValueError, match="trial_seed.arm"):
        build_harbor_trial_config(**kwargs)


def test_vendor_trial_config_and_admission_record_exclude_real_credential(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = VendorProxyController("claude-code")
    config = build_harbor_trial_config(**vendor_launch_kwargs(tmp_path, "claude-code"))
    assert controller.real_credential not in config.model_dump_json()
    trial = asyncio.run(Trial.create(config))
    trial.agent_environment.bind_proxy_controller(controller)
    monkeypatch.setattr(DockerEnvironment, "start", AsyncMock())

    asyncio.run(trial.agent_environment.start(force_build=False))

    assert controller.real_credential not in evidence_path(trial).read_text()


def test_agent_phase_defaults_to_the_arm_deadline_and_leases_for_it(tmp_path: Path) -> None:
    """An undeclared phase timeout keeps the arm's deadline as the whole trial window."""
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))
    deadline = float(arm()["limits"]["deadline_seconds"])

    assert config.agent.override_timeout_sec == deadline
    assert config.agent.max_timeout_sec == deadline
    assert config.verifier.override_timeout_sec is None
    assert config.agent.kwargs["trial_proxy"]["lease_seconds"] == int(deadline)


def test_declared_phase_timeouts_supersede_the_task_without_editing_it(
    tmp_path: Path,
) -> None:
    """Harbor's override fields are how a digest-pinned task.toml is retimed.

    The verifier phase makes no provider request, so lengthening it must not lengthen the
    credential lease; the lease follows min(deadline_seconds, agent_seconds) alone.
    """
    lengthened = build_harbor_trial_config(
        **launch_kwargs(tmp_path / "long"),
        agent_timeout_seconds=3600, verifier_timeout_seconds=7200)
    shortened = build_harbor_trial_config(
        **launch_kwargs(tmp_path / "short"), agent_timeout_seconds=30)

    assert (lengthened.agent.override_timeout_sec, lengthened.agent.max_timeout_sec) == (
        3600.0, 3600.0)
    assert (lengthened.verifier.override_timeout_sec, lengthened.verifier.max_timeout_sec) == (
        7200.0, 7200.0)
    # The arm still stops itself at 90, so an hour-long agent phase and a two-hour verifier
    # phase leave the credential live for 90 seconds and not one second more.
    assert lengthened.agent.kwargs["trial_proxy"]["lease_seconds"] == 90
    assert shortened.agent.override_timeout_sec == 30.0
    assert shortened.agent.kwargs["trial_proxy"]["lease_seconds"] == 30


def test_deepseek_identity_is_admitted_without_container_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    admit_capability(monkeypatch, "pi-deepseek-api-key")
    kwargs = launch_kwargs(tmp_path)
    deepseek = deepseek_arm()
    deepseek_seed = dict(kwargs["trial_seed"])
    deepseek_seed.update(arm=deepseek, arm_path="arm://cortex-deepseek-direct",
                         pi_benchmark_capability_proven=True)
    credential = dict(deepseek_seed["credential"])
    credential.update(upstream_base_url="https://api.deepseek.com",
                      route_identity_host="api.deepseek.com")
    deepseek_seed["credential"] = credential
    kwargs.update(arm=deepseek, trial_seed=deepseek_seed)

    config = build_harbor_trial_config(**kwargs)

    assert "DEEPSEEK_API_KEY" not in config.agent.env
    assert "DEEPSEEK_BASE_URL" not in config.agent.env
    assert "CLAUDE_CONFIG_DIR" not in config.agent.env


def trial_proxy_spec(**overrides: object) -> dict[str, object]:
    return {
        "credential_env": "CORTEX_BENCH_TEST_CREDENTIAL",
        "bound_source_ip": "172.19.0.2",
        "request_body_limit_bytes": 16 * 1024 * 1024,
        "response_body_limit_bytes": 16 * 1024 * 1024,
        "listen_host": "0.0.0.0",
        **overrides,
    }


def test_builder_binds_proxy_advertisement_to_the_admitted_host(
    tmp_path: Path,
) -> None:
    kwargs = launch_kwargs(tmp_path)

    config = build_harbor_trial_config(**kwargs)

    assert config.agent.kwargs["trial_proxy"]["advertised_host"] == PROXY_HOST
    assert config.agent.kwargs["defer_proxy_arm"] is True
    kwargs["trial_proxy"] = trial_proxy_spec(
        advertised_host="trial-sibling.proxy.invalid",
    )
    with pytest.raises(HarborTrialAdmissionError, match="advertised host"):
        build_harbor_trial_config(**kwargs)


@pytest.mark.parametrize("network,service", [
    (None, "main"),
    (NetworkAccess(mode="filtered", allowlist=("example.com",)),
     "harbor-docker-egress-control-sidecar"),
])
def test_admitted_environment_maps_only_its_proxy_host_to_the_docker_host_gateway(
    tmp_path: Path, network: NetworkAccess | None, service: str,
) -> None:
    """The overlay follows whoever holds the namespace, which the network mode decides.

    Under `filtered` an egress sidecar exists and `main` shares its namespace, so the sidecar is
    the service to configure. Under `open` no sidecar is built at all and `main` holds its own.
    """
    trial = create_trial(tmp_path, network=network)
    environment = trial.agent_environment

    document = json.loads(environment._proxy_host_path.read_text())

    assert document == {"services": {
        service: {"extra_hosts": [f"{PROXY_HOST}:host-gateway"]},
    }}
    assert environment._proxy_host_path in environment._docker_compose_paths


@pytest.mark.parametrize("network,service", [
    (None, "main"),
    (NetworkAccess(mode="filtered", allowlist=("example.com",)),
     "harbor-docker-egress-control-sidecar"),
])
def test_admitted_environment_pins_the_container_to_its_admitted_address(
    tmp_path: Path, network: NetworkAccess | None, service: str,
) -> None:
    """The address the credential route will accept is DECLARED, not predicted.

    Only the namespace holder is a member of the trial's network, so pinning it pins the source
    address of every request the route sees. Concurrent trials each sit on their own subnet, so
    reading the address off Docker's allocation order would be a prediction made once per trial.
    """
    trial = create_trial(tmp_path, network=network)
    environment = trial.agent_environment

    document = json.loads(environment._container_address_path.read_text())

    assert document == {"services": {
        service: {"networks": {"default": {"ipv4_address": "172.19.0.2"}}},
    }}
    assert environment._container_address_path in environment._docker_compose_paths
    # Last wins in Compose merge order, and Harbor's own files come first.
    paths = environment._docker_compose_paths
    assert paths.index(environment._container_address_path) == len(paths) - 1


def test_the_admitted_container_address_is_the_proxy_source_binding(
    tmp_path: Path,
) -> None:
    """One decision, not two: the same value configures the container and binds the route."""
    kwargs = launch_kwargs(tmp_path)
    kwargs["trial_proxy"] = trial_proxy_spec(bound_source_ip="172.30.241.2")

    config = build_harbor_trial_config(**kwargs)

    admission = config.environment.kwargs["admission"]
    assert admission["container_ipv4"] == "172.30.241.2"
    assert config.agent.kwargs["trial_proxy"]["bound_source_ip"] == "172.30.241.2"


@pytest.mark.parametrize("value", ["", "172.30.240", "not-an-address", "::1"])
def test_a_container_address_that_is_not_ipv4_is_refused(
    tmp_path: Path, value: str,
) -> None:
    kwargs = launch_kwargs(tmp_path)
    kwargs["trial_proxy"] = trial_proxy_spec(bound_source_ip=value)

    with pytest.raises(HarborTrialAdmissionError, match="bound_source_ip"):
        build_harbor_trial_config(**kwargs)


def test_builder_refuses_a_proxy_not_listening_on_the_container_route(
    tmp_path: Path,
) -> None:
    kwargs = launch_kwargs(tmp_path)
    proxy = dict(kwargs["trial_proxy"])
    proxy.pop("listen_host")
    kwargs["trial_proxy"] = proxy

    with pytest.raises(HarborTrialAdmissionError, match="listen_host"):
        build_harbor_trial_config(**kwargs)


def test_builder_does_not_freeze_a_pre_arm_proxy_port_in_the_environment(
    tmp_path: Path,
) -> None:
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))

    assert "CORTEX_BENCH_PROXY_URL" not in config.environment.env


def test_builder_refuses_a_proxy_hostname_not_scoped_to_the_trial(
    tmp_path: Path,
) -> None:
    kwargs = launch_kwargs(tmp_path)
    unsafe_seed = dict(kwargs["trial_seed"])
    unsafe_credential = dict(unsafe_seed["credential"])
    unsafe_credential["proxy_base_url"] = "http://shared.proxy.invalid:4317"
    unsafe_seed["credential"] = unsafe_credential
    kwargs["trial_seed"] = unsafe_seed

    with pytest.raises(HarborTrialAdmissionError, match="trial-scoped"):
        build_harbor_trial_config(**kwargs)


def test_builder_refuses_to_admit_a_trial_without_a_current_proxy(
    tmp_path: Path,
) -> None:
    kwargs = launch_kwargs(tmp_path)
    kwargs["trial_proxy"] = None

    with pytest.raises(HarborTrialAdmissionError, match="current trial proxy"):
        build_harbor_trial_config(**kwargs)


def test_trial_id_cannot_collapse_the_isolated_trial_root(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)
    unsafe_seed = dict(kwargs["trial_seed"])
    unsafe_seed["trial_id"] = "."
    kwargs["trial_seed"] = unsafe_seed

    with pytest.raises(HarborTrialAdmissionError, match="DNS label"):
        build_harbor_trial_config(**kwargs)


def test_create_harbor_trial_purges_an_unconsumed_credential_on_build_failure(
    tmp_path: Path,
) -> None:
    handle = HOST_CREDENTIAL_VAULT.store("synthetic-secret", ttl_seconds=30)
    kwargs = launch_kwargs(tmp_path)
    kwargs["credential_handle"] = handle
    kwargs["trial_proxy"] = None

    with pytest.raises(HarborTrialAdmissionError, match="current trial proxy"):
        asyncio.run(create_harbor_trial(**kwargs))

    with pytest.raises(LookupError, match="unavailable"):
        HOST_CREDENTIAL_VAULT.consume(handle)


def test_exact_public_entry_reaches_harbor_environment_factory(tmp_path: Path) -> None:
    trial = create_trial(tmp_path)
    start_trial(trial)

    assert type(trial.agent) is CortexBenchAgent
    assert type(trial.agent_environment) is AdmittedDockerEnvironment
    assert trial.config.environment.import_path == ADMISSION_ENVIRONMENT_IMPORT_PATH
    # The default campaign declares nothing, which is `open`, so the environment is PUBLIC and no
    # egress sidecar is constructed at all.
    assert trial.agent_environment.network_policy.network_mode is NetworkMode.PUBLIC
    assert trial.agent_environment.network_policy.allowed_hosts == []
    assert evidence_path(trial).is_file()


def test_a_filtered_campaign_is_born_denied_before_it_is_widened(tmp_path: Path) -> None:
    trial = create_trial(
        tmp_path, network=NetworkAccess(mode="filtered", allowlist=("example.com",)))

    # Startup is the empty allowlist: it is what builds the sidecar, and it means the container is
    # never up and unfiltered. The widening happens in `start`, against the running container.
    assert trial.agent_environment.network_policy.network_mode is NetworkMode.ALLOWLIST
    assert trial.agent_environment.network_policy.allowed_hosts == []


def test_admitted_environment_pins_the_precreated_network_as_external(tmp_path: Path) -> None:
    trial = create_trial(tmp_path)
    overlays = [json.loads(path.read_text())
                for path in trial.agent_environment._docker_compose_paths
                if path.suffix == ".json"]

    assert {"networks": {"default": {
        "external": True, "name": "trial-one__env_default",
    }}} in overlays


def test_launch_evidence_is_atomic_secret_free_and_complete(tmp_path: Path) -> None:
    os.environ["AWS_SECRET_ACCESS_KEY"] = "ambient-must-not-appear"
    try:
        trial = create_trial(tmp_path)
        start_trial(trial)
    finally:
        os.environ.pop("AWS_SECRET_ACCESS_KEY", None)

    path = evidence_path(trial)
    document = json.loads(path.read_text())
    serialized = path.read_text()
    assert document["schema_version"] == "cortex-harbor-launch-admission/1"
    assert document["trial_id"] == "trial-one"
    assert document["root_run_id"] == "trial-one.cortex-direct"
    assert document["image"] == {"reference": IMAGE_REF, "pinned": True}
    assert document["environment"]["configured_keys"] == sorted(
        trial.config.environment.env
    )
    assert "AWS_SECRET_ACCESS_KEY" not in document["environment"]["admitted_keys"]
    assert "ambient-must-not-appear" not in serialized
    assert "must-not-appear-in-launch-evidence" not in serialized
    assert list(path.parent.glob(f".{ADMISSION_EVIDENCE_FILENAME}.*")) == []


def test_launch_evidence_records_physical_harbor_mounts(tmp_path: Path) -> None:
    trial = create_trial(tmp_path)
    start_trial(trial)

    document = json.loads(evidence_path(trial).read_text())
    mounts = {entry["target"]: entry for entry in document["mounts"]}
    expected = {
        "/logs/agent": trial.paths.agent_dir.resolve(),
        "/logs/verifier": trial.paths.verifier_dir.resolve(),
        "/logs/artifacts": trial.paths.host_artifact_path(
            "main", "/logs/artifacts"
        ).resolve(),
    }
    assert set(mounts) == set(expected)
    for target, source in expected.items():
        assert "source" not in mounts[target]
        assert mounts[target]["source_sha256"] == hashlib.sha256(
            str(source).encode(),
        ).hexdigest()
        assert mounts[target]["type"] == "bind"
        assert mounts[target]["access"] == "read-write"
        assert mounts[target]["owner"] == "harbor-output-handoff"
        assert isinstance(mounts[target]["uid"], int)
        assert isinstance(mounts[target]["gid"], int)
        assert mounts[target]["source_mode"] == oct(source.stat().st_mode & 0o7777)


def test_launch_evidence_states_an_open_trial_reaches_the_internet(tmp_path: Path) -> None:
    """The default campaign declares nothing, and the evidence says so rather than the opposite.

    The two egress categories this used to assert unconditionally are the ones an open trial does
    not deny. Leaving them in would make the evidence document state the reverse of the truth.
    """
    trial = create_trial(tmp_path)
    start_trial(trial)

    network = json.loads(evidence_path(trial).read_text())["network"]

    assert network["mode"] == "open"
    assert network["default"] == "allow"
    assert network["startup_policy"] == {"network_mode": "public", "allowed_hosts": []}
    assert network["effective_policy"] == {"network_mode": "public", "allowed_hosts": []}
    assert network["denied"] == [
        "direct-provider", "host-daemon", "instance-metadata", "sibling-route",
    ]
    assert network["allowlist"]["enforcement"] == "none"
    assert network["denylist"]["enforcement"] == "none"
    # The credential route is unchanged: the key still never enters the container.
    assert {
        key: network["proxy_route"][key] for key in ("host", "scope", "trial_id")
    } == {"host": PROXY_HOST, "scope": "current-trial", "trial_id": "trial-one"}
    assert urlsplit(trial.agent.proxy_session.handle.base_url).hostname == PROXY_HOST


def test_launch_evidence_records_a_filtered_trial_as_default_deny(tmp_path: Path) -> None:
    trial = create_trial(
        tmp_path, network=NetworkAccess(mode="filtered", allowlist=("example.com",)))
    start_trial(trial)

    network = json.loads(evidence_path(trial).read_text())["network"]

    assert network["mode"] == "filtered"
    assert network["default"] == "deny"
    assert network["loopback"] == "allow"
    assert network["startup_policy"] == {"network_mode": "allowlist", "allowed_hosts": []}
    assert network["effective_policy"] == {
        "network_mode": "allowlist", "allowed_hosts": ["example.com", PROXY_HOST],
    }
    assert network["denied"] == [
        "arbitrary-egress", "direct-provider", "host-daemon", "instance-metadata",
        "public-network", "sibling-route",
    ]


def test_launch_evidence_records_the_denylist_snapshot_and_its_caveat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A denylist entry is recorded with the addresses it resolved to and what that is worth."""
    trial = create_trial(
        tmp_path, network=NetworkAccess(mode="filtered", denylist=("192.0.2.7",)))
    start_trial(trial)

    network = json.loads(evidence_path(trial).read_text())["network"]

    # A denylist-only trial runs under PUBLIC: gost stops filtering and only the address set
    # remains, so the evidence must not claim the public network is denied.
    assert network["effective_policy"]["network_mode"] == "public"
    assert "public-network" not in network["denied"]
    assert network["denylist"]["entries"] == [{
        "host": "192.0.2.7", "resolved": ["192.0.2.7"],
        "enforcement": "best-effort-dns-snapshot",
    }]
    assert "DNS rotation" in network["denylist"]["caveat"]


def test_ambient_environment_and_agent_env_mutation_fail_closed(tmp_path: Path) -> None:
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))
    config.agent.env["AWS_SECRET_ACCESS_KEY"] = "host-secret"

    with pytest.raises(HarborTrialAdmissionError, match="agent environment"):
        asyncio.run(Trial.create(config))


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("HOME", "/host/home"),
        ("ANTHROPIC_API_KEY", "reusable-provider-key"),
    ],
)
def test_exec_time_environment_cannot_override_the_sealed_values(
    tmp_path: Path, key: str, value: str,
) -> None:
    trial = create_trial(tmp_path)

    with pytest.raises(HarborTrialAdmissionError, match="process environment"):
        asyncio.run(trial.agent_environment.exec("true", env={key: value}))


def patch_image_inspect(
    monkeypatch: pytest.MonkeyPatch, image_environment: list[str],
    volumes: dict[str, object] | None = None,
) -> AsyncMock:
    result = subprocess.CompletedProcess(
        args=["docker", "image", "inspect"], returncode=0,
        stdout=json.dumps({
            "Env": image_environment, "Volumes": volumes,
        }) + "\n", stderr="",
    )
    module = importlib.import_module(
        "cortex_bench_harness.launcher.trial_admission_io",
    )
    monkeypatch.setattr(
        module, "subprocess",
        SimpleNamespace(run=lambda *args, **kwargs: result), raising=False,
    )
    start = AsyncMock()
    monkeypatch.setattr(DockerEnvironment, "start", start)
    return start


def test_container_start_rejects_unknown_image_environment_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    start = patch_image_inspect(
        monkeypatch, ["PATH=/image/path", "AWS_ACCESS_KEY_ID=ambient"],
    )

    with pytest.raises(HarborTrialAdmissionError, match="image environment"):
        asyncio.run(trial.agent_environment.start(force_build=False))
    start.assert_not_awaited()


def test_container_start_accepts_only_keys_overridden_by_the_sealed_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    start = patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    asyncio.run(trial.agent_environment.start(force_build=False))
    LIVE_PROXY_HANDLES.append(trial.agent.proxy_session.handle)

    start.assert_awaited_once_with(force_build=False)


def test_image_inspection_does_not_block_other_coroutines(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    trial = create_trial(tmp_path)
    pending_inspection = threading.Barrier(2, timeout=1)
    monkeypatch.setattr(
        trial.agent_environment, "_validate_image_configuration",
        lambda: pending_inspection.wait(),
    )

    async def start_with_peer() -> None:
        start = asyncio.create_task(trial.agent_environment.start(force_build=False))
        await asyncio.sleep(0)
        await asyncio.gather(start, asyncio.to_thread(pending_inspection.wait))

    asyncio.run(start_with_peer())
    LIVE_PROXY_HANDLES.append(trial.agent.proxy_session.handle)


@pytest.mark.parametrize(
    "destination",
    [
        "api.anthropic.com",
        "169.254.169.254",
        "host.docker.internal",
        "trial-sibling.proxy.invalid",
        "example.com",
    ],
)
def test_unrelated_network_destinations_fail_before_start(
    tmp_path: Path, destination: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A trial config that names a destination of its own is refused at the launch entry.

    Harbor would not enforce it anyway -- the task plan is PUBLIC, so `merge_extra_allowlists`
    discards extras with a warning -- but being quietly ignored and being refused are different
    guarantees, and only the second one survives someone later making the plan narrower.
    """
    kwargs = launch_kwargs(tmp_path)
    original = trial_admission.build_harbor_trial_config

    def smuggle(*args: object, **inner: object) -> object:
        config = original(*args, **inner)
        config.agent.extra_allowed_hosts.append(destination)
        return config

    monkeypatch.setattr(trial_admission, "build_harbor_trial_config", smuggle)

    with pytest.raises(HarborTrialAdmissionError, match="extra allowed hosts"):
        asyncio.run(create_harbor_trial(**kwargs))
    assert not (tmp_path / "trials/trial-one/artifacts" / ADMISSION_EVIDENCE_FILENAME).exists()


def test_a_task_that_declares_its_own_narrower_network_fails_closed(tmp_path: Path) -> None:
    # Admission is the only thing that narrows a trial's network. A task.toml that also narrowed it
    # would leave two policies steering, so it is refused rather than merged.
    task = write_task(tmp_path, network_mode="allowlist")

    with pytest.raises(HarborTrialAdmissionError, match="must be public"):
        create_trial(tmp_path, task)


def test_unsupported_container_policy_fails_closed(tmp_path: Path) -> None:
    task = write_task(tmp_path, os_name="windows")

    with pytest.raises(HarborTrialAdmissionError, match="Linux Docker"):
        create_trial(tmp_path, task)


def append_mount(config: object, source: Path, target: str, **extra: object) -> None:
    config.environment.mounts = [{
        "type": "bind", "source": str(source), "target": target, **extra,
    }]


@pytest.mark.parametrize(
    "sensitive_source",
    [Path.home(), Path.home() / ".cortex", Path(__file__).resolve().parents[4]],
)
def test_sensitive_host_mounts_fail_closed(
    tmp_path: Path, sensitive_source: Path,
) -> None:
    if not sensitive_source.exists():
        pytest.skip(f"sensitive source does not exist: {sensitive_source}")
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))
    append_mount(config, sensitive_source, "/host-sensitive", read_only=True)

    # Which of the two refusals fires depends on the HOST's environment, not on the mount. The
    # credential check runs first and matches any path overlapping a credential env var, so on a
    # desktop session where SSH_AUTH_SOCK points inside the home directory (as it does under a
    # keyring agent) the home mount is refused as a credential path instead. Both are the same
    # fail-closed outcome; pinning one message made this test pass or fail with the login session.
    with pytest.raises(
        HarborTrialAdmissionError, match="sensitive host path|host credential path",
    ):
        asyncio.run(Trial.create(config))


def test_an_unrelated_cortex_checkout_cannot_be_admitted_as_task_input(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "unrelated-cortex"
    (checkout / ".git").mkdir(parents=True)
    (checkout / "agent-server").mkdir()
    (checkout / "agent-server/package.json").write_text("{}")
    (checkout / "benchmark/harness").mkdir(parents=True)
    (checkout / "benchmark/harness/pyproject.toml").write_text("")
    task = write_task(checkout)
    config = build_harbor_trial_config(**launch_kwargs(tmp_path / "launch", task))
    append_mount(config, task, "/harbor/input", read_only=True)

    with pytest.raises(HarborTrialAdmissionError, match="sensitive host path"):
        asyncio.run(Trial.create(config))


def test_cloud_credential_mount_from_host_env_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    credential = tmp_path / "host-aws/credentials"
    credential.parent.mkdir()
    credential.write_text("not-a-real-credential")
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(credential))
    config = build_harbor_trial_config(**launch_kwargs(tmp_path / "launch"))
    append_mount(config, credential, "/credentials", read_only=True)

    with pytest.raises(HarborTrialAdmissionError, match="credential path"):
        asyncio.run(Trial.create(config))


def test_pi_auth_root_cannot_be_admitted_as_task_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    host_home = tmp_path / "host-home"
    task = write_task(host_home / ".pi")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: host_home))
    config = build_harbor_trial_config(**launch_kwargs(tmp_path / "launch", task))
    append_mount(config, task, "/harbor/input", read_only=True)

    with pytest.raises(HarborTrialAdmissionError, match="sensitive host path"):
        asyncio.run(Trial.create(config))


def test_socket_mount_fails_closed(tmp_path: Path) -> None:
    socket_path = tmp_path / "daemon.sock"
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(socket_path))
    try:
        config = build_harbor_trial_config(**launch_kwargs(tmp_path / "launch"))
        append_mount(config, socket_path, "/run/daemon.sock")
        with pytest.raises(HarborTrialAdmissionError, match="socket"):
            asyncio.run(Trial.create(config))
    finally:
        listener.close()


def test_sibling_trial_and_extra_bind_mounts_fail_closed(tmp_path: Path) -> None:
    sibling = tmp_path / "trials/trial-sibling"
    sibling.mkdir(parents=True)
    config = build_harbor_trial_config(**launch_kwargs(tmp_path / "launch"))
    append_mount(config, sibling, "/sibling", read_only=True)

    with pytest.raises(HarborTrialAdmissionError, match="extra bind"):
        asyncio.run(Trial.create(config))


def test_task_input_cannot_contain_the_trials_root(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)
    task = Path(kwargs["task_path"])
    kwargs["trials_dir"] = task / "trials"
    config = build_harbor_trial_config(**kwargs)
    append_mount(config, task, "/harbor/input", read_only=True)

    with pytest.raises(HarborTrialAdmissionError, match="sibling trial root"):
        asyncio.run(Trial.create(config))


def test_symlinked_harbor_mount_cannot_escape_the_trial_root(tmp_path: Path) -> None:
    outside = tmp_path / "outside-agent"
    outside.mkdir()
    original_mode = outside.stat().st_mode & 0o7777
    trial_dir = tmp_path / "trials/trial-one"
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))
    (trial_dir / "agent").symlink_to(outside, target_is_directory=True)

    with pytest.raises(HarborTrialAdmissionError, match="escapes trial root"):
        asyncio.run(Trial.create(config))
    assert outside.stat().st_mode & 0o7777 == original_mode


def test_task_input_mount_must_be_read_only(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)
    config = build_harbor_trial_config(**kwargs)
    append_mount(config, Path(kwargs["task_path"]), "/harbor/input")

    with pytest.raises(HarborTrialAdmissionError, match="read-only"):
        asyncio.run(Trial.create(config))


def test_read_only_task_input_mount_is_admitted(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)
    config = build_harbor_trial_config(**kwargs)
    append_mount(
        config, Path(kwargs["task_path"]), "/harbor/input", read_only=True,
    )

    trial = asyncio.run(Trial.create(config))
    trial.agent_environment.bind_proxy_controller(trial.agent)
    start_trial(trial)

    document = json.loads(evidence_path(trial).read_text())
    task_input = next(
        mount for mount in document["mounts"] if mount["target"] == "/harbor/input"
    )
    assert task_input["source_sha256"] == hashlib.sha256(
        str(Path(kwargs["task_path"]).resolve()).encode(),
    ).hexdigest()
    assert task_input["access"] == "read-only"
    assert task_input["owner"] == "harbor-task-input"


def test_mount_policy_with_unsupported_options_fails_closed(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)
    config = build_harbor_trial_config(**kwargs)
    append_mount(
        config, Path(kwargs["task_path"]), "/harbor/input",
        read_only=True, volume={"subpath": "unexpected"},
    )

    with pytest.raises(HarborTrialAdmissionError, match="mount options"):
        asyncio.run(Trial.create(config))


def test_task_compose_and_unknown_policy_fields_fail_closed(tmp_path: Path) -> None:
    task = write_task(tmp_path)
    (task / "environment/docker-compose.yaml").write_text(
        "services: {main: {network_mode: host}}\n"
    )

    with pytest.raises(HarborTrialAdmissionError, match="Docker Compose"):
        create_trial(tmp_path, task)


def test_builder_reserves_a_fresh_trial_root(tmp_path: Path) -> None:
    (tmp_path / "trials/trial-one").mkdir(parents=True)

    with pytest.raises(HarborTrialAdmissionError, match="fresh trial root"):
        build_harbor_trial_config(**launch_kwargs(tmp_path))


def test_trial_id_is_an_injective_network_label(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)
    unsafe_seed = dict(kwargs["trial_seed"])
    unsafe_seed["trial_id"] = "trial_one"
    kwargs["trial_seed"] = unsafe_seed

    with pytest.raises(HarborTrialAdmissionError, match="DNS label"):
        build_harbor_trial_config(**kwargs)


def test_docker_consumes_the_physically_resolved_mount_source(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)
    task = Path(kwargs["task_path"])
    physical = task / "input"
    physical.mkdir()
    alias = task / "input-alias"
    alias.symlink_to(physical, target_is_directory=True)
    config = build_harbor_trial_config(**kwargs)
    append_mount(config, alias, "/harbor/input", read_only=True)

    trial = asyncio.run(Trial.create(config))

    task_mount = next(
        mount for mount in trial.agent_environment._mounts
        if mount["target"] == "/harbor/input"
    )
    assert task_mount["source"] == str(physical.resolve())


def test_proxy_is_deferred_until_environment_start(tmp_path: Path) -> None:
    trial = asyncio.run(create_harbor_trial(**launch_kwargs(tmp_path)))

    assert trial.agent.proxy_session is None


def test_launch_evidence_waits_for_final_image_and_route_admission(
    tmp_path: Path,
) -> None:
    trial = asyncio.run(create_harbor_trial(**launch_kwargs(tmp_path)))

    assert not evidence_path(trial).exists()


def test_force_build_mutation_fails_before_docker_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    start = patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    with pytest.raises(HarborTrialAdmissionError, match="force_build"):
        asyncio.run(trial.agent_environment.start(force_build=True))
    start.assert_not_awaited()


def test_image_declared_volumes_fail_before_docker_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    result = subprocess.CompletedProcess(
        args=["docker", "image", "inspect"], returncode=0,
        stdout=json.dumps({
            "Env": ["PATH=/image/path", "LANG=C"],
            "Volumes": {"/host-cache": {}},
        }) + "\n", stderr="",
    )
    module = importlib.import_module(
        "cortex_bench_harness.launcher.trial_admission_io",
    )
    monkeypatch.setattr(
        module, "subprocess",
        SimpleNamespace(run=lambda *args, **kwargs: result), raising=False,
    )
    start = AsyncMock()
    monkeypatch.setattr(DockerEnvironment, "start", start)

    with pytest.raises(HarborTrialAdmissionError, match="image volumes"):
        asyncio.run(trial.agent_environment.start(force_build=False))
    start.assert_not_awaited()


def test_environment_start_failure_revokes_the_deferred_proxy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])
    monkeypatch.setattr(
        DockerEnvironment, "start", AsyncMock(side_effect=RuntimeError("start failed")),
    )

    with pytest.raises(RuntimeError, match="start failed"):
        asyncio.run(trial.agent_environment.start(force_build=False))

    session = trial.agent.proxy_session
    assert session is not None
    assert proxy_route_is_dead(session)
    assert not evidence_path(trial).exists()


def test_environment_stop_revokes_before_agent_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    stop = AsyncMock()
    monkeypatch.setattr(DockerEnvironment, "stop", stop)
    start_trial(trial)
    session = trial.agent.proxy_session

    asyncio.run(trial.agent_environment.stop(delete=True))

    stop.assert_awaited_once_with(delete=True)
    assert proxy_route_is_dead(session)


def test_a_proxy_only_allowlist_still_pins_the_route_to_its_port(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The historical shape: the proxy is the sole destination, so the port pin is correct.

    With any broader allowlist the same rule would reject the hosts the campaign asked to reach,
    so it is installed only for this one configuration.
    """
    trial = create_trial(tmp_path, network=NetworkAccess(mode="filtered", allowlist=()))
    patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    asyncio.run(trial.agent_environment.start(force_build=False))

    LIVE_PROXY_HANDLES.append(trial.agent.proxy_session.handle)
    port = urlsplit(trial.agent.proxy_session.handle.base_url).port
    route = json.loads(evidence_path(trial).read_text())["network"]["proxy_route"]
    assert route["enforcement"] == {
        "host": "harbor-allowlist", "port": "marked-egress-nftables",
    }
    trial.agent_environment._install_proxy_endpoint_filter.assert_awaited_once_with(port)


def test_a_broader_allowlist_does_not_pin_the_route_port(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(
        tmp_path, network=NetworkAccess(mode="filtered", allowlist=("example.com",)))
    patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    asyncio.run(trial.agent_environment.start(force_build=False))

    LIVE_PROXY_HANDLES.append(trial.agent.proxy_session.handle)
    route = json.loads(evidence_path(trial).read_text())["network"]["proxy_route"]
    assert route["enforcement"] == {"host": "harbor-allowlist", "port": "none"}
    trial.agent_environment._install_proxy_endpoint_filter.assert_not_awaited()


def test_launch_evidence_records_the_actual_proxy_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])

    asyncio.run(trial.agent_environment.start(force_build=False))

    session = trial.agent.proxy_session
    LIVE_PROXY_HANDLES.append(session.handle)
    route = json.loads(evidence_path(trial).read_text())["network"]["proxy_route"]
    parsed = urlsplit(session.handle.base_url)
    assert route["scheme"] == parsed.scheme
    assert route["host"] == parsed.hostname
    assert route["port"] == parsed.port
    # This trial is `open`, so nothing constrains the route and the evidence says so. The port pin
    # is not installed either -- there is no sidecar to install it in.
    assert route["enforcement"] == {"host": "none", "port": "none"}
    trial.agent_environment._install_proxy_endpoint_filter.assert_not_awaited()
    assert route["bound_source_ip"] == (
        session.handle.manifest_block["source_binding"]["value"]
    )
    assert route["bound_source_ip"] == (
        trial.agent_environment._admission_contract["container_ipv4"]
    )


def test_a_route_bound_to_another_address_than_the_container_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A route bound to an address no container holds would answer nobody, silently.

    The container is configured with one address and the route accepts one address; if the two
    ever drift, the trial is refused rather than run against a route that cannot be reached.
    """
    trial = create_trial(tmp_path)
    patch_image_inspect(monkeypatch, ["PATH=/image/path", "LANG=C"])
    trial.agent_environment._admission_contract["container_ipv4"] = "172.30.99.2"

    with pytest.raises(HarborTrialAdmissionError, match="admitted container address"):
        asyncio.run(trial.agent_environment.start(force_build=False))

    assert not evidence_path(trial).exists()


def test_separate_verifier_environment_is_rejected_before_launch(
    tmp_path: Path,
) -> None:
    task = write_task(tmp_path)
    with (task / "task.toml").open("a") as handle:
        handle.write("\n[verifier]\nenvironment_mode = \"separate\"\n")

    with pytest.raises(HarborTrialAdmissionError, match="separate verifier"):
        asyncio.run(create_harbor_trial(**launch_kwargs(tmp_path, task)))


@pytest.mark.parametrize("network,sidecar", [
    (None, False),
    (NetworkAccess(mode="filtered"), True),
    (NetworkAccess(mode="filtered", allowlist=("example.com",)), True),
    (NetworkAccess(mode="filtered", denylist=("192.0.2.1",)), True),
])
def test_the_egress_sidecar_exists_only_when_something_is_being_filtered(
    tmp_path: Path, network: NetworkAccess | None, sidecar: bool,
) -> None:
    """Whether a trial can reach the internet is decided by whether this file is passed.

    The sidecar service is defined only in Harbor's egress-control compose file, and Harbor
    appends that file only when some policy is not PUBLIC. So under `open` there is no sidecar to
    filter with, `main` keeps its own namespace, and the container is on the network Docker gives
    it. This is the whole mechanism behind `mode: open`, asserted rather than assumed.
    """
    trial = create_trial(tmp_path, network=network)
    environment = trial.agent_environment

    names = [path.name for path in environment._docker_compose_paths]

    assert ("docker-compose-egress-control.yaml" in names) is sidecar
    assert environment._enable_egress_control is sidecar
    assert environment._network_namespace_service() == (
        "harbor-docker-egress-control-sidecar" if sidecar else "main")
