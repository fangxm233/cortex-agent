# input:  npm pack output, Harbor DockerEnvironment, pinned image, trial seed
# output: real-bundle install success and corrupt-artifact trial failure
# pos:    Pytest regression for the real Harbor installation boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import override

import pytest
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths

from cortex_bench_harness import CortexBenchAgent

IMAGE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
IMAGE_REF = f"debian@{IMAGE_DIGEST}"
AGENT_USER = "cortex-agent"
MINIMUM_FREE_BYTES = 10 * 1024**3
REPO_ROOT = Path(__file__).resolve().parents[4]
SERVER_ROOT = REPO_ROOT / "agent-server"


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


def build_npm_artifact(output_dir: Path) -> Path:
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    subprocess.run(
        ["pnpm", "--filter", "@cortex-agent/web...", "run", "build"],
        cwd=REPO_ROOT, env=environment, check=True, capture_output=True, text=True,
    )
    subprocess.run(
        ["npm", "pack", "--pack-destination", str(output_dir)],
        cwd=SERVER_ROOT, env=environment, check=True, capture_output=True, text=True,
    )
    artifacts = list(output_dir.glob("cortex-agent-server-*.tgz"))
    assert len(artifacts) == 1, f"expected one npm artifact, found {artifacts}"
    return artifacts[0]


def create_environment(root: Path, node_runtime: Path, suffix: str) -> DockerEnvironment:
    trial_paths = TrialPaths(root / "trial")
    trial_paths.mkdir()
    environment_dir = root / "environment"
    environment_dir.mkdir()
    task_root = root / "task-root"
    task_root.mkdir(mode=0o755)
    mounts: list[ServiceVolumeConfig] = [
        {"type": "bind", "source": str(task_root), "target": "/app"},
        {"type": "bind", "source": str(node_runtime), "target": "/opt/node",
         "read_only": True},
    ]
    return DockerEnvironment(
        environment_dir=environment_dir, environment_name=f"cortex-install-{suffix}",
        session_id=f"cortex-install-{suffix}-{os.getpid()}", trial_paths=trial_paths,
        task_env_config=EnvironmentConfig(docker_image=IMAGE_REF, workdir="/app"),
        mounts=mounts,
    )


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


async def provision_agent_user(environment: DockerEnvironment) -> None:
    # The Debian image ships no backend CLI, so stand one in for the setup-time
    # path/version probe the production adapter performs before it composes.
    command = (
        "ln -s /opt/node/bin/node /usr/local/bin/node"
        " && ln -s /opt/node/bin/npm /usr/local/bin/npm"
        f" && useradd --create-home --shell /bin/bash {AGENT_USER}"
        " && printf '#!/bin/sh\\necho \"1.2.3 (Claude Code)\"\\n' > /usr/local/bin/claude"
        " && chmod +x /usr/local/bin/claude"
    )
    result = await environment.exec(command=command, user="root")
    assert result.return_code == 0, result.stderr


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


def test_real_container_installs_bundle_and_aborts_corrupt_artifact(tmp_path: Path) -> None:
    image = require_local_docker_image()
    assert image["image_size_bytes"] == 28_242_677
    artifact_dir = tmp_path / "npm-artifact"
    artifact_dir.mkdir()
    artifact = build_npm_artifact(artifact_dir)
    node_runtime = build_node_runtime(tmp_path)
    asyncio.run(run_positive_path(tmp_path / "positive", node_runtime, artifact, image))
    asyncio.run(run_negative_path(tmp_path / "negative", node_runtime, image))
