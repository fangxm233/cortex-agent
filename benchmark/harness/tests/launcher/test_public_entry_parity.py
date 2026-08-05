# input:  shipped agent/loader, trial seed, container facts, Harbor factory
# output: seed-only composition compiled by the real compiler, for every lifted backend
# pos:    Public entry composes the trial with no caller-supplied assets
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# This file supplies the launcher NOTHING but caller-known trial facts: no role,
# no MCP config, no thread template, no prebuilt resolution document and no
# thread-policy document. Whatever the shipped loader reports below was therefore
# composed by the production path itself.
#
# WHAT PASSING THIS MODULE LICENSES, AND WHAT IT DOES NOT. Green here licenses the
# claim "the production entry composes the in-trial thread": the entry produced the
# documents, the shipped compiler accepted them in a separate process, and the trial
# spawn surface derived from them names the trial's own pinned CLI and environment.
# It does NOT license "backend neutrality is proven end-to-end" — that needs a real
# step taken on both backends, which nothing here takes. A green test at the
# component layer read as a claim at the product layer is the exact failure this
# module exists to prevent.

import asyncio
import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest
from harbor.agents.factory import AgentFactory
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.arms import BACKEND_CLI_BINARIES, build_agent_config

DIGEST = f"sha256:{'a' * 64}"
ROOT_RUN_ID = "trial-parity.cortex-direct"
BACKEND_CLI_VERSION = "1.2.3 (Claude Code)"
PI_CLI_VERSION = "2026.8.3 (pi)"
FROZEN_TOOLS = [
    "Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "TodoWrite", "Write",
]
# The direct-PI parent surface is the frozen table with exactly one member changed: the same nine
# capabilities under PI-native labels, because one label set shared across backends is wrong on one
# of them. Design section 13.10.3.
FROZEN_PI_TOOLS = [
    "agent", "bash", "edit", "glob", "grep", "read", "skill", "todo_write", "write",
]
FORBIDDEN_TOOLS = [
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskStop", "WebFetch", "WebSearch",
]
ROLE_TOOL_SURFACE_HASH = re.compile(r"[0-9a-f]{64}\Z")
ARM_NAMES = {"claude": "cortex-direct", "pi": "cortex-pi-direct"}
CODER_REVIEW_ARM_NAMES = {"claude": "cortex-coder-review", "pi": "cortex-pi-coder-review"}
# The implementing slot's surface, in each backend's own labels. Restated rather than imported so a
# change to the composer is a failure here rather than a silently agreeing pair.
EXPECTED_CODER_TOOLS = {
    "claude": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite", "Skill"],
    "pi": ["bash", "read", "write", "edit", "glob", "grep", "todo_write", "skill"],
}
# A coder-review arm blocks inside one MCP call for the whole thread, and the Claude CLI owns that
# client — so the container must answer with a version whose long-call behaviour was verified, or
# the compile refuses. It is a container fact here exactly as it is in production.
LONG_MCP_CALL_CLI_VERSIONS = {"claude": "2.1.220 (Claude Code)", "pi": PI_CLI_VERSION}
CLI_VERSIONS = {"claude": BACKEND_CLI_VERSION, "pi": PI_CLI_VERSION}
FROZEN_PARENT_TOOLS = {"claude": FROZEN_TOOLS, "pi": FROZEN_PI_TOOLS}
# The compiled guard and the parent role hash are read from the RESOLVED policy, which only exists
# once the real TypeScript compiler has accepted the composed document. Reporting them here is what
# makes this a seam test rather than a check that the producer returned a dict.
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
  policyGuard: loaded.policy?.role_policy_guard?.parent,
  roleToolSurfaceHash: loaded.policy?.identity?.role_tool_surface_hash?.parent,
}));
"""

# The in-trial step's spawn surface, built by the shipped per-trial factory rather than described.
# The negative branch runs the same factory over a load that has no compiled policy: there is then
# no pinned CLI and no pinned environment to carry, and the factory says so by refusing.
TRIAL_SPAWN_SCRIPT = """
import { loadAgentRunConfigWithPolicy } from './src/domain/agent-run/run-config.ts';
import { preparePinnedTrialPaths } from './src/domain/agent-run/pinned-node-process.ts';
import { trialRunOptions } from './src/domain/benchmark/trial-adapter-factory.ts';
const slot = process.env.CORTEX_PARITY_SLOT;
const paths = preparePinnedTrialPaths(process.env.CORTEX_PARITY_TRIAL_ROOT);
const spec = {
  config: null, slot, paths,
  supervisor: { binary: process.execPath, graceMs: 1 },
  cwd: process.env.CORTEX_PARITY_CWD,
};
const composed = loadAgentRunConfigWithPolicy({
  runConfigFile: process.env.CORTEX_PARITY_RUN_CONFIG, agentSlot: 'parent',
});
const neutral = loadAgentRunConfigWithPolicy({ agentSlot: 'parent' });
const options = trialRunOptions({ ...spec, policy: composed.policy, config: composed.config });
let neutralRefusal = null;
try {
  trialRunOptions({ ...spec, policy: neutral.policy, config: neutral.config });
} catch (error) {
  neutralRefusal = String(error?.message ?? error);
}
console.log(JSON.stringify({
  cliPath: options.cliPath,
  pinnedEnv: options.pinnedEnv,
  tools: options.tools,
  neutralPolicy: neutral.policy ?? null,
  neutralRefusal,
}));
"""


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def server_root() -> Path:
    return repo_root() / "agent-server"


def backend_cli_path() -> str:
    node = shutil.which("node")
    assert node is not None
    return node


class RecordingEnvironment:
    """The container the agent probes. It answers for whichever backend CLI the arm names, so the
    PI row exercises the same production probe path as the Claude row rather than a stub."""

    def __init__(self, backend: str = "claude", cli_version: str | None = None) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.uploads: list[tuple[Path | str, str]] = []
        self.binary = BACKEND_CLI_BINARIES[backend]
        self.cli_version = cli_version or CLI_VERSIONS[backend]

    async def exec(self, command: str, **kwargs: object) -> ExecResult:
        self.calls.append((command, kwargs))
        if command.endswith("pwd") or "realpath -- /app" in command:
            return ExecResult(stdout="/app\n", return_code=0)
        if "npm ls --global" in command:
            return ExecResult(stdout=f"{server_root()}\n", return_code=0)
        if command.endswith("cortex daemon --version"):
            return ExecResult(stdout="2026.8.3-2\n", return_code=0)
        if f"command -v {self.binary}" in command:
            return ExecResult(stdout=f"{backend_cli_path()}\n", return_code=0)
        if command.endswith(f"{self.binary} --version"):
            return ExecResult(stdout=f"{self.cli_version}\n", return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((source_path, target_path))


def cortex_arm(backend: str = "claude") -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": ARM_NAMES[backend],
        "backend": backend, "provider": "anthropic", "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0,
            "max_task_depth": 0, "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 90,
        },
    }


def trial_seed(backend: str = "claude") -> dict[str, object]:
    seed: dict[str, object] = {
        "arm": cortex_arm(backend), "arm_path": f"arm://{ARM_NAMES[backend]}",
        "trial_id": "trial-parity", "root_run_id": ROOT_RUN_ID,
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {"upstream_base_url": "https://api.anthropic.com",
                       "route_identity_host": "api.anthropic.com",
                       "proxy_base_url": "http://trial-proxy.invalid",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": {"kind": "exact"},
    }
    if backend == "pi":
        # Section 3.1(h.5) row 4 lifts the PI refusal only behind this proof, and the compiler
        # gates on it independently with code 14.
        seed["pi_benchmark_capability_proven"] = True
    return seed


def manifest(tmp_path: Path, backend: str = "claude") -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"parity fixture")
    return {
        "root_run_id": ROOT_RUN_ID, "trial_id": "trial-parity", "arm": ARM_NAMES[backend],
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"registry.invalid/task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": len(b"parity fixture"),
    }


def public_agent(tmp_path: Path, backend: str = "claude") -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest=manifest(tmp_path, backend), trial_seed=trial_seed(backend),
    )


def coder_review_seed(backend: str = "claude") -> dict[str, object]:
    """The direct seed with its orchestration mode changed and the capacity that mode needs. Still
    caller-known trial facts only: no role, no template, no policy document."""
    seed = trial_seed(backend)
    arm = dict(seed["arm"])  # type: ignore[arg-type]
    arm["name"] = CODER_REVIEW_ARM_NAMES[backend]
    arm["orchestration"] = {
        "mode": "coder-review", "coder_review_variant": "audit-retry", "ask_manager": False,
    }
    arm["limits"] = {
        **arm["limits"],  # type: ignore[dict-item]
        "max_thread_starts": 1, "max_resident_agent_processes": 3,
    }
    seed["arm"] = arm
    seed["arm_path"] = f"arm://{CODER_REVIEW_ARM_NAMES[backend]}"
    return seed


def coder_review_agent(tmp_path: Path, backend: str = "claude") -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest={**manifest(tmp_path, backend), "arm": CODER_REVIEW_ARM_NAMES[backend]},
        trial_seed=coder_review_seed(backend),
    )


def host_path_behind_mount(agent: CortexBenchAgent, container_path: str) -> Path:
    return agent.logs_dir / Path(container_path).relative_to(Path("/logs/agent"))


def write_profile(home: Path, backend: str = "claude") -> None:
    config = home / "config"
    config.mkdir(parents=True)
    (config / "profiles.json").write_text(json.dumps({
        "defaultProfile": "benchmark",
        "profiles": {"benchmark": {
            "model": "claude-sonnet", "backend": backend, "provider": "anthropic",
            "claudeBackend": "print", "fallback": [],
        }},
    }))


def load_emitted_role(
    run_config: Path, tmp_path: Path, backend: str = "claude",
) -> dict[str, object]:
    home = tmp_path / "cortex-home"
    write_profile(home, backend)
    env = os.environ.copy()
    env.update({
        "CORTEX_HOME": str(home),
        "CORTEX_PROJECTS_DIR": str(home / "projects"),
        "CORTEX_PARITY_RUN_CONFIG": str(run_config),
    })
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "--eval", LOADER_SCRIPT],
        cwd=server_root(), env=env, text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout)
    assert isinstance(loaded, dict)
    return loaded


def load_trial_spawn_surface(
    run_config: Path, tmp_path: Path, backend: str, trial_root: Path,
) -> dict[str, object]:
    home = tmp_path / "spawn-home"
    write_profile(home, backend)
    env = os.environ.copy()
    env.update({
        "CORTEX_HOME": str(home),
        "CORTEX_PROJECTS_DIR": str(home / "projects"),
        "CORTEX_PARITY_RUN_CONFIG": str(run_config),
        "CORTEX_PARITY_TRIAL_ROOT": str(trial_root),
        "CORTEX_PARITY_SLOT": "benchmark-coder",
        "CORTEX_PARITY_CWD": "/app",
    })
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "--eval", TRIAL_SPAWN_SCRIPT],
        cwd=server_root(), env=env, text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout)
    assert isinstance(loaded, dict)
    return loaded


def compose_through_public_entry(
    tmp_path: Path, backend: str,
) -> tuple[CortexBenchAgent, RecordingEnvironment]:
    agent = public_agent(tmp_path, backend)
    environment = RecordingEnvironment(backend)
    asyncio.run(agent.setup(environment))
    return agent, environment


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


def test_public_entry_argv_loads_the_frozen_direct_composition(tmp_path: Path) -> None:
    agent, environment = compose_through_public_entry(tmp_path, "claude")

    loaded = load_emitted_role(assert_run_argv(agent, environment), tmp_path)

    # The parent role-tool-surface hash is deliberately NOT pinned to a literal here. It is not
    # freezable over a LIVE bundle: role-surface.ts:64 projects the plugin directory's ABSOLUTE path
    # next to directoryContentSha256's live content, and identity.ts:169 folds both into the hash. So
    # the value moves with the checkout directory (a worktree yields a different one than the primary
    # checkout at the same commit) and with any edit to a skill under defaults/plugins. Here the
    # stubbed `npm ls --global` probe answers with the host checkout; in production it answers with
    # the fixed container install path, which is why production is stable and this test is not. The
    # frozen parent-surface literals live over fully controlled inputs, in
    # agent-server/tests/domain/agent-run/identity.test.ts — "freezes the guarded direct-Claude
    # parent surface hash" and its PI twin. Do not pin a literal here; that is the red row this
    # comment exists to prevent.
    assert ROLE_TOOL_SURFACE_HASH.match(loaded.pop("roleToolSurfaceHash"))

    server = server_root()
    assert loaded == {
        "role": {
            "systemPrompt": (server / "defaults/prompts/systemPrompts/direct.md").read_text(),
            "tools": FROZEN_TOOLS,
            "pluginDirs": [
                str(server / "defaults/plugins/cortex-common"),
                str(server / "defaults/plugins/cortex-coder"),
            ],
            "mcpComposition": "none", "mcpConfigPaths": [], "disableHooks": True,
        },
        "policySchema": "cortex-benchmark-resolved-policy/2", "armName": "cortex-direct",
        # The guard is derived by the compiler from this very role: one key for the only lease state
        # a direct arm can be in, the frozen tool list verbatim as its allow-list, nothing enumerated
        # as denied. The six tools of section 3.1(h.4) are denied by being absent from it.
        "policyGuard": {"parent-writable": FROZEN_TOOLS},
    }
    assert not set(FORBIDDEN_TOOLS) & set(FROZEN_TOOLS)


@pytest.mark.parametrize("backend", ["claude", "pi"])
def test_public_entry_composition_compiles_for_every_lifted_backend(
    tmp_path: Path, backend: str,
) -> None:
    """The seam, executed on both sides: nothing but caller-known trial facts goes in, and the real
    TypeScript compiler — not a fixture standing in for it — is what accepts what comes out."""
    agent, environment = compose_through_public_entry(tmp_path, backend)

    loaded = load_emitted_role(assert_run_argv(agent, environment), tmp_path, backend)

    tools = FROZEN_PARENT_TOOLS[backend]
    assert loaded["policySchema"] == "cortex-benchmark-resolved-policy/2"
    assert loaded["armName"] == ARM_NAMES[backend]
    assert loaded["role"]["tools"] == tools
    assert loaded["policyGuard"] == {"parent-writable": tools}
    # Shape, not a literal — see the comment in the frozen-composition test above.
    assert ROLE_TOOL_SURFACE_HASH.match(loaded["roleToolSurfaceHash"])


def test_public_entry_sources_container_facts_not_the_caller(tmp_path: Path) -> None:
    agent = public_agent(tmp_path)
    asyncio.run(agent.setup(RecordingEnvironment()))

    document = json.loads((agent.logs_dir / "arm-resolution.json").read_text())

    assert document["cli_artifact"] == {
        "path": backend_cli_path(), "version": BACKEND_CLI_VERSION,
    }
    assert document["roles"]["parent"]["directive_path"] == str(
        server_root() / "defaults/prompts/directives/executor.md",
    )
    assert document["thread_templates"] == {}
    assert document["thread_agents"] == {}


def test_public_entry_produces_the_thread_policy_beside_the_resolution(tmp_path: Path) -> None:
    """P2/P3. The thread-policy document has a production producer, and it is this entry: nothing
    below writes one, and the `--run-config` the entry actually executes is the same path the
    produced document names as the compiler input its server re-derives everything from."""
    agent = coder_review_agent(tmp_path)
    environment = RecordingEnvironment("claude", LONG_MCP_CALL_CLI_VERSIONS["claude"])
    asyncio.run(agent.setup(environment))

    resolution = assert_run_argv(agent, environment)

    document = json.loads((agent.logs_dir / "benchmark-thread-policy.json").read_text())
    assert document["schema_version"] == "cortex-benchmark-thread-policy/2"
    assert host_path_behind_mount(agent, document["run_config_path"]) == resolution
    assert document["canonical_instruction"] == "Complete the task."
    assert document["workspace_cwd"] == "/app"
    assert document["template"] == "benchmark-coder-review"
    assert document["root_run_id"] == ROOT_RUN_ID
    assert document["limits"]["max_calls"] == 1
    # The server refuses a writable document, and the file it will read is this one.
    assert (agent.logs_dir / "benchmark-thread-policy.json").stat().st_mode & 0o222 == 0
    # O2: the MCP declaration the parent role's `mcp_config_paths` names is written by the same
    # entry. Without it the parent composes a config path that does not exist.
    mcp = json.loads((agent.logs_dir / "mcp-config-benchmark-thread.json").read_text())
    entry = mcp["mcpServers"]["cortex-benchmark-thread"]
    assert entry["env"]["CORTEX_BENCHMARK_THREAD_POLICY_PATH"] == document["run_config_path"].replace(
        "arm-resolution.json", "benchmark-thread-policy.json",
    )
    assert json.loads(resolution.read_text())["roles"]["parent"]["mcp_config_paths"] == [
        "/logs/agent/mcp-config-benchmark-thread.json",
    ]


def host_readable_resolution(
    agent: CortexBenchAgent, resolution: Path, tmp_path: Path,
) -> Path:
    """The emitted document with its container mount relocated onto the host, and nothing else.

    Harbor mounts `trial_dir/agent` at `/logs/agent`. The launcher writes the parent's MCP
    declaration there and the shipped compiler reads its bytes, so on the host the one member
    naming that mount has to be read from behind it. Exactly that member is rewritten — the
    mapping `host_path_behind_mount` already performs for the resolution itself — and no role, no
    prompt, no tool list, no template and no value of any kind is supplied.
    """
    original = json.loads(resolution.read_text())
    document = json.loads(resolution.read_text())
    role = document["roles"]["parent"]
    role["mcp_config_paths"] = [
        str(host_path_behind_mount(agent, path)) for path in role["mcp_config_paths"]
    ]
    assert role["mcp_config_paths"] != original["roles"]["parent"]["mcp_config_paths"]
    original["roles"]["parent"]["mcp_config_paths"] = role["mcp_config_paths"]
    assert document == original, "relocation must move the mount and change nothing else"
    relocated = tmp_path / "relocated-arm-resolution.json"
    relocated.write_text(json.dumps(document))
    return relocated


@pytest.mark.parametrize("backend", ["claude", "pi"])
def test_the_produced_document_compiles_the_thread_half_for_every_backend(
    tmp_path: Path, backend: str,
) -> None:
    """P4. The compiled policy is reachable from the thread-policy document alone: its
    `run_config_path` is the whole of what the server process is given, and the shipped compiler
    accepts it in a separate process with both thread halves filled."""
    agent = coder_review_agent(tmp_path, backend)
    environment = RecordingEnvironment(backend, LONG_MCP_CALL_CLI_VERSIONS[backend])
    asyncio.run(agent.setup(environment))
    resolution = assert_run_argv(agent, environment)
    document = json.loads((agent.logs_dir / "benchmark-thread-policy.json").read_text())
    assert host_path_behind_mount(agent, document["run_config_path"]) == resolution

    loaded = load_emitted_role(
        host_readable_resolution(agent, resolution, tmp_path), tmp_path, backend,
    )

    assert loaded["policySchema"] == "cortex-benchmark-resolved-policy/2"
    assert loaded["armName"] == CODER_REVIEW_ARM_NAMES[backend]
    # The two members a direct arm leaves empty, inverted: this is the thread half of the
    # composition, and without it the in-trial thread has no template and no agents to run.
    composed = json.loads(resolution.read_text())
    assert composed["thread_templates"] != {}
    assert composed["thread_agents"] != {}
    assert document["template"] in composed["thread_templates"]
    assert set(composed["thread_agents"]) == {"benchmark-coder", "benchmark-reviewer"}


@pytest.mark.parametrize("backend", ["claude", "pi"])
def test_the_in_trial_step_spawn_surface_comes_from_the_compiled_policy(
    tmp_path: Path, backend: str,
) -> None:
    """P5. Neutrality is proven at the backend rather than at the injection point: the step's spawn
    surface names the trial's own pinned CLI and its pinned environment, both derived from the
    compiled policy, and the same factory over a load with no policy produces neither. The executed
    half — a real supervised spawn of that CLI — is proved by the server suite
    `benchmark-production-wiring.test.ts`; what is proved here is that the production entry's own
    document is what the surface is built from."""
    agent = coder_review_agent(tmp_path, backend)
    environment = RecordingEnvironment(backend, LONG_MCP_CALL_CLI_VERSIONS[backend])
    asyncio.run(agent.setup(environment))
    resolution = assert_run_argv(agent, environment)
    trial_root = tmp_path / "trial-home"

    loaded = load_trial_spawn_surface(
        host_readable_resolution(agent, resolution, tmp_path),
        tmp_path, backend, trial_root,
    )

    assert loaded["cliPath"] == backend_cli_path()
    assert loaded["pinnedEnv"]["CORTEX_HOME"] == str(trial_root / "cortex-home")
    assert loaded["pinnedEnv"]["HOME"] == str(trial_root / "home")
    assert loaded["tools"] == ",".join(EXPECTED_CODER_TOOLS[backend])
    # The negative branch. With no compiled policy there is no pinned CLI and no pinned
    # environment to carry, and the shipped factory refuses rather than composing a host-shaped one.
    assert loaded["neutralPolicy"] is None
    assert loaded["neutralRefusal"] is not None


def test_a_direct_arm_produces_no_thread_policy_and_no_mcp_declaration(tmp_path: Path) -> None:
    agent, environment = compose_through_public_entry(tmp_path, "claude")
    asyncio.run(agent.run("Complete the task.", environment, AgentContext()))

    assert not (agent.logs_dir / "benchmark-thread-policy.json").exists()
    assert not (agent.logs_dir / "mcp-config-benchmark-thread.json").exists()


def test_public_constructor_refuses_a_prebuilt_resolution(tmp_path: Path) -> None:
    composed = {
        **trial_seed(), "schema_version": "cortex-benchmark-arm-resolution/1",
        "roles": {"parent": {"tools": ["Read"]}}, "thread_templates": {},
    }

    with pytest.raises(ValueError, match="roles"):
        CortexBenchAgent(
            logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
            manifest=manifest(tmp_path), trial_seed=composed,
        )


def test_guard_uses_the_exact_public_class_without_stub_trial(tmp_path: Path) -> None:
    agent = public_agent(tmp_path)

    assert type(agent) is CortexBenchAgent
    assert agent.run.__func__ is CortexBenchAgent.run
    assert agent.setup.__func__ is CortexBenchAgent.setup


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
