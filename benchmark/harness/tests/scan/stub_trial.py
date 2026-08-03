# input:  real bundle, pinned Debian image, dynamic fake Claude
# output: parent/child ATIF, mutation, network, and scan evidence
# pos:    Fresh-container integration for the dynamic run path
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# This trial exercises a (backend, mode) pair the production composer refuses
# until its owning gate lands, so its resolution document is supplied by an
# explicit test-only subclass through the protected composition hook. That makes
# it a component-integration fixture; it is NOT evidence of production composition.

import asyncio
import hashlib
import importlib.metadata
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, override

from harbor.environments.base import ExecResult
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths
from harbor.utils.trajectory_validator import TrajectoryValidator

from cortex_bench_harness import CortexBenchAgent
from cortex_bench_harness.launcher import ARM_RESOLUTION_CONTAINER_PATH, ARM_RESOLUTION_SOURCE
from cortex_bench_harness.launcher.arm_resolution import (
    ArmResolutionInputs,
    ContainerFacts,
    build_arm_resolution,
)
from cortex_bench_harness.scan import ArtifactInventory, ScanPolicy, scan_trial_artifacts

IMAGE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
IMAGE_REF = f"debian@{IMAGE_DIGEST}"
WHEEL_NAME = "cortex_bench_harness-0.1.0-py3-none-any.whl"
MODEL_NAME = "claude-fake-benchmark"
ROOT_RUN_ID = "root-real-agent-run"
TRIAL_ID = "trial-real-agent-run"
AGENT_USER = "cortex-agent"
MIN_FREE_BYTES = 10 * 1024**3
MAX_IMAGE_BYTES = 2 * 1024**3
FORBIDDEN_CREDENTIAL = "sk-ant-REAL-CREDENTIAL-MUST-NOT-ENTER"
URI_HOST = re.compile(rb"https?://[^/\s\"']+")
IPV4 = re.compile(rb"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b")
HOME_PATH = re.compile(rb"/home/[^/\x00\s]+")
FINAL_METRIC_KEYS = (
    "total_prompt_tokens", "total_completion_tokens", "total_cached_tokens",
    "total_cost_usd", "total_steps",
)
POLICY_PATH = "/cortex-home/config/benchmark-thread-policy.json"
BENCHMARK_MCP_CONFIG_PATH = "/cortex-home/config/mcp-config-benchmark-thread.json"


@dataclass(frozen=True)
class Layout:
    root: Path
    repo_root: Path
    harness_dir: Path
    trial_paths: TrialPaths
    environment_dir: Path
    workspace: Path
    cortex_home: Path
    fake_bin: Path
    node_runtime: Path
    wheel_path: Path
    npm_artifact: Path


@dataclass(frozen=True)
class TrialEvidence:
    image_size_bytes: int
    inherited_real_run: bool
    run_exit_code: int
    resolved_cwd: str
    raw_usage: dict[str, int]
    event_types: frozenset[str]
    cost_record: dict[str, int | float | None]
    journal_events: tuple[dict[str, object], ...]
    terminal_state: str
    recorded_journal_path: str
    trajectory_validation: dict[str, object]
    merged_trajectory_path: Path
    final_metrics: dict[str, int | float]
    atif_validation: dict[str, object]
    scope: dict[str, object]
    required_scan_clean: bool
    whole_tree_scan_clean: bool
    outbound_routes: list[str]
    cortex_cli_version: str
    mcp_composition: str
    fake_roles: tuple[str, ...]
    child_agent_slots: frozenset[str]
    child_journal_paths: tuple[Path, ...]
    fragment_events: tuple[tuple[dict[str, object], ...], ...]
    subagent_count: int
    fail_closed_reasons: dict[str, str]


class RecordingCortexBenchAgent(CortexBenchAgent):
    """Component fixture: supplies its own document through the composition hook."""

    run_result: ExecResult | None = None
    run_command: str | None = None

    def __init__(
        self, *args: object, fixture_arm_resolution: Mapping[str, object], **kwargs: Any,
    ) -> None:
        self._fixture_arm_resolution: dict[str, object] = json.loads(
            json.dumps(fixture_arm_resolution),
        )
        super().__init__(*args, **kwargs)

    @override
    def _compose_arm_resolution(self, facts: ContainerFacts) -> dict[str, object]:
        return self._fixture_arm_resolution

    @override
    async def exec_as_agent(
        self, environment: DockerEnvironment, command: str,
        env: dict[str, str] | None = None, cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> ExecResult:
        result = await super().exec_as_agent(environment, command, env, cwd, timeout_sec)
        if command.startswith("cortex agent-run "):
            self.run_result = result
            self.run_command = command
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / "stdout.txt").write_text(result.stdout or "")
            (self.logs_dir / "stderr.txt").write_text(result.stderr or "")
        return result


