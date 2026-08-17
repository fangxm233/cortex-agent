# input:  npm artifact, Docker environment, production matrix seeds
# output: pull-disabled arm matrix, sealed non-root server and artifact proof
# pos:    Opt-in container proof for the installed Harbor path
# >>> If I am updated, update my header and folder CORTEX.md <<<

from docker_gate import require_docker_opt_in

require_docker_opt_in()

import asyncio
import hashlib
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any, override

import pytest
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths

from cortex_bench_harness import CortexBenchAgent
from cortex_bench_harness.inner_validation import valid_composite_structure
from cortex_bench_harness.launcher.production_home import (
    DirectArmLaunchFacts,
    materialize_direct_arm_home,
)
from cortex_bench_harness.launcher.production_session import (
    InstalledProductionServer,
    ProductionServerSession,
    ProductionSessionSpec,
)
from cortex_bench_harness.launcher.trial_admission_io import (
    PullDisabledDockerEnvironment,
)
from offline_package import build_offline_npm_artifact

IMAGE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
IMAGE_REF = f"debian@{IMAGE_DIGEST}"
AGENT_USER = "cortex-agent"
MINIMUM_FREE_BYTES = 10 * 1024**3
REPO_ROOT = Path(__file__).resolve().parents[4]
CODER_REVIEW_VARIANTS = ("audit-retry", "reviewer-fix")
PRODUCTION_ROWS = (
    *((backend, "direct", None) for backend in ("claude", "pi")),
    *((backend, "coder-review", variant)
      for backend in ("claude", "pi") for variant in CODER_REVIEW_VARIANTS),
    *((backend, "manager", ask_manager)
      for backend in ("claude", "pi") for ask_manager in (False, True)),
)
POLICY_PATH = "/logs/agent/benchmark-thread-policy.json"


def row_suffix(backend: str, mode: str, detail: str | bool | None) -> str:
    if mode == "manager":
        detail = "qa-on" if detail is True else "qa-off"
    return "-".join(str(part) for part in (backend, mode, detail) if part is not None)


class RunTrackingAgent(CortexBenchAgent):
    run_called = False

    @override
    async def run(
        self, instruction: str, environment: DockerEnvironment, context: AgentContext,
    ) -> None:
        self.run_called = True


def require_local_docker_image() -> dict[str, object]:
    free_bytes = shutil.disk_usage("/").free
    assert free_bytes >= MINIMUM_FREE_BYTES, (
        f"Docker disk gate failed: {free_bytes} < {MINIMUM_FREE_BYTES}"
    )
    result = subprocess.run(
        ["docker", "image", "inspect", IMAGE_REF], check=True,
        capture_output=True, text=True,
    )
    image = json.loads(result.stdout)[0]
    return {"image_ref": IMAGE_REF, "image_digest": IMAGE_DIGEST,
            "image_size_bytes": image["Size"]}


def build_node_runtime(root: Path) -> Path:
    node = Path(shutil.which("node") or "").resolve()
    npm = Path(shutil.which("npm") or "").resolve()
    assert node.is_file(), "node is required to exercise the npm install path"
    assert npm.is_file(), "npm is required to exercise the npm install path"
    runtime = root / "node-runtime"
    (runtime / "bin").mkdir(parents=True)
    shutil.copy2(node, runtime / "bin/node")
    shutil.copytree(npm.parents[1], runtime / "lib/node_modules/npm", symlinks=True)
    (runtime / "bin/npm").symlink_to("../lib/node_modules/npm/bin/npm-cli.js")
    return runtime


