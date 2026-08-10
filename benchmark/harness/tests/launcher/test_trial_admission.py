# input:  public Harbor trial builder, local synthetic task, hostile host inputs
# output: construction, refusals, concurrency and launch evidence
# pos:    Synthetic proof for the production Harbor admission boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
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
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import NetworkMode
from harbor.trial.trial import Trial

from capability_admission import admit_capability
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    ADMISSION_ENVIRONMENT_IMPORT_PATH,
    AdmittedDockerEnvironment,
    HarborTrialAdmissionError,
    build_harbor_trial_config,
    create_harbor_trial,
)

DIGEST = f"sha256:{'a' * 64}"
IMAGE_REF = f"registry.invalid/task@{DIGEST}"
PROXY_HOST = "trial-one.proxy.invalid"
PROXY_URL = f"http://{PROXY_HOST}:4317"
EXPECTED_ENVIRONMENT = {
    "CLAUDE_CONFIG_DIR": "/logs/agent/trial-home/claude-config",
    "CORTEX_BENCH_BACKEND": "claude",
    "CORTEX_BENCH_DEADLINE_SECONDS": "90",
    "CORTEX_BENCH_ROOT_RUN_ID": "trial-one.cortex-direct",
    "CORTEX_BENCH_TRIAL_ID": "trial-one",
    "CORTEX_HOME": "/logs/agent/trial-home/cortex-home",
    "CORTEX_PROJECTS_DIR": "/logs/agent/trial-home/projects",
    "HOME": "/logs/agent/trial-home/home",
    "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
    "PATH": "/installed-agent/npm/bin:/usr/local/bin:/usr/bin:/bin",
    "TEMP": "/logs/agent/trial-home/tmp", "TMP": "/logs/agent/trial-home/tmp",
    "TMPDIR": "/logs/agent/trial-home/tmp", "TZ": "UTC",
    "XDG_CACHE_HOME": "/logs/agent/trial-home/xdg-cache",
    "XDG_CONFIG_HOME": "/logs/agent/trial-home/xdg-config",
}
LIVE_PROXY_HANDLES: list[object] = []


@pytest.fixture(autouse=True)
def admitted_fake_proxy(monkeypatch: pytest.MonkeyPatch):
    admit_capability(monkeypatch, "claude-api-key")
    monkeypatch.setenv("CORTEX_BENCH_TEST_CREDENTIAL", "fake-host-credential")
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
    yield
    for handle in LIVE_PROXY_HANDLES:
        handle.stop()
    LIVE_PROXY_HANDLES.clear()


def write_task(
    root: Path, *, network_mode: str = "allowlist",
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
        "backend": "claude",
        "provider": "anthropic",
        "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0,
            "max_parent_questions": 0,
            "max_task_depth": 0,
            "max_tasks": 0,
            "max_provider_requests": 8,
            "max_resident_agent_processes": 1,
            "max_cost_usd": "2.50",
            "deadline_seconds": 90,
        },
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


def launch_kwargs(root: Path, task: Path | None = None) -> dict[str, object]:
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
        "cli_version": "2026.8.10",
        "trial_proxy": trial_proxy_spec(),
    }


def create_trial(root: Path, task: Path | None = None) -> Trial:
    trial = asyncio.run(create_harbor_trial(**launch_kwargs(root, task)))
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


def test_public_entry_builds_the_sealed_trial_config(tmp_path: Path) -> None:
    kwargs = launch_kwargs(tmp_path)

    config = build_harbor_trial_config(**kwargs)

    assert config.trial_name == "trial-one"
    assert config.task.path == Path(kwargs["task_path"]).resolve()
    assert config.environment.import_path == ADMISSION_ENVIRONMENT_IMPORT_PATH
    assert config.environment.type is None
    assert config.environment.mounts is None
    assert config.environment.extra_allowed_hosts == []
    assert config.agent.extra_allowed_hosts == [PROXY_HOST]
    assert config.agent.env == config.environment.env
    assert config.agent.env == EXPECTED_ENVIRONMENT