def build_environment() -> dict[str, str]:
    allowed = ("PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "UV_CACHE_DIR", "PNPM_HOME")
    environment = {key: os.environ[key] for key in allowed if key in os.environ}
    environment["PYTHONNOUSERSITE"] = "1"
    return environment


def run_command(arguments: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments, cwd=cwd, env=build_environment(), check=True,
        capture_output=True, text=True, timeout=900,
    )


def inspect_image() -> dict[str, object]:
    free_bytes = shutil.disk_usage("/").free
    assert free_bytes >= MIN_FREE_BYTES, f"Docker disk gate failed: {free_bytes}"
    result = run_command(["docker", "image", "inspect", IMAGE_REF])
    image = json.loads(result.stdout)[0]
    size = image["Size"]
    assert isinstance(size, int) and size < MAX_IMAGE_BYTES
    return {"image_ref": IMAGE_REF, "image_digest": IMAGE_DIGEST, "image_size_bytes": size}


def image_inventory() -> set[str]:
    result = run_command(["docker", "image", "ls", "--no-trunc", "--quiet"])
    return set(result.stdout.splitlines())


def session_id() -> str:
    return f"cortex-real-agent-run-{os.getpid()}"


def disconnect_container_network() -> None:
    labels = ["--filter", f"label=com.docker.compose.project={session_id()}"]
    container = run_command([
        "docker", "ps", *labels, "--filter", "label=com.docker.compose.service=main",
        "--format", "{{.ID}}",
    ]).stdout.splitlines()
    networks = run_command([
        "docker", "network", "ls", *labels, "--format", "{{.Name}}",
    ]).stdout.splitlines()
    assert len(container) == 1 and len(networks) == 1
    run_command(["docker", "network", "disconnect", "-f", networks[0], container[0]])


def build_harness_wheel(harness_dir: Path) -> Path:
    run_command(["bash", "scripts/build-wheel.sh"], cwd=harness_dir)
    wheel = harness_dir / "dist" / WHEEL_NAME
    assert wheel.is_file()
    return wheel


def build_node_runtime(root: Path) -> Path:
    node = Path(shutil.which("node") or "").resolve()
    npm = Path(shutil.which("npm") or "").resolve()
    assert node.is_file() and npm.is_file()
    runtime = root / "node-runtime"
    (runtime / "bin").mkdir(parents=True)
    shutil.copy2(node, runtime / "bin/node")
    shutil.copytree(npm.parents[1], runtime / "lib/node_modules/npm", symlinks=True)
    (runtime / "bin/npm").symlink_to("../lib/node_modules/npm/bin/npm-cli.js")
    return runtime


def build_npm_artifact(root: Path, repo_root: Path) -> Path:
    output = root / "npm-artifact"
    output.mkdir()
    run_command(["pnpm", "--filter", "@cortex-agent/web...", "run", "build"], repo_root)
    run_command(["npm", "pack", "--pack-destination", str(output)], repo_root / "agent-server")
    artifacts = list(output.glob("cortex-agent-server-*.tgz"))
    assert len(artifacts) == 1
    return artifacts[0]


def profile_document() -> dict[str, object]:
    return {
        "defaultProfile": "benchmark",
        "profiles": {"benchmark": {
            "model": MODEL_NAME, "backend": "claude", "provider": "anthropic",
            "claudeBackend": "print", "fallback": [],
            "extraEnv": {
                "FAKE_CLAUDE_ARTIFACT_DIR": "/logs/artifacts",
                "CORTEX_BENCHMARK_THREAD_POLICY_PATH": POLICY_PATH,
            },
        }},
    }


def arm_definition() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": "cortex-dynamic-thread-real-agent-run",
        "backend": "claude", "provider": "anthropic", "model": MODEL_NAME,
        "credential_capability": "claude-api-key",
        "orchestration": {
            "mode": "coder-review", "coder_review_variant": "audit-retry",
            "ask_manager": False,
        },
        "limits": {
            "max_thread_starts": 1, "max_parent_questions": 0,
            "max_task_depth": 0, "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 3, "max_cost_usd": "1.00",
            "deadline_seconds": 1_200,
        },
    }


