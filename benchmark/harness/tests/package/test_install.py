# input:  npm artifact, Docker environment, S1 arm seeds, opt-in gate
# output: installed six-row execution matrix and corrupt-artifact failure
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
from offline_package import build_offline_npm_artifact

IMAGE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
IMAGE_REF = f"debian@{IMAGE_DIGEST}"
AGENT_USER = "cortex-agent"
MINIMUM_FREE_BYTES = 10 * 1024**3
REPO_ROOT = Path(__file__).resolve().parents[4]
CODER_REVIEW_VARIANTS = ("audit-retry", "reviewer-fix")
S1_ROWS = (
    *((backend, "direct", None) for backend in ("claude", "pi")),
    *((backend, "coder-review", variant)
      for backend in ("claude", "pi") for variant in CODER_REVIEW_VARIANTS),
)
POLICY_PATH = "/logs/agent/benchmark-thread-policy.json"


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


def create_environment(root: Path, node_runtime: Path, suffix: str) -> DockerEnvironment:
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


def s1_seed(
    image: dict[str, object], suffix: str, backend: str,
    mode: str, variant: str | None,
) -> dict[str, object]:
    seed = trial_seed(image, suffix)
    arm = dict(seed["arm"])
    arm.update({"name": f"cortex-{suffix}", "backend": backend})
    if mode == "coder-review":
        arm["orchestration"] = {
            "mode": mode, "coder_review_variant": variant, "ask_manager": False,
        }
        arm["limits"] = {
            **arm["limits"], "max_thread_starts": 1,
            "max_resident_agent_processes": 3,
        }
    seed.update({"arm": arm, "arm_path": f"arm://{arm['name']}"})
    if backend == "pi":
        seed["pi_benchmark_capability_proven"] = True
    return seed


def create_s1_agent(
    root: Path, artifact: Path, image: dict[str, object],
    backend: str, mode: str, variant: str | None,
) -> CortexBenchAgent:
    suffix = "-".join(part for part in (backend, mode, variant) if part)
    wheel = root / "cortex_bench_harness-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"harness wheel fixture")
    seed = s1_seed(image, suffix, backend, mode, variant)
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
) -> None:
    script = "fake-pi.mjs" if backend == "pi" else "fake-claude.mjs"
    command = (
        "printf 'update-notifier=false\\n' > /etc/npmrc"
        " && ln -s /opt/node/bin/node /usr/local/bin/node"
        " && ln -s /opt/node/bin/npm /usr/local/bin/npm"
        f" && useradd --create-home --shell /bin/bash {AGENT_USER}"
        f" && printf 'update-notifier=false\\n' > /home/{AGENT_USER}/.npmrc"
        f" && chown {AGENT_USER}:{AGENT_USER} /home/{AGENT_USER}/.npmrc"
        f" && printf '#!/bin/sh\\nexec /opt/node/bin/node /app/{script} \"$@\"\\n'"
        f" > /usr/local/bin/{backend} && chmod +x /usr/local/bin/{backend}"
    )
    result = await environment.exec(command=command, user="root")
    assert result.return_code == 0, result.stderr


def write_fake_s1_cli(task_root: Path, backend: str) -> Path:
    name = "fake_pi_mcp_cli.mjs" if backend == "pi" else "fake_claude_mcp_cli.mjs"
    script = task_root / ("fake-pi.mjs" if backend == "pi" else "fake-claude.mjs")
    shutil.copy2(Path(__file__).with_name(name), script)
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


def assert_s1_observation(
    root: Path, resolution_bytes: bytes, backend: str,
    mode: str, variant: str | None,
) -> None:
    resolution = json.loads(resolution_bytes)
    observation = json.loads(
        (root / "task-root/s1-backend-observation.json").read_text()
    )
    assert observation["backend"] == backend
    assert observation["mode"] == mode
    assert observation["variant"] == variant
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
    assert_coder_review_observation(observation, backend, variant)


async def assert_s1_terminal(
    environment: DockerEnvironment, suffix: str, mode: str,
) -> None:
    terminal_path = f"/logs/agent/trajectory/run-root-{suffix}.terminal.json"
    composite_path = "/logs/agent/trajectory/composite-manifest.json"
    child_terminals = "/logs/agent/trajectory/thread-*.terminal.json"
    with environment.with_default_user(AGENT_USER):
        result = await environment.exec(command=f"cat {shlex.quote(terminal_path)}")
        composite = await environment.exec(command=f"test -f {composite_path}")
        child = await environment.exec(
            command=f"set -- {child_terminals}; test ! -e \"$1\"",
        )
    assert result.return_code == 0, result.stderr
    terminal = json.loads(result.stdout)
    assert (terminal["state"], terminal["terminal_reason"]) == ("completed", "ok")
    assert terminal["supervisor"] == {"quiescent": True, "descendants": 0}
    assert child.return_code == 0, "the fake parent must not start a child thread"
    assert (composite.return_code == 0) is (mode == "direct")


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
    if mode == "direct":
        observation = root / "task-root/s1-backend-observation.json"
        detail = observation.read_text() if observation.is_file() else "no observation"
        assert run_error is None, f"{run_error}\n{detail}"
    else:
        assert run_error is not None, "coder-review must fail without thread_run"
        refusal = str(run_error)
        assert "Command failed (exit 1): cortex agent-run" in refusal
        assert '"state":"failed"' in refusal
        assert '"manifest":null' in refusal
        assert '"terminal_reason":"protocol_violation"' in refusal


async def run_s1_path(
    root: Path, node_runtime: Path, artifact: Path, image: dict[str, object],
    backend: str, mode: str, variant: str | None,
) -> None:
    suffix = "-".join(part for part in (backend, mode, variant) if part)
    environment = create_environment(root, node_runtime, suffix)
    write_fake_s1_cli(root / "task-root", backend)
    agent = create_s1_agent(root, artifact, image, backend, mode, variant)
    assert_production_agent(agent)
    try:
        await environment.start(force_build=False)
        await provision_s1_agent_user(environment, backend)
        await assert_fresh_container(environment)
        await execute_s1_public_cli(agent, environment, root, mode)
        resolution_bytes = (root / "trial/agent/arm-resolution.json").read_bytes()
        resolution = json.loads(resolution_bytes)
        assert resolution["arm"]["backend"] == backend
        assert resolution["arm"]["orchestration"]["mode"] == mode
        assert_s1_observation(root, resolution_bytes, backend, mode, variant)
        await assert_s1_terminal(environment, suffix, mode)
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


@pytest.mark.parametrize(("backend", "mode", "variant"), S1_ROWS)
def test_installed_exact_production_agent_executes_all_six_s1_rows(
    installed_bundle: tuple[Path, Path, Path, dict[str, object]],
    backend: str, mode: str, variant: str | None,
) -> None:
    root, node_runtime, artifact, image = installed_bundle
    suffix = "-".join(part for part in (backend, mode, variant) if part)
    asyncio.run(run_s1_path(
        root / suffix, node_runtime, artifact, image, backend, mode, variant,
    ))