def trial_proxy_spec(**overrides: object) -> dict[str, object]:
    return {
        "credential_env": "CORTEX_BENCH_TEST_CREDENTIAL",
        "bound_source_ip": "172.19.0.2",
        "max_request_cost_usd": "1.00",
        "input_cost_per_million_usd": "3",
        "output_cost_per_million_usd": "15",
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


def test_exact_public_entry_reaches_harbor_environment_factory(tmp_path: Path) -> None:
    trial = create_trial(tmp_path)
    start_trial(trial)

    assert type(trial.agent) is CortexBenchAgent
    assert type(trial.agent_environment) is AdmittedDockerEnvironment
    assert trial.config.environment.import_path == ADMISSION_ENVIRONMENT_IMPORT_PATH
    assert trial.agent_environment.network_policy.network_mode is NetworkMode.ALLOWLIST
    assert trial.agent_environment.network_policy.allowed_hosts == []
    assert evidence_path(trial).is_file()


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
        assert mounts[target]["source"] == str(source)
        assert mounts[target]["type"] == "bind"
        assert mounts[target]["access"] == "read-write"
        assert mounts[target]["owner"] == "harbor-output-handoff"
        assert isinstance(mounts[target]["uid"], int)
        assert isinstance(mounts[target]["gid"], int)
        assert mounts[target]["source_mode"] == oct(source.stat().st_mode & 0o7777)


def test_launch_evidence_records_default_deny_proxy_only_network(tmp_path: Path) -> None:
    trial = create_trial(tmp_path)
    start_trial(trial)

    network = json.loads(evidence_path(trial).read_text())["network"]
    phase_hosts = {
        host for phase in network["phase_policies"] for host in phase["allowed_hosts"]
    }
    assert network["default"] == "deny"
    assert network["loopback"] == "allow"
    assert network["startup_policy"] == {
        "network_mode": "allowlist",
        "allowed_hosts": [],
    }
    assert phase_hosts == {PROXY_HOST}
    assert {
        key: network["proxy_route"][key]
        for key in ("host", "scope", "trial_id")
    } == {
        "host": PROXY_HOST,
        "scope": "current-trial",
        "trial_id": "trial-one",
    }
    assert urlsplit(trial.agent.proxy_session.handle.base_url).hostname == PROXY_HOST
    assert network["denied"] == [
        "arbitrary-egress",
        "direct-provider",
        "host-daemon",
        "instance-metadata",
        "public-network",
        "sibling-route",
    ]


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


def test_image_inspection_does_not_block_other_coroutines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial = create_trial(tmp_path)
    inspect_started = threading.Event()
    inspect_release = threading.Event()
    released_while_pending: list[bool] = []
    result = subprocess.CompletedProcess(
        args=["docker", "image", "inspect"], returncode=0,
        stdout=json.dumps({
            "Env": ["PATH=/image/path", "LANG=C"], "Volumes": None,
        }) + "\n", stderr="",
    )

    def pending_inspect(*args: object, **kwargs: object) -> object:
        inspect_started.set()
        released_while_pending.append(inspect_release.wait(timeout=1))
        return result

    module = importlib.import_module(
        "cortex_bench_harness.launcher.trial_admission_io",
    )
    monkeypatch.setattr(
        module, "subprocess", SimpleNamespace(run=pending_inspect), raising=False,
    )
    start = AsyncMock()
    monkeypatch.setattr(DockerEnvironment, "start", start)

    async def progress_peer() -> None:
        while not inspect_started.is_set():
            await asyncio.sleep(0)
        inspect_release.set()

    async def start_with_peer() -> None:
        await asyncio.gather(
            trial.agent_environment.start(force_build=False), progress_peer(),
        )

    asyncio.run(start_with_peer())
    LIVE_PROXY_HANDLES.append(trial.agent.proxy_session.handle)

    assert released_while_pending == [True]
    start.assert_awaited_once_with(force_build=False)


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
    tmp_path: Path, destination: str,
) -> None:
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))
    config.agent.extra_allowed_hosts.append(destination)

    with pytest.raises(HarborTrialAdmissionError, match="network allowlist"):
        asyncio.run(Trial.create(config))
    assert not (tmp_path / "trials/trial-one/artifacts" / ADMISSION_EVIDENCE_FILENAME).exists()


def test_public_harbor_network_mode_fails_closed(tmp_path: Path) -> None:
    task = write_task(tmp_path, network_mode="public")

    with pytest.raises(HarborTrialAdmissionError, match="default-deny"):
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

    with pytest.raises(HarborTrialAdmissionError, match="sensitive host path"):
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
    assert task_input["source"] == str(Path(kwargs["task_path"]).resolve())
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
    assert route["bound_source_ip"] == (
        session.handle.manifest_block["source_binding"]["value"]
    )


def test_separate_verifier_environment_is_rejected_before_launch(
    tmp_path: Path,
) -> None:
    task = write_task(tmp_path)
    with (task / "task.toml").open("a") as handle:
        handle.write("\n[verifier]\nenvironment_mode = \"separate\"\n")

    with pytest.raises(HarborTrialAdmissionError, match="separate verifier"):
        asyncio.run(create_harbor_trial(**launch_kwargs(tmp_path, task)))