def policy_document() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-thread-policy/1",
        "canonical_instruction": "Complete the synthetic dynamic-thread trial.",
        "workspace_cwd": "/app", "template": "benchmark-coder-review",
        "profile_name": "benchmark", "root_run_id": ROOT_RUN_ID,
        "trajectory_root": "/logs/agent/trajectory",
        "limits": {
            "max_calls": 1, "max_steps": 4, "max_cost_usd": 1,
            "deadline_epoch_ms": int((time.time() + 1_200) * 1_000),
        },
    }


def write_profile(cortex_home: Path) -> None:
    config = cortex_home / "config"
    config.mkdir(parents=True)
    (config / "profiles.json").write_text(json.dumps(profile_document()))
    for slot in ("parent", "benchmark-coder", "benchmark-reviewer"):
        (config / f"{slot}-system.txt").write_text(f"System prompt for {slot}.\n")
        (config / f"{slot}-directive.txt").write_text(f"Directive for {slot}.\n")
    policy = config / "benchmark-thread-policy.json"
    policy.write_text(json.dumps(policy_document()))
    policy.chmod(0o444)
    for name in ("projects", "tmp", "xdg-config", "xdg-cache"):
        (cortex_home / name).mkdir()


def install_fake_claude(root: Path) -> Path:
    fake_bin = root / "fake-bin"
    fake_bin.mkdir()
    source = Path(__file__).with_name("fake_claude.sh")
    target = fake_bin / "claude"
    shutil.copy2(source, target)
    shutil.copy2(Path(__file__).with_name("fake_claude.mjs"), fake_bin / "fake_claude.mjs")
    target.chmod(0o755)
    return fake_bin


def create_layout(root: Path) -> Layout:
    harness_dir = Path(__file__).resolve().parents[2]
    repo_root = harness_dir.parents[1]
    trial_paths = TrialPaths(root / "trial")
    trial_paths.mkdir()
    environment_dir = root / "environment"
    workspace = root / "workspace"
    cortex_home = root / "cortex-home"
    environment_dir.mkdir()
    workspace.mkdir()
    wheel = build_harness_wheel(harness_dir)
    npm_artifact = build_npm_artifact(root, repo_root)
    write_profile(cortex_home)
    return Layout(
        root, repo_root, harness_dir, trial_paths, environment_dir, workspace,
        cortex_home, install_fake_claude(root), build_node_runtime(root),
        wheel, npm_artifact,
    )


def create_environment(layout: Layout) -> DockerEnvironment:
    mounts: list[ServiceVolumeConfig] = [
        {"type": "bind", "source": str(layout.workspace), "target": "/app"},
        {"type": "bind", "source": str(layout.node_runtime), "target": "/opt/node", "read_only": True},
        {"type": "bind", "source": str(layout.fake_bin), "target": "/opt/fake-bin", "read_only": True},
        {"type": "bind", "source": str(layout.cortex_home), "target": "/cortex-home"},
        {"type": "bind", "source": str(layout.trial_paths.agent_dir), "target": "/logs/agent"},
        {"type": "bind", "source": str(layout.trial_paths.verifier_dir), "target": "/logs/verifier"},
        {"type": "bind", "source": str(layout.trial_paths.artifacts_dir), "target": "/logs/artifacts"},
    ]
    return DockerEnvironment(
        environment_dir=layout.environment_dir, environment_name="cortex-real-agent-run",
        session_id=session_id(), trial_paths=layout.trial_paths,
        task_env_config=EnvironmentConfig(docker_image=IMAGE_REF, workdir="/app"), mounts=mounts,
        extra_docker_compose=[Path(__file__).with_name("docker-compose-never-pull.yaml")],
    )


def agent_environment() -> dict[str, str]:
    return {
        "PATH": "/opt/fake-bin:/usr/local/bin:/opt/node/bin:/usr/bin:/bin",
        "HOME": f"/home/{AGENT_USER}", "CORTEX_HOME": "/cortex-home",
        "CORTEX_PROJECTS_DIR": "/cortex-home/projects",
        "CLAUDE_CONFIG_DIR": f"/home/{AGENT_USER}/.claude",
        "XDG_CONFIG_HOME": "/cortex-home/xdg-config",
        "XDG_CACHE_HOME": "/cortex-home/xdg-cache", "TMPDIR": "/cortex-home/tmp",
    }


