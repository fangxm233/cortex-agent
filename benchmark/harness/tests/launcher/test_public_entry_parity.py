# input:  shipped agent/loader, production assets, Harbor factory
# output: public argv/loader parity and vendor isolation proofs
# pos:    Direct construction bypasses stub_trial injection
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

from harbor.agents.factory import AgentFactory
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.arm_resolution import (
    ARM_RESOLUTION_SOURCE,
    ArmResolutionInputs,
    build_arm_resolution,
)
from cortex_bench_harness.launcher.arms import build_agent_config

DIGEST = f"sha256:{'a' * 64}"
ROOT_RUN_ID = "trial-parity.cortex-direct"
LOADER_SCRIPT = """
import { loadAgentRunConfigWithPolicy } from './src/domain/agent-run/run-config.ts';
const loaded = loadAgentRunConfigWithPolicy({
  runConfigFile: process.env.CORTEX_PARITY_RUN_CONFIG,
  agentSlot: 'parent',
});
console.log(JSON.stringify({
  role: loaded.config.role,
  policySchema: loaded.policy?.schema_version,
  armName: loaded.policy?.arm.name,
}));
"""


class RecordingEnvironment:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.uploads: list[tuple[Path | str, str]] = []

    async def exec(self, command: str, **kwargs: object) -> ExecResult:
        self.calls.append((command, kwargs))
        if command.endswith("pwd") or "realpath -- /app" in command:
            return ExecResult(stdout="/app\n", return_code=0)
        if command.endswith("cortex daemon --version"):
            return ExecResult(stdout="2026.8.3-2\n", return_code=0)
        if command.endswith("claude --version"):
            return ExecResult(stdout="1.2.3 (Claude Code)\n", return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((source_path, target_path))


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def cortex_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": "cortex-direct",
        "backend": "claude", "provider": "anthropic", "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0,
            "max_task_depth": 0, "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 90,
        },
    }


def production_arm_resolution() -> dict[str, object]:
    server = repo_root() / "agent-server"
    node = shutil.which("node")
    assert node is not None
    role = {
        "system_prompt_path": str(server / "defaults/prompts/systemPrompts/direct.md"),
        "directive_path": str(server / "defaults/prompts/directives/executor.md"),
        "tools": ["Read", "Write"], "plugin_dirs": [], "mcp_composition": "none",
        "mcp_config_paths": [str(server / "defaults/config/mcp-config-empty.json")],
        "disable_hooks": True,
    }
    return build_arm_resolution(ArmResolutionInputs(
        arm=cortex_arm(), arm_path="arm://cortex-direct",
        trial_id="trial-parity", root_run_id=ROOT_RUN_ID,
        task={"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
              "image_digest": DIGEST},
        profile_name="benchmark", paid_run=False,
        credential={"upstream_base_url": "https://api.anthropic.com",
                    "route_identity_host": "api.anthropic.com",
                    "proxy_base_url": "http://trial-proxy.invalid",
                    "dummy_token_ref": "offline-token-handle"},
        cli_artifact={"path": node, "version": "test-node"},
        model_alias_policy={"kind": "exact"}, roles={"parent": role},
        thread_templates={}, thread_agents={},
        artifact_inventory_spec={"expected": [ARM_RESOLUTION_SOURCE]},
    ))


def manifest(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"parity fixture")
    return {
        "root_run_id": ROOT_RUN_ID, "trial_id": "trial-parity", "arm": "cortex-direct",
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"registry.invalid/task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": len(b"parity fixture"),
    }


def public_agent(tmp_path: Path) -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest=manifest(tmp_path), arm_resolution=production_arm_resolution(),
    )


def write_profile(home: Path) -> None:
    config = home / "config"
    config.mkdir(parents=True)
    (config / "profiles.json").write_text(json.dumps({
        "defaultProfile": "benchmark",
        "profiles": {"benchmark": {
            "model": "claude-sonnet", "backend": "claude", "provider": "anthropic",
            "claudeBackend": "print", "fallback": [],
        }},
    }))


def load_emitted_role(run_config: Path, tmp_path: Path) -> dict[str, object]:
    home = tmp_path / "cortex-home"
    write_profile(home)
    env = os.environ.copy()
    env.update({
        "CORTEX_HOME": str(home),
        "CORTEX_PROJECTS_DIR": str(home / "projects"),
        "CORTEX_PARITY_RUN_CONFIG": str(run_config),
    })
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "--eval", LOADER_SCRIPT],
        cwd=repo_root() / "agent-server", env=env, text=True, capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout)
    assert isinstance(loaded, dict)
    return loaded


def assert_run_argv(agent: CortexBenchAgent, environment: RecordingEnvironment) -> Path:
    preview = agent.preview_run_argv()
    run_config_index = preview.index("--run-config") + 1
    container_path = Path(preview[run_config_index])
    container_agent_dir = Path("/logs/agent")
    emitted_path = agent.logs_dir / container_path.relative_to(container_agent_dir)
    assert container_path == container_agent_dir / "arm-resolution.json"
    assert emitted_path.is_file()

    asyncio.run(agent.run("Complete the task.", environment, AgentContext()))
    run_commands = [
        command for command, _ in environment.calls
        if "cortex agent-run --prompt-file" in command
    ]
    assert len(run_commands) == 1
    actual = shlex.split(run_commands[0].removeprefix("set -o pipefail; "))
    assert actual == preview
    assert actual[actual.index("--run-config") + 1] == str(container_path)
    return emitted_path


def test_public_entry_argv_loads_the_explicit_direct_composition(tmp_path: Path) -> None:
    agent = public_agent(tmp_path)
    environment = RecordingEnvironment()
    asyncio.run(agent.setup(environment))

    loaded = load_emitted_role(assert_run_argv(agent, environment), tmp_path)
    server = repo_root() / "agent-server"
    assert loaded == {
        "role": {
            "systemPrompt": (server / "defaults/prompts/systemPrompts/direct.md").read_text(),
            "tools": ["Read", "Write"], "pluginDirs": [], "mcpComposition": "none",
            "mcpConfigPaths": [str(server / "defaults/config/mcp-config-empty.json")],
            "disableHooks": True,
        },
        "policySchema": "cortex-benchmark-resolved-policy/2", "armName": "cortex-direct",
    }


def test_guard_uses_the_exact_public_class_without_stub_trial(tmp_path: Path) -> None:
    agent = public_agent(tmp_path)

    assert type(agent) is CortexBenchAgent
    assert agent.run.__func__ is CortexBenchAgent.run


def vendor_arm() -> dict[str, object]:
    value = cortex_arm()
    value.update({
        "kind": "vendor-baseline", "name": "pure-claude-code",
        "vendor_agent": "claude-code",
    })
    value.pop("backend")
    value.pop("orchestration")
    value["limits"] = {**value["limits"], "max_resident_agent_processes": 1}
    return value


def test_vendor_baseline_uses_harbor_name_without_cortex_install(tmp_path: Path) -> None:
    config = build_agent_config(vendor_arm(), cli_version="1.2.3")
    agent = AgentFactory.create_agent_from_config(config, logs_dir=tmp_path / "vendor")
    environment = RecordingEnvironment()

    asyncio.run(agent.setup(environment))

    commands = [command for command, _ in environment.calls]
    assert config.name == "claude-code"
    assert config.import_path is None
    assert agent.name() == "claude-code"
    assert type(agent) is not CortexBenchAgent
    assert all("npm install" not in command and "cortex" not in command for command in commands)