def create_environment(
    root: Path, node_runtime: Path, suffix: str,
) -> PullDisabledDockerEnvironment:
    trial_paths = TrialPaths(root / "trial")
    trial_paths.mkdir()
    environment_dir = root / "environment"
    environment_dir.mkdir()
    task_root = root / "task-root"
    task_root.mkdir(mode=0o755)
    task_root.chmod(0o777)
    agent_root = root / "trial/agent"
    agent_root.chmod(0o777)
    mounts: list[ServiceVolumeConfig] = [
        {"type": "bind", "source": str(task_root), "target": "/app"},
        {"type": "bind", "source": str(agent_root), "target": "/logs/agent"},
        {"type": "bind", "source": str(node_runtime), "target": "/opt/node",
         "read_only": True},
    ]
    return PullDisabledDockerEnvironment(
        environment_dir=environment_dir, environment_name=f"cortex-install-{suffix}",
        session_id=f"cortex-install-{suffix}-{os.getpid()}", trial_paths=trial_paths,
        task_env_config=EnvironmentConfig(docker_image=IMAGE_REF, workdir="/app"),
        mounts=mounts,
    )


def production_direct_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "cortex-direct", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0,
            "max_task_depth": 0, "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 90, "max_output_tokens": 65536,
        },
    }


def trial_seed(image: dict[str, object], suffix: str) -> dict[str, object]:
    return {
        "arm": {
            "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
            "name": "cortex-direct", "backend": "claude", "provider": "anthropic",
            "model": "claude-sonnet", "credential_capability": "claude-api-key",
            "orchestration": {"mode": "direct", "ask_manager": False},
            "limits": {
                "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
                "max_tasks": 0, "max_provider_requests": 8,
                "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
                "deadline_seconds": 90,
            },
        },
        "arm_path": "arm://cortex-direct", "trial_id": f"trial-{suffix}",
        "root_run_id": f"root-{suffix}",
        "task": {"task_id": f"task-{suffix}", "image_ref": str(image["image_ref"]),
                 "image_digest": str(image["image_digest"])},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {"upstream_base_url": "https://api.anthropic.com",
                       "route_identity_host": "api.anthropic.com",
                       "proxy_base_url": "http://trial-proxy.invalid",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": None,
    }


def create_agent(
    agent_type: type[CortexBenchAgent], root: Path, artifact: Path,
    image: dict[str, object], suffix: str,
) -> CortexBenchAgent:
    wheel = root / "cortex_bench_harness-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"harness wheel fixture")
    return agent_type(
        logs_dir=root / "trial/agent", artifact_dir=root / "trial/artifacts",
        manifest={
            "root_run_id": f"root-{suffix}", "trial_id": f"trial-{suffix}",
            "arm": "cortex-direct", "wheel_path": str(wheel),
            "lockfile_path": str(REPO_ROOT / "benchmark/harness/uv.lock"),
            "lockfile_manifest_path": "benchmark/harness/uv.lock",
            "npm_artifact_path": str(artifact), **image,
        },
        trial_seed=trial_seed(image, suffix),
    )


def s1_seed(
    image: dict[str, object], suffix: str, backend: str,
    mode: str, detail: str | bool | None,
) -> dict[str, object]:
    seed = trial_seed(image, suffix)
    arm = dict(seed["arm"])
    arm.update({"name": f"cortex-{suffix}", "backend": backend})
    limits = dict(arm["limits"])
    if mode == "coder-review":
        arm["orchestration"] = {
            "mode": mode, "coder_review_variant": detail, "ask_manager": False,
        }
        limits.update(max_thread_starts=1, max_resident_agent_processes=3)
    elif mode == "manager":
        arm["orchestration"] = {"mode": mode, "ask_manager": detail is True}
        limits.update(
            max_thread_starts=1, max_parent_questions=2 if detail is True else 0,
            max_task_depth=3, max_tasks=12, max_provider_requests=16,
            max_resident_agent_processes=4,
        )
    arm["limits"] = limits
    seed.update({"arm": arm, "arm_path": f"arm://{arm['name']}"})
    if backend == "pi":
        seed["pi_benchmark_capability_proven"] = True
    return seed


def create_s1_agent(
    root: Path, artifact: Path, image: dict[str, object],
    backend: str, mode: str, detail: str | bool | None,
) -> CortexBenchAgent:
    suffix = row_suffix(backend, mode, detail)
    wheel = root / "cortex_bench_harness-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"harness wheel fixture")
    seed = s1_seed(image, suffix, backend, mode, detail)
    return CortexBenchAgent(
        logs_dir=root / "trial/agent", artifact_dir=root / "trial/artifacts",
        manifest={
            "root_run_id": f"root-{suffix}", "trial_id": f"trial-{suffix}",
            "arm": seed["arm"]["name"], "wheel_path": str(wheel),
            "lockfile_path": str(REPO_ROOT / "benchmark/harness/uv.lock"),
            "lockfile_manifest_path": "benchmark/harness/uv.lock",
            "npm_artifact_path": str(artifact), **image,
        },
        trial_seed=seed,
    )


async def provision_agent_user(environment: DockerEnvironment) -> None:
    # The Debian image ships no backend CLI, so stand one in for the setup-time
    # path/version probe the production adapter performs before it composes.
    command = (
        "printf 'update-notifier=false\\n' > /etc/npmrc"
        " && ln -s /opt/node/bin/node /usr/local/bin/node"
        " && ln -s /opt/node/bin/npm /usr/local/bin/npm"
        f" && useradd --create-home --shell /bin/bash {AGENT_USER}"
        f" && printf 'update-notifier=false\\n' > /home/{AGENT_USER}/.npmrc"
        f" && chown {AGENT_USER}:{AGENT_USER} /home/{AGENT_USER}/.npmrc"
        " && printf '#!/bin/sh\\necho \"1.2.3 (Claude Code)\"\\n' > /usr/local/bin/claude"
        " && chmod +x /usr/local/bin/claude"
    )
    result = await environment.exec(command=command, user="root")
    assert result.return_code == 0, result.stderr


async def provision_s1_agent_user(
    environment: DockerEnvironment, backend: str,
    mode: str, detail: str | bool | None,
) -> None:
    script = "fake-pi.mjs" if backend == "pi" else "fake-claude.mjs"
    observation = ""
    if mode == "manager":
        observation = f" --observation /app/manager-observation-{'qa-on' if detail else 'qa-off'}.json"
    command = (
        "printf 'update-notifier=false\\n' > /etc/npmrc"
        " && ln -s /opt/node/bin/node /usr/local/bin/node"
        " && ln -s /opt/node/bin/npm /usr/local/bin/npm"
        f" && useradd --create-home --shell /bin/bash {AGENT_USER}"
        f" && printf 'update-notifier=false\\n' > /home/{AGENT_USER}/.npmrc"
        f" && chown {AGENT_USER}:{AGENT_USER} /home/{AGENT_USER}/.npmrc"
        f" && printf '#!/bin/sh\\nexec /opt/node/bin/node /app/{script}{observation} \"$@\"\\n'"
        f" > /usr/local/bin/{backend} && chmod +x /usr/local/bin/{backend}"
    )
    result = await environment.exec(command=command, user="root")
    assert result.return_code == 0, result.stderr


def write_fake_s1_cli(
    task_root: Path, backend: str, mode: str,
) -> Path:
    if mode == "manager":
        name = f"fake-manager-{backend}.mjs"
        source = REPO_ROOT / "agent-server/tests/domain/agent-run" / name
    else:
        name = "fake_pi_mcp_cli.mjs" if backend == "pi" else "fake_claude_mcp_cli.mjs"
        source = Path(__file__).with_name(name)
    script = task_root / ("fake-pi.mjs" if backend == "pi" else "fake-claude.mjs")
    shutil.copy2(source, script)
    return script


async def assert_fresh_container(environment: DockerEnvironment) -> None:
    with environment.with_default_user(AGENT_USER):
        identity = await environment.exec(command="id -un")
        missing = await environment.exec(command="command -v cortex")
    assert identity.stdout.strip() == AGENT_USER
    assert missing.return_code != 0


async def assert_installed_bundle(environment: DockerEnvironment) -> None:
    commands = [
        "command -v cortex >/dev/null 2>&1",
        "cortex agent-run --help >/dev/null",
        "package_root=\"$(npm ls --global --parseable --depth=0 "
        "--prefix /installed-agent/npm @cortex-agent/server)\""
        " && test -x \"$package_root/native/cortex-supervisor/dist/cortex-supervisor\"",
        "package_root=\"$(npm ls --global --parseable --depth=0 "
        "--prefix /installed-agent/npm @cortex-agent/server)\""
        " && cd \"$package_root\""
        " && node --input-type=module --eval \"import('@sinclair/typebox')\"",
    ]
    with environment.with_default_user(AGENT_USER):
        for command in commands:
            result = await environment.exec(command=command)
            assert result.return_code == 0, f"{command}\n{result.stderr}"


def assert_manifest_hash(root: Path, artifact: Path) -> None:
    manifest_path = root / "trial/artifacts/cortex-bench-harness-manifest.json"
    document = json.loads(manifest_path.read_text())
    expected = hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert document["cortex_npm_artifact"] == {
        "filename": artifact.name, "sha256": expected,
    }


async def run_positive_path(
    root: Path, node_runtime: Path, artifact: Path, image: dict[str, object],
) -> None:
    environment = create_environment(root, node_runtime, "positive")
    try:
        await environment.start(force_build=False)
        await provision_agent_user(environment)
        await assert_fresh_container(environment)
        agent = create_agent(CortexBenchAgent, root, artifact, image, "positive")
        with environment.with_default_user(AGENT_USER):
            await agent.setup(environment)
        await assert_installed_bundle(environment)
        assert_manifest_hash(root, artifact)
    finally:
        await environment.stop(delete=True)


async def run_production_boot_path(
    root: Path, node_runtime: Path, artifact: Path, image: dict[str, object],
) -> None:
    environment = create_environment(root, node_runtime, "production-boot")
    assert isinstance(environment, PullDisabledDockerEnvironment)
    session: ProductionServerSession | None = None
    pid: int | None = None
    try:
        await environment.start(force_build=False)
        await provision_agent_user(environment)
        await assert_fresh_container(environment)
        agent = create_agent(CortexBenchAgent, root, artifact, image, "production-boot")
        with environment.with_default_user(AGENT_USER):
            await agent.setup(environment)
        materialized = materialize_direct_arm_home(
            cortex_home=root / "trial/agent/production-cortex-home",
            runtime_cortex_home=Path("/logs/agent/production-cortex-home"),
            artifacts_dir=root / "trial/artifacts",
            facts=DirectArmLaunchFacts(
                trial_id="trial-production-boot", root_run_id="root-production-boot",
                npm_artifact=artifact, backend_cli_version="pi-fixture-1",
                proxy_base_url="http://trial-production-boot.proxy.invalid:49152",
                dummy_token_ref="offline-token-handle",
                model_alias_policy={"policy": "exact"},
            ),
            inherited_environment={
                "PATH": "/usr/local/bin:/opt/node/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
            },
        )
        config_before = {
            path.relative_to(materialized.cortex_home / "config").as_posix(): path.read_bytes()
            for path in sorted((materialized.cortex_home / "config").rglob("*"))
            if path.is_file()
        }
        ownership = await environment.exec(
            command="chown -R cortex-agent:cortex-agent /logs/agent/production-cortex-home",
            user="root",
        )
        assert ownership.return_code == 0, ownership.stderr
        session = ProductionServerSession(ProductionSessionSpec(
            logs_dir=root / "trial/agent",
            container_logs_dir=PurePosixPath("/logs/agent"), workspace_cwd="/app",
            arm=production_direct_arm(), trial_id="trial-production-boot",
            root_run_id="root-production-boot", materialized_home=materialized,
            installed=InstalledProductionServer(
                bundle_root=PurePosixPath(
                    "/installed-agent/npm/lib/node_modules/@cortex-agent/server"),
                backend_cli_path=PurePosixPath("/usr/local/bin/pi"),
                backend_cli_version="pi-fixture-1",
            ),
        ), poll_interval_seconds=0.05, readiness_timeout_seconds=30)

        async def execute(command: str, **kwargs: Any) -> Any:
            with environment.with_default_user(AGENT_USER):
                return await environment.exec(command=command, **kwargs)

        identity = await execute("id -u")
        assert int(identity.stdout.strip()) > 0
        pid = await session._start_server(execute)
        owner = await execute(f"stat -c %u /proc/{pid}")
        assert int(owner.stdout.strip()) > 0
        await session._wait_until_ready(execute)
        process_environment = await execute(f"cat /proc/{pid}/environ")
        assert "CORTEX_CLIENT_TOKEN" not in process_environment.stdout
        assert "CORTEX_WEBHOOK_TOKEN" not in process_environment.stdout
        assert materialized.client_token not in process_environment.stdout
        assert materialized.webhook_token not in process_environment.stdout
        assert not (root / "trial/agent/production-server-auth.json").exists()
        config_after = {
            path.relative_to(materialized.cortex_home / "config").as_posix(): path.read_bytes()
            for path in sorted((materialized.cortex_home / "config").rglob("*"))
            if path.is_file()
        }
        assert config_after == config_before
    finally:
        if pid is not None and session is not None:
            await session._stop_server(pid, execute)
            session._remove_temporary_files()
        await environment.stop(delete=True)


async def run_negative_path(
    root: Path, node_runtime: Path, image: dict[str, object],
) -> None:
    root.mkdir()
    corrupt = root / "corrupt-cortex.tgz"
    corrupt.write_bytes(b"not an npm tarball")
    environment = create_environment(root, node_runtime, "negative")
    agent = create_agent(RunTrackingAgent, root, corrupt, image, "negative")
    try:
        await environment.start(force_build=False)
        await provision_agent_user(environment)
        await assert_fresh_container(environment)
        with environment.with_default_user(AGENT_USER):
            with pytest.raises(NonZeroAgentExitCodeError):
                await agent.setup(environment)
                await agent.run("must not run", environment, AgentContext())
        assert not agent.run_called
        assert not (root / "trial/artifacts/cortex-bench-harness-manifest.json").exists()
    finally:
        await environment.stop(delete=True)


def assert_production_agent(agent: CortexBenchAgent) -> None:
    assert type(agent) is CortexBenchAgent
    for method in ("setup", "run", "preview_run_argv", "_compose_arm_resolution"):
        assert getattr(agent, method).__func__ is getattr(CortexBenchAgent, method)


def assert_coder_review_observation(
    observation: dict[str, object], backend: str, variant: str | None,
) -> None:
    assert observation["strictMcpConfig"] is True
    assert observation["policyPath"] == POLICY_PATH
    assert observation["policyWritableBits"] == 0
    assert observation["policyTemplate"] == (
        "benchmark-coder-review" if variant == "audit-retry"
        else "benchmark-coder-review-fix"
    )
    assert observation["registered"] == ["thread_run"]
    if backend == "claude":
        assert observation["mcpConfigPaths"] == [
            "/logs/agent/mcp-config-benchmark-thread.json",
        ]
    else:
        assert str(observation["bridgePath"]).startswith(
            "/installed-agent/npm/lib/node_modules/@cortex-agent/server/dist/"
        )


def assert_manager_observation(
    root: Path, backend: str, ask_manager: bool,
) -> None:
    label = "qa-on" if ask_manager else "qa-off"
    records = read_json(root / f"task-root/manager-observation-{label}.json")
    roles = [record["role"] for record in records]
    assert {"parent", "manager", "coder", "reviewer"}.issubset(roles)
    assert roles.count("parent") == (2 if ask_manager else 1)
    assert all(record["cwd"] == "/app" for record in records if record["role"] != "reviewer")
    assert all(record["args"] for record in records)
    assert backend in {"claude", "pi"}


def assert_s1_observation(
    root: Path, resolution_bytes: bytes, backend: str,
    mode: str, detail: str | bool | None,
) -> None:
    if mode == "manager":
        assert_manager_observation(root, backend, detail is True)
        return
    resolution = json.loads(resolution_bytes)
    observation = read_json(root / "task-root/s1-backend-observation.json")
    assert observation["backend"] == backend
    assert observation["mode"] == mode
    assert observation["variant"] == detail
    assert observation["armName"] == resolution["arm"]["name"]
    assert observation["runConfigPath"] == "/logs/agent/arm-resolution.json"
    assert observation["runConfigSha256"] == hashlib.sha256(resolution_bytes).hexdigest()
    assert observation["cwd"] == "/app"
    assert observation["tools"] == resolution["roles"]["parent"]["tools"]
    if mode == "direct":
        assert observation["policyPath"] is None
        assert observation["policyTemplate"] is None
        assert "thread_run" not in observation["registered"]
        assert observation["mcpConfigPaths"] == []
        return
    assert_coder_review_observation(observation, backend, str(detail))


async def assert_s1_terminal(
    environment: DockerEnvironment, suffix: str, mode: str,
) -> None:
    terminal_path = f"/logs/agent/trajectory/run-root-{suffix}.terminal.json"
    composite_path = "/logs/agent/trajectory/composite-manifest.json"
    child_terminals = "/logs/agent/trajectory/thread-*.terminal.json"
    with environment.with_default_user(AGENT_USER):
        result = await environment.exec(command=f"cat {shlex.quote(terminal_path)}")
        composite = await environment.exec(command=f"test -f {composite_path}")
        child_count = {
            "direct": "test ! -e \"$1\"",
            "coder-review": "test -e \"$1\" && test \"$#\" -eq 1",
            "manager": "test -e \"$1\" && test \"$#\" -ge 3",
        }[mode]
        child = await environment.exec(command=f"set -- {child_terminals}; {child_count}")
    assert result.return_code == 0, result.stderr
    terminal = json.loads(result.stdout)
    assert (terminal["state"], terminal["terminal_reason"]) == ("completed", "ok")
    assert terminal["supervisor"] == {"quiescent": True, "descendants": 0}
    assert child.return_code == 0
    assert composite.return_code == 0


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def assert_attempt_files(trajectory: Path, node: dict[str, object]) -> None:
    for path_key, hash_key in (
        ("journal_path", "journal_sha256"),
        ("terminal_manifest_path", "terminal_manifest_sha256"),
    ):
        relative = node[path_key]
        assert isinstance(relative, str)
        data = (trajectory / relative).read_bytes()
        assert hashlib.sha256(data).hexdigest() == node[hash_key]


def assert_matrix_accounting(
    composite: dict[str, object], backend: str,
) -> None:
    journal = composite["accounting"]["journal"]
    proxy = composite["accounting"]["proxy"]
    assert proxy["requests"] == {"status": "unavailable", "reason": "counter_unreadable"}
    if backend == "pi":
        assert journal["steps"] == {"status": "unavailable", "reason": "journal_underivable"}
        assert journal["tokens"]["input"]["status"] == "unavailable"
        return
    turns = sum(node["steps"] for node in composite["nodes"])
    assert journal["steps"] == {"status": "available", "value": turns}
    assert journal["tokens"]["input"] == {"status": "available", "value": turns * 3}
    assert journal["tokens"]["output"] == {"status": "available", "value": turns * 2}


def assert_coder_review_artifacts(
    root: Path, trajectory: Path, composite: dict[str, object],
    backend: str, variant: str,
) -> None:
    nodes = composite["nodes"]
    child = next(node for node in nodes if node["thread_id"] is not None)
    assert child["artifact_path"] is not None
    artifact = trajectory / child["artifact_path"]
    assert hashlib.sha256(artifact.read_bytes()).hexdigest() == child["artifact_sha256"]
    roles = {
        json.loads(line)["agent_slot"]
        for line in (trajectory / child["journal_path"]).read_text().splitlines()[1:]
    }
    verdict_role = "benchmark-reviewer" if variant == "audit-retry" else "benchmark-fixer"
    assert {"benchmark-coder", verdict_role}.issubset(roles)
    assert not (root / "trial/agent/trial-home/tmp/review-snapshot").exists()
    assert not any((root / "trial/agent/trial-home/workspaces").rglob("artifact.md"))
    state = read_json(root / "task-root/matrix-workspace-state.json")
    assert child["steps"] == (4 if variant == "audit-retry" else 2)
    assert state["final"] == ("retried" if variant == "audit-retry" else "fixed")
    if backend == "pi":
        assert state["coderLease"] == "thread-owned"
        if variant == "audit-retry":
            assert state["retryLease"] == "thread-owned"
        else:
            assert state["fixerLease"] == "thread-owned"


def assert_manager_artifacts(root: Path, ask_manager: bool) -> None:
    trial_home = root / "trial/agent/trial-home"
    tree = read_json(trial_home / "coordinator/task-tree.json")
    tasks = read_json(trial_home / "cortex-home/state/tasks.json")
    assert tasks["root"]["status"] == "done"
    assert all(task["status"] == "done" for task in tasks.values())
    assert len(tree["attempts"]) >= 3
    assert all(attempt["status"] == "terminal" for attempt in tree["attempts"])
    questions = trial_home / "coordinator/manager-qa/parent-questions.json"
    if ask_manager:
        records = read_json(questions)
        assert len(records) == 1
        assert (records[0]["state"], records[0]["answer"]) == (
            "consumed", "trial parent answer",
        )
    else:
        assert not questions.exists()


def assert_zero_paid_run(
    resolution: dict[str, object], composite: dict[str, object],
) -> None:
    assert resolution["paid_run"] is False
    states = {entry["state"] for entry in resolution["credential_capabilities"]}
    assert "live-handshake-passed" not in states
    assert resolution["credential"]["dummy_token_ref"] == "offline-token-handle"
    assert all(node["cost_usd"] == 0 for node in composite["nodes"])
    assert all(node["provider_requests"] is None for node in composite["nodes"])


def assert_trial_state(root: Path, backend: str) -> None:
    trial_home = root / "trial/agent/trial-home"
    state = trial_home / "cortex-home/state"
    for name in ("tasks", "threads", "sessions", "executions"):
        assert (state / f"{name}.json").is_file()
    if backend == "pi":
        assert (trial_home / "pi-agent/auth.json").is_file()
        assert (trial_home / "pi-agent/models.json").is_file()
        assert (trial_home / "pi-sessions").is_dir()
    else:
        assert (trial_home / "claude-config").is_dir()


def assert_mode_artifacts(
    root: Path, trajectory: Path, composite: dict[str, object],
    backend: str, mode: str, detail: str | bool | None,
) -> None:
    if mode == "coder-review":
        assert_coder_review_artifacts(root, trajectory, composite, backend, str(detail))
    elif mode == "manager":
        assert_manager_artifacts(root, detail is True)


def assert_s1_artifacts(
    root: Path, resolution: dict[str, object], suffix: str,
    backend: str, mode: str, detail: str | bool | None,
) -> None:
    trajectory = root / "trial/agent/trajectory"
    terminal = read_json(trajectory / f"run-root-{suffix}.terminal.json")
    composite = read_json(trajectory / "composite-manifest.json")
    assert valid_composite_structure(
        composite, terminal, f"root-{suffix}", f"trial-{suffix}", resolution["arm"],
    )
    assert_trial_state(root, backend)
    assert_zero_paid_run(resolution, composite)
    expected_roles = set(resolution["roles"])
    assert set(composite["identity"]["role_tool_surface_hash"]) == expected_roles
    minimum_nodes = {"direct": 1, "coder-review": 2, "manager": 4}[mode]
    assert len(composite["nodes"]) >= minimum_nodes
    for node in composite["nodes"]:
        assert node["backend"] == backend
        assert node["terminal_state"] == "completed"
        assert_attempt_files(trajectory, node)
    assert_matrix_accounting(composite, backend)
    atif = read_json(trajectory / "trajectory.json")
    if backend == "pi":
        assert "final_metrics" not in atif
    else:
        turns = sum(node["steps"] for node in composite["nodes"])
        assert atif["final_metrics"]["total_steps"] == turns
    assert_mode_artifacts(root, trajectory, composite, backend, mode, detail)


async def execute_s1_public_cli(
    agent: CortexBenchAgent, environment: DockerEnvironment,
    root: Path, mode: str,
) -> None:
    with environment.with_default_user(AGENT_USER):
        await agent.setup(environment)
        installed = await environment.exec(command="command -v cortex")
        assert installed.stdout.strip() == "/usr/local/bin/cortex"
        preview = agent.preview_run_argv()
        assert preview[:2] == ["cortex", "agent-run"]
        assert preview[preview.index("--run-config") + 1] == (
            "/logs/agent/arm-resolution.json"
        )
        run_error = None
        try:
            await agent.run("Solve the task.", environment, AgentContext())
        except NonZeroAgentExitCodeError as error:
            run_error = error
    observation = root / "task-root/s1-backend-observation.json"
    detail = observation.read_text() if observation.is_file() else "no observation"
    assert run_error is None, f"{run_error}\n{detail}"


async def run_s1_path(
    root: Path, node_runtime: Path, artifact: Path, image: dict[str, object],
    backend: str, mode: str, detail: str | bool | None,
) -> None:
    suffix = row_suffix(backend, mode, detail)
    environment = create_environment(root, node_runtime, suffix)
    write_fake_s1_cli(root / "task-root", backend, mode)
    agent = create_s1_agent(root, artifact, image, backend, mode, detail)
    assert_production_agent(agent)
    try:
        await environment.start(force_build=False)
        await provision_s1_agent_user(environment, backend, mode, detail)
        await assert_fresh_container(environment)
        await execute_s1_public_cli(agent, environment, root, mode)
        resolution_bytes = (root / "trial/agent/arm-resolution.json").read_bytes()
        resolution = json.loads(resolution_bytes)
        assert resolution["arm"]["backend"] == backend
        assert resolution["arm"]["orchestration"]["mode"] == mode
        assert_s1_observation(root, resolution_bytes, backend, mode, detail)
        await assert_s1_terminal(environment, suffix, mode)
        readable = await environment.exec(
            command="chmod -R a+rX /logs/agent", user="root",
        )
        assert readable.return_code == 0, readable.stderr
        assert_s1_artifacts(root, resolution, suffix, backend, mode, detail)
    finally:
        await environment.stop(delete=True)


@pytest.fixture(scope="module")
def installed_bundle(
    tmp_path_factory: pytest.TempPathFactory,
) -> tuple[Path, Path, Path, dict[str, object]]:
    root = tmp_path_factory.mktemp("installed-cortex")
    image = require_local_docker_image()
    assert image["image_size_bytes"] == 28_242_677
    artifact_dir = root / "npm-artifact"
    artifact_dir.mkdir()
    artifact = build_offline_npm_artifact(REPO_ROOT, artifact_dir)
    node_runtime = build_node_runtime(root)
    return root, node_runtime, artifact, image


def test_real_container_installs_bundle_and_aborts_corrupt_artifact(
    installed_bundle: tuple[Path, Path, Path, dict[str, object]],
) -> None:
    root, node_runtime, artifact, image = installed_bundle
    asyncio.run(run_positive_path(root / "positive", node_runtime, artifact, image))
    asyncio.run(run_negative_path(root / "negative", node_runtime, image))


def test_installed_dist_server_reaches_readiness_as_non_root_with_sealed_home(
    installed_bundle: tuple[Path, Path, Path, dict[str, object]],
) -> None:
    root, node_runtime, artifact, image = installed_bundle
    asyncio.run(run_production_boot_path(
        root / "production-boot", node_runtime, artifact, image,
    ))


@pytest.mark.parametrize(("backend", "mode", "detail"), PRODUCTION_ROWS)
def test_installed_exact_production_agent_executes_every_declared_cortex_arm(
    installed_bundle: tuple[Path, Path, Path, dict[str, object]],
    backend: str, mode: str, detail: str | bool | None,
) -> None:
    root, node_runtime, artifact, image = installed_bundle
    suffix = row_suffix(backend, mode, detail)
    asyncio.run(run_s1_path(
        root / suffix, node_runtime, artifact, image, backend, mode, detail,
    ))