def role_asset(slot: str, parent: bool = False) -> dict[str, object]:
    return {
        "system_prompt_path": f"/cortex-home/config/{slot}-system.txt",
        "directive_path": f"/cortex-home/config/{slot}-directive.txt",
        "tools": (["mcp__cortex-benchmark-thread__thread_run"] if parent else ["Read", "Write"]),
        "plugin_dirs": [],
        "mcp_composition": "benchmark-thread-run" if parent else "none",
        "mcp_config_paths": [
            BENCHMARK_MCP_CONFIG_PATH if parent else "/cortex-home/config/mcp-config-empty.json"
        ],
        "disable_hooks": True,
    }


def resolution_thread_assets() -> tuple[dict[str, str], dict[str, str]]:
    templates = {
        "benchmark-coder-review": (
            "/cortex-home/config/thread-templates/templates/benchmark-coder-review.json"
        ),
    }
    agents = {
        "benchmark-coder": "/cortex-home/config/thread-templates/agents/benchmark-coder.json",
        "benchmark-reviewer": (
            "/cortex-home/config/thread-templates/agents/benchmark-reviewer.json"
        ),
    }
    return templates, agents


def trial_task(image: dict[str, object]) -> dict[str, object]:
    return {
        "task_id": "synthetic-dynamic-thread",
        "image_ref": image["image_ref"],
        "image_digest": image["image_digest"],
    }


def trial_credential() -> dict[str, object]:
    return {
        "upstream_base_url": "https://api.anthropic.com",
        "route_identity_host": "api.anthropic.com",
        "proxy_base_url": "http://trial-proxy.invalid",
        "dummy_token_ref": "offline-fixture-token-handle",
    }


def trial_seed(image: dict[str, object]) -> dict[str, object]:
    return {
        "arm": arm_definition(), "arm_path": "arm://cortex-dynamic-thread-real-agent-run",
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID, "task": trial_task(image),
        "profile_name": "benchmark", "paid_run": False,
        "credential": trial_credential(), "model_alias_policy": None,
    }


def arm_resolution_document(image: dict[str, object]) -> dict[str, object]:
    templates, agents = resolution_thread_assets()
    inputs = ArmResolutionInputs(
        arm=arm_definition(), arm_path="arm://cortex-dynamic-thread-real-agent-run",
        trial_id=TRIAL_ID, root_run_id=ROOT_RUN_ID, task=trial_task(image),
        profile_name="benchmark", paid_run=False,
        credential=trial_credential(),
        cli_artifact={"path": "/opt/fake-bin/claude", "version": "2.1.999"},
        model_alias_policy=None,
        roles={
            "parent": role_asset("parent", True),
            "benchmark-coder": role_asset("benchmark-coder"),
            "benchmark-reviewer": role_asset("benchmark-reviewer"),
        },
        thread_templates=templates, thread_agents=agents,
        artifact_inventory_spec={"expected": [ARM_RESOLUTION_SOURCE]},
    )
    return build_arm_resolution(inputs)


def create_agent(layout: Layout, image: dict[str, object]) -> RecordingCortexBenchAgent:
    manifest = {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID,
        "arm": "cortex-dynamic-thread-real-agent-run", "wheel_path": str(layout.wheel_path),
        "lockfile_path": str(layout.harness_dir / "uv.lock"),
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "npm_artifact_path": str(layout.npm_artifact), **image,
    }
    return RecordingCortexBenchAgent(
        logs_dir=layout.trial_paths.agent_dir,
        artifact_dir=layout.trial_paths.artifacts_dir,
        manifest=manifest, trial_seed=trial_seed(image),
        fixture_arm_resolution=arm_resolution_document(image),
        extra_env=agent_environment(),
    )


async def provision_runtime(environment: DockerEnvironment) -> None:
    uid = os.getuid()
    command = (
        "ln -s /opt/node/bin/node /usr/local/bin/node"
        " && ln -s /opt/node/bin/npm /usr/local/bin/npm"
        f" && useradd --uid {uid} --create-home --shell /bin/bash {AGENT_USER}"
    )
    result = await environment.exec(command=command, user="root")
    assert result.return_code == 0, result.stderr


def benchmark_mcp_config_script() -> str:
    return (
        "const fs=await import('node:fs');const path=await import('node:path');"
        "const root=process.argv[1];const entry={command:'node',"
        "args:[path.join(root,'dist/domain/mcp/benchmark-thread-server.js')],cwd:root};"
        f"fs.writeFileSync('{BENCHMARK_MCP_CONFIG_PATH}',"
        "JSON.stringify({mcpServers:{'cortex-benchmark-thread':entry}},null,2));"
    )


async def provision_dynamic_runtime(environment: DockerEnvironment) -> None:
    target = "/cortex-home/config/thread-templates"
    package = (
        'package_root="$(npm ls --global --parseable --depth=0 --prefix '
        '/installed-agent/npm @cortex-agent/server)"'
    )
    copies = [
        ("agents/benchmark-coder.json", "agents/benchmark-coder.json"),
        ("agents/benchmark-reviewer.json", "agents/benchmark-reviewer.json"),
        ("templates/benchmark-coder-review.json", "templates/benchmark-coder-review.json"),
    ]
    commands = [package, f"mkdir -p {target}/agents {target}/templates {target}/shells"]
    for source, destination in copies:
        commands.append(
            f'cp "$package_root/defaults/config/thread-templates/{source}" {target}/{destination}'
        )
    commands.append('cp "$package_root/defaults/config/mcp-config-empty.json" '
                    "/cortex-home/config/mcp-config-empty.json")
    script = shlex.quote(benchmark_mcp_config_script())
    commands.append(f'node --input-type=module -e {script} "$package_root"')
    result = await environment.exec(command=" && ".join(commands))
    assert result.return_code == 0, result.stderr


def validation_command() -> str:
    script = (
        "const m=await import('file://' + process.argv[1]);"
        "const r=m.validateTrajectoryRoot(process.argv[2]);"
        "console.log(JSON.stringify(r));if(!r.ok)process.exit(1);"
    )
    return (
        'package_root="$(npm ls --global --parseable --depth=0 --prefix '
        '/installed-agent/npm @cortex-agent/server)"'
        f" && node --input-type=module -e {shlex.quote(script)} "
        '"$package_root/dist/domain/agent-run/manifest.js" /logs/agent/trajectory'
        " > /logs/artifacts/trajectory-validation.json"
    )


def trial_record() -> dict[str, object]:
    scope = {
        "stub_agent_trial": False, "real_cortex_agent_run": True,
        "fake_model_backend": "claude-path-substitution", "paid_model_calls": 0,
        "other_faked_layers": [],
    }
    return {
        "scope": scope,
        "layers": {
            "harbor_agent_run": "real", "installed_cortex_cli": "real",
            "process_supervisor": "real", "claude_adapter": "real",
            "benchmark_thread_mcp": "real-blocking-stdio",
            "local_thread_orchestrator": "real",
            "model_backend": "fake-network-free",
            "trajectory_merge": "real-host-cli",
            "container_network": "detached-before-agent-run",
        },
    }


async def write_container_evidence(environment: DockerEnvironment) -> None:
    record = shlex.quote(json.dumps(trial_record(), sort_keys=True))
    sensitive = "ANTHROPIC|OPENAI|AWS_|SLACK|FEISHU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET"
    commands = [
        validation_command(),
        "command -v claude > /logs/artifacts/claude-path.txt",
        "tail -n +2 /proc/net/route > /logs/artifacts/outbound-routes.txt",
        f"env | cut -d= -f1 | grep -E {shlex.quote(sensitive)} "
        "> /logs/artifacts/sensitive-env-names.txt || true",
        "test ! -s /logs/artifacts/sensitive-env-names.txt",
        f"printf '%s\\n' {record} > /logs/artifacts/trial-record.json",
    ]
    for command in commands:
        result = await environment.exec(command=command)
        assert result.return_code == 0, f"{command}\n{result.stderr}"


async def execute_trial(
    layout: Layout, image: dict[str, object],
) -> RecordingCortexBenchAgent:
    environment = create_environment(layout)
    agent = create_agent(layout, image)
    try:
        await environment.start(force_build=False)
        await provision_runtime(environment)
        with environment.with_default_user(AGENT_USER):
            with environment.scoped_exec_env(agent.extra_env):
                assert agent.run.__func__ is CortexBenchAgent.run
                await agent.setup(environment)
                await provision_dynamic_runtime(environment)
                disconnect_container_network()
                routes = await environment.exec(command="tail -n +2 /proc/net/route")
                assert routes.return_code == 0 and not (routes.stdout or "").strip()
                await agent.run("Complete the synthetic real-agent trial.", environment, AgentContext())
                await write_container_evidence(environment)
    finally:
        await environment.stop(delete=True)
    assert agent.run_result is not None
    return agent


def journal_records(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def parse_journal(layout: Layout) -> tuple[dict[str, object], list[dict[str, object]]]:
    path = layout.trial_paths.agent_dir / "trajectory" / "events.jsonl"
    records = journal_records(path)
    header = records[0]
    events = [record["event"] for record in records[1:]]
    assert header["type"] == "run_header" and header["resolved_cwd"] == "/app"
    return header, events


def child_journals(layout: Layout) -> tuple[Path, ...]:
    root = layout.trial_paths.agent_dir / "trajectory"
    return tuple(sorted(root.glob("thread-*.journal.ndjson")))


def fragment_events(layout: Layout) -> tuple[tuple[dict[str, object], ...], ...]:
    parent = layout.trial_paths.agent_dir / "trajectory" / "events.jsonl"
    paths = (parent, *child_journals(layout))
    return tuple(tuple(record["event"] for record in journal_records(path)[1:]) for path in paths)


def merge_trajectory(layout: Layout) -> Path:
    trajectory_root = layout.trial_paths.agent_dir / "trajectory"
    output = layout.trial_paths.artifacts_dir / "trajectory.json"
    cli = layout.repo_root / "agent-server/dist/domain/agent-run/trajectory-merge-cli.js"
    result = run_command([
        "node", str(cli), "--trajectory-root", str(trajectory_root),
        "--output", str(output),
    ], layout.repo_root)
    payload = json.loads(result.stdout)
    assert payload["ok"] is True and Path(payload["output_path"]) == output
    return output


def merge_failure_process(layout: Layout, trajectory_root: Path, output: Path):
    cli = layout.repo_root / "agent-server/dist/domain/agent-run/trajectory-merge-cli.js"
    return subprocess.run(
        ["node", str(cli), "--trajectory-root", str(trajectory_root), "--output", str(output)],
        cwd=layout.repo_root, env=build_environment(), capture_output=True, text=True, timeout=60,
    )


def mutate_child_fragment(root: Path, mutation: str) -> None:
    journals = tuple(root.glob("thread-*.journal.ndjson"))
    assert len(journals) == 1
    journal = journals[0]
    if mutation == "corrupted_child":
        journal.write_bytes(journal.read_bytes() + b"{not-json}\n")
        return
    stem = journal.name.removesuffix(".journal.ndjson")
    journal.unlink()
    (root / f"{stem}.started.json").unlink()
    (root / f"{stem}.terminal.json").unlink()


def assert_merge_failure(layout: Layout, mutation: str) -> str:
    copied = layout.root / f"{mutation}-trajectory"
    shutil.copytree(layout.trial_paths.agent_dir / "trajectory", copied)
    mutate_child_fragment(copied, mutation)
    output = layout.root / f"{mutation}-output" / "trajectory.json"
    output.parent.mkdir()
    result = merge_failure_process(layout, copied, output)
    assert result.returncode == 1 and not output.exists()
    assert not tuple(output.parent.glob(f"{output.name}.tmp.*"))
    payload = json.loads(result.stderr)
    assert payload["ok"] is False
    return str(payload["reason"])


def validate_atif(trajectory_path: Path) -> dict[str, object]:
    validator = TrajectoryValidator()
    ok = validator.validate(trajectory_path)
    return {
        "ok": ok,
        "errors": validator.get_errors(),
        "validator": "harbor.utils.trajectory_validator.TrajectoryValidator",
        "harbor_version": importlib.metadata.version("harbor"),
    }


def parse_fake_usage(layout: Layout) -> dict[str, int]:
    artifacts = layout.trial_paths.artifacts_dir
    output = (artifacts / "fake-claude-output.jsonl").read_text().splitlines()
    result = json.loads(output[-1])
    request = json.loads((artifacts / "fake-claude-stdin.json").read_text())
    argv = (artifacts / "fake-claude-argv.txt").read_text().splitlines()
    assert (artifacts / "fake-claude-version.txt").read_text().strip() == "2.1.999 (Cortex benchmark fake)"
    assert (artifacts / "claude-path.txt").read_text().strip() == "/opt/fake-bin/claude"
    assert (artifacts / "fake-claude-cwd.txt").read_text().strip() == "/app"
    assert request["type"] == "user" and request["session_id"] == result["session_id"]
    assert argv[:5] == ["-p", "--input-format", "stream-json", "--output-format", "stream-json"]
    assert "--strict-mcp-config" in argv and argv[argv.index("--model") + 1] == MODEL_NAME
    return result["usage"]


def parse_fake_roles(layout: Layout) -> tuple[str, ...]:
    path = layout.trial_paths.artifacts_dir / "fake-claude-invocations.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert all(row["cwd"] == "/app" for row in rows)
    return tuple(str(row["role"]) for row in rows)


def parent_mcp_composition(
    layout: Layout, agent: RecordingCortexBenchAgent,
) -> str:
    assert agent.run_command is not None
    assert f"--run-config {ARM_RESOLUTION_CONTAINER_PATH}" in agent.run_command
    mcp_config = json.loads(
        (layout.cortex_home / "config/mcp-config-benchmark-thread.json").read_text()
    )
    assert list(mcp_config["mcpServers"]) == ["cortex-benchmark-thread"]
    arm_resolution = json.loads(
        (layout.trial_paths.agent_dir / ARM_RESOLUTION_CONTAINER_PATH.name).read_text()
    )
    return str(arm_resolution["roles"]["parent"]["mcp_composition"])


def child_slots(layout: Layout) -> frozenset[str]:
    slots: set[str] = set()
    for journal in child_journals(layout):
        slots.update(str(record["agent_slot"]) for record in journal_records(journal)[1:])
    return frozenset(slots)


def harness_cli_version(layout: Layout) -> str:
    path = layout.trial_paths.artifacts_dir / "cortex-bench-harness-manifest.json"
    version = json.loads(path.read_text())["cortex_cli"]["version"]
    assert isinstance(version, str) and version
    return version


def validate_terminal(layout: Layout, header: dict[str, object]) -> dict[str, object]:
    root = layout.trial_paths.agent_dir / "trajectory"
    started = json.loads((root / f"run-{ROOT_RUN_ID}.started.json").read_text())
    terminal = json.loads((root / f"run-{ROOT_RUN_ID}.terminal.json").read_text())
    journal = root / "events.jsonl"
    assert started["journal_path"] == terminal["journal_path"]
    assert terminal["journal_sha256"] == hashlib.sha256(journal.read_bytes()).hexdigest()
    assert terminal["supervisor"] == {"quiescent": True, "descendants": 0}
    for key in ("model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash"):
        assert terminal[key] == header[key]
    return terminal


def host_secret_literals() -> dict[str, str]:
    values = {"forbidden_real_credential": FORBIDDEN_CREDENTIAL}
    pattern = re.compile(r"(KEY|TOKEN|SECRET|CREDENTIAL)$")
    candidates = [value for key, value in os.environ.items() if pattern.search(key)]
    for index, value in enumerate(dict.fromkeys(candidates), start=1):
        if len(value) >= 8 and "\n" not in value and "\r" not in value:
            values[f"host_secret_{index}"] = value
    return values


def write_workspace_diff(layout: Layout) -> Path:
    output = layout.trial_paths.artifacts_dir / "workspace.diff"
    with output.open("wb") as stream:
        for path in sorted(layout.workspace.rglob("*")):
            if path.is_symlink():
                payload = os.fsencode(os.readlink(path))
            elif path.is_file():
                payload = path.read_bytes()
            else:
                continue
            relative = os.fsencode(path.relative_to(layout.workspace))
            stream.write(b"--- /dev/null\n+++ b/" + relative + b"\n")
            for line in payload.splitlines(keepends=True):
                stream.write(b"+" + line)
            if payload and not payload.endswith(b"\n"):
                stream.write(b"\n")
    return output


def required_scan(layout: Layout, secrets: dict[str, str]) -> bool:
    artifacts = layout.trial_paths.artifacts_dir
    roots = (
        layout.trial_paths.agent_dir,
        layout.trial_paths.verifier_dir,
        artifacts,
    )
    source_paths = {
        path.relative_to(layout.root).as_posix(): path
        for path in result_surface_files(layout)
    }
    manifest = artifacts / "cortex-bench-harness-manifest.json"
    source_paths["manifest"] = source_paths.pop(manifest.relative_to(layout.root).as_posix())
    inventory = ArtifactInventory(source_paths, frozenset(source_paths), roots)
    policy = ScanPolicy(secrets, str(layout.repo_root), socket.gethostname())
    report = scan_trial_artifacts(inventory, policy)
    (artifacts / "required-scan-report.json").write_text(json.dumps(report.as_dict(), sort_keys=True))
    return report.clean


def result_surface_files(layout: Layout) -> list[Path]:
    files: list[Path] = []
    for root in (layout.trial_paths.agent_dir, layout.trial_paths.verifier_dir,
                 layout.trial_paths.artifacts_dir):
        files.extend(path for path in root.rglob("*") if path.is_file())
    return sorted(files)


def whole_tree_scan(layout: Layout, secrets: dict[str, str]) -> bool:
    findings: list[str] = []
    literals = [value.encode() for value in secrets.values()]
    total_bytes = 0
    files = result_surface_files(layout)
    for path in files:
        data = path.read_bytes()
        total_bytes += len(data)
        if any(literal in data for literal in literals):
            findings.append(f"secret:{path.relative_to(layout.root)}")
        if HOME_PATH.search(data) or URI_HOST.search(data) or IPV4.search(data):
            findings.append(f"host:{path.relative_to(layout.root)}")
    report = {"clean": not findings, "files_scanned": len(files),
              "bytes_scanned": total_bytes, "matches": findings}
    output = layout.trial_paths.artifacts_dir / "whole-tree-scan-report.json"
    output.write_text(json.dumps(report, sort_keys=True))
    return not findings


def scan_results(layout: Layout) -> tuple[dict[str, object], bool, bool, list[str]]:
    secrets = host_secret_literals()
    write_workspace_diff(layout)
    required_clean = required_scan(layout, secrets)
    whole_clean = whole_tree_scan(layout, secrets)
    artifacts = layout.trial_paths.artifacts_dir
    scope = json.loads((artifacts / "trial-record.json").read_text())["scope"]
    routes = (artifacts / "outbound-routes.txt").read_text().splitlines()
    return scope, required_clean, whole_clean, routes


def collect_evidence(
    layout: Layout, image: dict[str, object], agent: RecordingCortexBenchAgent,
    merged_path: Path,
) -> TrialEvidence:
    header, events = parse_journal(layout)
    terminal = validate_terminal(layout, header)
    cost = next(event for event in events if event["type"] == "cost_record")
    validation_path = layout.trial_paths.artifacts_dir / "trajectory-validation.json"
    validation = json.loads(validation_path.read_text())
    trajectory = json.loads(merged_path.read_text())
    metrics = {key: trajectory["final_metrics"][key] for key in FINAL_METRIC_KEYS}
    scope, required_clean, whole_clean, routes = scan_results(layout)
    failures = {
        name: assert_merge_failure(layout, name)
        for name in ("corrupted_child", "missing_child")
    }
    return TrialEvidence(
        int(image["image_size_bytes"]), True, agent.run_result.return_code,
        str(header["resolved_cwd"]), parse_fake_usage(layout),
        frozenset(str(event["type"]) for event in events),
        {key: cost[key] for key in ("tokens_in", "tokens_out", "prompt_tokens",
                                    "cached_tokens", "cost_usd")},
        tuple(events), str(terminal["state"]), str(terminal["journal_path"]), validation,
        merged_path, metrics, validate_atif(merged_path), scope, required_clean, whole_clean, routes,
        harness_cli_version(layout), parent_mcp_composition(layout, agent), parse_fake_roles(layout),
        child_slots(layout), child_journals(layout), fragment_events(layout),
        len(trajectory["subagent_trajectories"]), failures,
    )


def run_real_agent_trial(root: Path) -> TrialEvidence:
    image = inspect_image()
    before_images = image_inventory()
    layout = create_layout(root)
    agent = asyncio.run(execute_trial(layout, image))
    merged_path = merge_trajectory(layout)
    after_images = image_inventory()
    assert after_images == before_images, "real trial changed the Docker image inventory"
    return collect_evidence(layout, image, agent, merged_path)


def main() -> None:
    import tempfile

    with tempfile.TemporaryDirectory(prefix="cortex-real-agent-run-") as temp_dir:
        evidence = run_real_agent_trial(Path(temp_dir))
        print(json.dumps(evidence.__dict__, default=list, sort_keys=True))


if __name__ == "__main__":
    main()
