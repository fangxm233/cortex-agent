# input:  shipped agent class, shipped agent-run loader, Harbor factory, trial facts
# output: independent parity verdict on the production trial composition
# pos:    Second, independently authored witness over the shipped public entry
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# Independence contract of this module. Read it before touching an assertion.
#
# 1. Nothing here composes. The agent is built through the public
#    `CortexBenchAgent(...)` constructor: no subclass, no monkeypatch, no
#    `setattr` on a production object, no fixture that hands in a role, a system
#    prompt, a tool list, a plugin directory, an MCP config, a thread template,
#    a thread-policy document, a merge step or a scan step. The constructor
#    receives caller-known trial facts only. Whatever the shipped loader reports
#    below was therefore composed by the production path by itself. The scope of
#    this contract is the whole agent-dir output, not the arm resolution alone.
#
# 2. `tests/scan/stub_trial.py` still carries the policy-injection path: it
#    subclasses the shipped agent and overrides `_compose_arm_resolution` with a
#    prebuilt document. That injection has NOT been deleted. This module takes
#    the other admissible route — it constructs the agent independently of that
#    helper. `test_composition_owes_nothing_to_the_stub_trial_helper` asserts
#    the helper module is absent from the interpreter and that the composition
#    hook on the object under test is still the shipped function. That is
#    sufficient because the injection has exactly two seams — importing the
#    helper, or replacing the composition hook on the instance — and both are
#    asserted absent in the same process that produced the argv and the document
#    every other test here reads.
#
# 3. The fake container answers only what the container must answer: the workdir
#    probes, the installed bundle root, and the backend CLI real path and
#    version. Those are container facts, not composition.
#
# 4. Expected values are named literally here so a regression to the neutral
#    no-config path fails. The neutral role is not hardcoded: it is obtained
#    from the same shipped loader in the same process and compared against.

import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from harbor.agents.factory import AgentFactory
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.arms import build_agent_config

IMAGE_DIGEST = f"sha256:{'b' * 64}"
IMAGE_REF = f"registry.invalid/terminal-task@{IMAGE_DIGEST}"
ROOT_RUN_ID = "independent-parity.cortex-direct"
TRIAL_ID = "independent-parity-trial"
ARM_NAME = "cortex-direct"
CODER_REVIEW_ARM_NAME = "cortex-coder-review"
THREAD_POLICY_FILENAME = "benchmark-thread-policy.json"
BENCHMARK_MCP_FILENAME = "mcp-config-benchmark-thread.json"
POLICY_PATH_ENV = "CORTEX_BENCHMARK_THREAD_POLICY_PATH"
# The ten members of the thread-policy document, named here so an eleventh is a failure on this
# side too: everything the production path composes is re-derived from `run_config_path`.
THREAD_POLICY_MEMBERS = {
    "schema_version", "canonical_instruction", "workspace_cwd", "run_config_path", "trial_root",
    "template", "profile_name", "root_run_id", "trajectory_root", "limits",
}
PROFILE_NAME = "benchmark"
MODEL_NAME = "claude-sonnet"
BACKEND_CLI_VERSION = "9.9.9 (fake backend cli)"
CORTEX_CLI_VERSION = "2026.8.3"
CONTAINER_CWD = "/app"

EXPECTED_PARENT_TOOLS = [
    "Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "TodoWrite", "Write",
]
TOOLS_THE_PARENT_MUST_NOT_CARRY = [
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskStop", "WebFetch", "WebSearch",
]
SYSTEM_PROMPT_RELPATH = "defaults/prompts/systemPrompts/direct.md"
DIRECTIVE_RELPATH = "defaults/prompts/directives/executor.md"
PLUGIN_RELPATHS = ["defaults/plugins/cortex-common", "defaults/plugins/cortex-coder"]

# Runs the SHIPPED loader twice in one process: once on the document the public
# entry emitted, once with no --run-config at all. The second call is the
# neutral baseline this gate must not be satisfied by.
LOADER_SCRIPT = """
import { loadAgentRunConfigWithPolicy } from './src/domain/agent-run/run-config.ts';
const slot = process.env.PARITY_AGENT_SLOT;
const composed = loadAgentRunConfigWithPolicy({
  runConfigFile: process.env.PARITY_RUN_CONFIG, agentSlot: slot,
});
const neutral = loadAgentRunConfigWithPolicy({ agentSlot: slot });
console.log(JSON.stringify({
  composedRole: composed.config.role,
  neutralRole: neutral.config.role,
  neutralPolicy: neutral.policy ?? null,
  policySchema: composed.policy?.schema_version ?? null,
  armName: composed.policy?.arm?.name ?? null,
  rootRunId: composed.policy?.root_run_id ?? null,
  roleSlots: Object.keys(composed.policy?.roles ?? {}),
  assets: (composed.policy?.asset_inventory ?? []).map(entry => ({
    kind: entry.kind, logical_name: entry.logical_name, resolved_path: entry.resolved_path,
  })),
}));
"""

# The other half of the shipped boundary: the command line the entry builds must
# also survive the shipped agent-run argument parser, not only the loader.
PARSER_SCRIPT = """
import { parseAgentRunArgs } from './src/domain/agent-run/agent-run-cli.ts';
const argv = JSON.parse(process.env.PARITY_ARGV);
const options = parseAgentRunArgs(argv.slice(2));
console.log(JSON.stringify({
  command: argv.slice(0, 2),
  runConfigFile: options.runConfigFile,
  agentSlot: options.agentSlot,
  profile: options.profile,
  rootRunId: options.rootRunId,
  eventsFile: options.eventsFile,
  trajectoryRoot: options.trajectoryRoot,
  outputFormat: options.outputFormat,
}));
"""


def repository_root() -> Path:
    return Path(__file__).resolve().parents[4]


def bundle_root() -> Path:
    """Stands in for the installed @cortex-agent/server package root."""
    return repository_root() / "agent-server"


class FakeContainer:
    """Answers container probes and records every command, and nothing else."""

    def __init__(self, backend_cli: Path, workdir: str = CONTAINER_CWD) -> None:
        self.backend_cli = backend_cli
        self.workdir = workdir
        self.commands: list[str] = []
        self.exec_kwargs: list[dict[str, object]] = []
        self.uploads: list[tuple[str, str]] = []

    async def exec(self, command: str, **kwargs: object) -> ExecResult:
        self.commands.append(command)
        self.exec_kwargs.append(dict(kwargs))
        payload = command.removeprefix("set -o pipefail; ")
        if payload == "pwd" or payload == f"realpath -- {self.workdir}":
            return ExecResult(stdout=f"{self.workdir}\n", return_code=0)
        if "npm ls --global" in payload:
            return ExecResult(stdout=f"{bundle_root()}\n", return_code=0)
        if "command -v claude" in payload:
            return ExecResult(stdout=f"{self.backend_cli}\n", return_code=0)
        if payload == "claude --version":
            return ExecResult(stdout=f"{BACKEND_CLI_VERSION}\n", return_code=0)
        if payload == "cortex daemon --version":
            return ExecResult(stdout=f"{CORTEX_CLI_VERSION}\n", return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((str(source_path), target_path))


def cortex_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex",
        "name": ARM_NAME,
        "backend": "claude",
        "provider": "anthropic",
        "model": MODEL_NAME,
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 6,
            "max_resident_agent_processes": 1, "max_cost_usd": "1.00",
            "deadline_seconds": 120,
        },
    }


def trial_seed() -> dict[str, object]:
    return {
        "arm": cortex_arm(),
        "arm_path": f"arm://{ARM_NAME}",
        "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
        "task": {
            "task_id": "terminal-task", "image_ref": IMAGE_REF, "image_digest": IMAGE_DIGEST,
        },
        "profile_name": PROFILE_NAME,
        "paid_run": False,
        "credential": {
            "upstream_base_url": "https://api.anthropic.com",
            "route_identity_host": "api.anthropic.com",
            "proxy_base_url": "http://trial-proxy.invalid",
            "dummy_token_ref": "offline-token-handle",
        },
        "model_alias_policy": {"kind": "exact"},
    }


def build_manifest(tmp_path: Path) -> dict[str, object]:
    artifacts = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for artifact in artifacts.values():
        artifact.write_bytes(b"independent parity fixture")
    return {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID, "arm": ARM_NAME,
        **{name: str(path) for name, path in artifacts.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": IMAGE_REF, "image_digest": IMAGE_DIGEST, "image_size_bytes": 26,
    }


def fake_backend_cli(tmp_path: Path) -> Path:
    binary = tmp_path / "container-bin" / "claude"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(b"#!/bin/sh\nexit 0\n")
    return binary


def public_agent(tmp_path: Path) -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "trial" / "agent",
        artifact_dir=tmp_path / "trial" / "artifacts",
        manifest=build_manifest(tmp_path),
        trial_seed=trial_seed(),
    )


def completed_agent(tmp_path: Path) -> tuple[CortexBenchAgent, FakeContainer]:
    agent = public_agent(tmp_path)
    container = FakeContainer(fake_backend_cli(tmp_path))
    asyncio.run(agent.setup(container))
    return agent, container


def coder_review_seed() -> dict[str, object]:
    """The same caller-known facts with one member changed — the orchestration mode — plus the
    capacity that mode requires. Still no role, no template and no policy document."""
    seed = trial_seed()
    arm = dict(seed["arm"])  # type: ignore[arg-type]
    arm["name"] = CODER_REVIEW_ARM_NAME
    arm["orchestration"] = {
        "mode": "coder-review", "coder_review_variant": "audit-retry", "ask_manager": False,
    }
    arm["limits"] = {
        **arm["limits"],  # type: ignore[dict-item]
        "max_thread_starts": 1, "max_resident_agent_processes": 3,
    }
    seed["arm"] = arm
    seed["arm_path"] = f"arm://{CODER_REVIEW_ARM_NAME}"
    return seed


def completed_coder_review(tmp_path: Path) -> tuple[CortexBenchAgent, FakeContainer]:
    agent = CortexBenchAgent(
        logs_dir=tmp_path / "trial" / "agent",
        artifact_dir=tmp_path / "trial" / "artifacts",
        manifest={**build_manifest(tmp_path), "arm": CODER_REVIEW_ARM_NAME},
        trial_seed=coder_review_seed(),
    )
    container = FakeContainer(fake_backend_cli(tmp_path))
    asyncio.run(agent.setup(container))
    asyncio.run(agent.run("Solve the task.", container, AgentContext()))
    return agent, container


def flag_value(argv: list[str], flag: str) -> str:
    assert argv.count(flag) == 1, f"{flag} must appear exactly once in {argv}"
    return argv[argv.index(flag) + 1]


def host_path_behind_mount(agent: CortexBenchAgent, container_path: str) -> Path:
    """Harbor mounts trial_dir/agent at EnvironmentPaths().agent_dir."""
    relative = Path(container_path).relative_to(Path(str(EnvironmentPaths().agent_dir)))
    return agent.logs_dir / relative


def write_benchmark_profile(home: Path) -> None:
    config = home / "config"
    config.mkdir(parents=True, exist_ok=True)
    (config / "profiles.json").write_text(json.dumps({
        "defaultProfile": PROFILE_NAME,
        "profiles": {PROFILE_NAME: {
            "model": MODEL_NAME, "backend": "claude", "provider": "anthropic",
            "claudeBackend": "print", "fallback": [],
        }},
    }))


def load_through_shipped_loader(
    run_config: Path, agent_slot: str, tmp_path: Path,
) -> dict[str, object]:
    node = shutil.which("node")
    assert node is not None, "node is required to run the shipped agent-run loader"
    home = tmp_path / "cortex-home"
    write_benchmark_profile(home)
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.update({
        "CORTEX_HOME": str(home),
        "CORTEX_PROJECTS_DIR": str(home / "projects"),
        "PARITY_RUN_CONFIG": str(run_config),
        "PARITY_AGENT_SLOT": agent_slot,
    })
    result = subprocess.run(
        [node, "--import", "tsx", "--input-type=module", "--eval", LOADER_SCRIPT],
        cwd=bundle_root(), env=env, text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout)
    assert isinstance(loaded, dict)
    return loaded


def test_shipped_entry_emits_run_config_for_a_document_it_wrote(tmp_path: Path) -> None:
    agent, container = completed_agent(tmp_path)

    preview = agent.preview_run_argv()
    run_config = flag_value(preview, "--run-config")

    assert run_config == str(EnvironmentPaths().agent_dir / "arm-resolution.json")
    emitted = host_path_behind_mount(agent, run_config)
    assert emitted.is_file()
    assert json.loads(emitted.read_text())["schema_version"] == (
        "cortex-benchmark-arm-resolution/1"
    )

    asyncio.run(agent.run("Solve the task.", container, AgentContext()))
    invocations = [
        shlex.split(command.removeprefix("set -o pipefail; "))
        for command in container.commands
        if "cortex agent-run" in command and "--help" not in command
    ]
    assert len(invocations) == 1
    assert invocations[0] == preview
    assert flag_value(invocations[0], "--run-config") == run_config


def test_shipped_loader_reports_the_named_composition_not_the_neutral_default(
    tmp_path: Path,
) -> None:
    agent, _ = completed_agent(tmp_path)
    preview = agent.preview_run_argv()
    emitted = host_path_behind_mount(agent, flag_value(preview, "--run-config"))

    loaded = load_through_shipped_loader(
        emitted, flag_value(preview, "--agent-slot"), tmp_path,
    )

    root = bundle_root()
    composed = loaded["composedRole"]
    assert composed == {
        "systemPrompt": (root / SYSTEM_PROMPT_RELPATH).read_text(),
        "tools": EXPECTED_PARENT_TOOLS,
        "pluginDirs": [str(root / relative) for relative in PLUGIN_RELPATHS],
        "mcpComposition": "none",
        "mcpConfigPaths": [],
        "disableHooks": True,
    }
    assert not set(TOOLS_THE_PARENT_MUST_NOT_CARRY) & set(composed["tools"])

    neutral = loaded["neutralRole"]
    assert loaded["neutralPolicy"] is None
    assert neutral["systemPrompt"] == ""
    assert composed["systemPrompt"] != neutral["systemPrompt"]
    assert composed["tools"] != neutral["tools"]
    assert composed["pluginDirs"] != neutral["pluginDirs"] == []
    assert composed["mcpConfigPaths"] != neutral["mcpConfigPaths"]

    assert loaded["policySchema"] == "cortex-benchmark-resolved-policy/2"
    assert loaded["armName"] == ARM_NAME
    assert loaded["roleSlots"] == [flag_value(preview, "--agent-slot")]


def test_shipped_loader_binds_the_document_to_the_rest_of_the_shipped_argv(
    tmp_path: Path,
) -> None:
    agent, _ = completed_agent(tmp_path)
    preview = agent.preview_run_argv()
    emitted = host_path_behind_mount(agent, flag_value(preview, "--run-config"))

    loaded = load_through_shipped_loader(
        emitted, flag_value(preview, "--agent-slot"), tmp_path,
    )

    assert loaded["rootRunId"] == flag_value(preview, "--root-run-id")
    assets = {(entry["kind"], entry["logical_name"]): entry["resolved_path"]
              for entry in loaded["assets"]}
    slot = flag_value(preview, "--agent-slot")
    root = bundle_root()
    assert assets[("profile", flag_value(preview, "--profile"))] == (
        f"profile://{flag_value(preview, '--profile')}"
    )
    assert assets[("prompt", f"{slot}:system_prompt")] == str(root / SYSTEM_PROMPT_RELPATH)
    assert assets[("prompt", f"{slot}:directive")] == str(root / DIRECTIVE_RELPATH)
    assert assets[("cli_artifact", "claude")] == str(fake_backend_cli(tmp_path))


def stub_supervisor(tmp_path: Path) -> Path:
    """The parser resolves a supervisor binary the argv never names.

    `install()` already proves the real one is present and executable inside the
    container, so pointing the documented override at a stand-in here changes
    nothing this test asserts about the emitted argv.
    """
    binary = tmp_path / "supervisor" / "cortex-supervisor"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(b"#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    return binary


def parse_through_shipped_cli(argv: list[str], tmp_path: Path) -> dict[str, object]:
    node = shutil.which("node")
    assert node is not None, "node is required to run the shipped agent-run parser"
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.update({
        "CORTEX_HOME": str(tmp_path / "cortex-home"),
        "CORTEX_SUPERVISOR_BINARY": str(stub_supervisor(tmp_path)),
        "PARITY_ARGV": json.dumps(argv),
    })
    result = subprocess.run(
        [node, "--import", "tsx", "--input-type=module", "--eval", PARSER_SCRIPT],
        cwd=bundle_root(), env=env, text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_shipped_cli_parser_accepts_the_argv_the_entry_builds(tmp_path: Path) -> None:
    workdir = tmp_path / "workspace"
    workdir.mkdir()
    agent = public_agent(tmp_path)
    asyncio.run(agent.setup(FakeContainer(fake_backend_cli(tmp_path), str(workdir))))

    preview = agent.preview_run_argv()
    parsed = parse_through_shipped_cli(preview, tmp_path)

    assert parsed["command"] == ["cortex", "agent-run"]
    assert parsed["runConfigFile"] == flag_value(preview, "--run-config")
    assert parsed["agentSlot"] == flag_value(preview, "--agent-slot")
    assert parsed["profile"] == flag_value(preview, "--profile")
    assert parsed["rootRunId"] == flag_value(preview, "--root-run-id")
    assert parsed["eventsFile"] == flag_value(preview, "--events-file")
    assert parsed["trajectoryRoot"] == flag_value(preview, "--trajectory-root")
    assert parsed["outputFormat"] == flag_value(preview, "--output-format")


def test_composition_owes_nothing_to_the_stub_trial_helper(tmp_path: Path) -> None:
    assert not any(name.endswith("stub_trial") for name in sys.modules)

    agent, _ = completed_agent(tmp_path)

    assert type(agent) is CortexBenchAgent
    assert CortexBenchAgent.__mro__[1].__name__ == "BaseInstalledAgent"
    for method in ("install", "setup", "run", "preview_run_argv", "_compose_arm_resolution"):
        assert getattr(agent, method).__func__ is getattr(CortexBenchAgent, method)
    assert not any(name.endswith("stub_trial") for name in sys.modules)

    document = json.loads((agent.logs_dir / "arm-resolution.json").read_text())
    assert document["cli_artifact"] == {
        "path": str(fake_backend_cli(tmp_path)), "version": BACKEND_CLI_VERSION,
    }
    assert document["thread_templates"] == {}
    assert document["thread_agents"] == {}


def test_the_thread_policy_is_the_shipped_writers_output_not_a_fixtures(tmp_path: Path) -> None:
    """P1, with its scope extended from the arm resolution to the thread policy. This module hands
    the entry no document of any kind; the one read below exists because the shipped writer ran."""
    assert not any(name.endswith("stub_trial") for name in sys.modules)

    agent, _ = completed_coder_review(tmp_path)

    for method in ("install", "setup", "run", "preview_run_argv",
                   "_compose_arm_resolution", "_write_thread_policy"):
        assert getattr(agent, method).__func__ is getattr(CortexBenchAgent, method)
    document = json.loads((agent.logs_dir / THREAD_POLICY_FILENAME).read_text())
    assert document["schema_version"] == "cortex-benchmark-thread-policy/2"
    assert document["run_config_path"] == str(
        EnvironmentPaths().agent_dir / "arm-resolution.json",
    )
    assert document["canonical_instruction"] == "Solve the task."
    assert document["workspace_cwd"] == CONTAINER_CWD
    # PW3-NEG on the produced bytes, not only on the reading schema.
    assert set(document) == THREAD_POLICY_MEMBERS
    assert not any(name.endswith("stub_trial") for name in sys.modules)


def test_no_profile_borne_policy_path_injection_reaches_the_trial(tmp_path: Path) -> None:
    """P6. The one place the server's policy path may come from is the launcher's own MCP
    declaration. A profile `extraEnv` entry carrying it — the test-only glue this gate exists to
    forbid — reaches the model process and never the MCP child, so a trial that depended on one
    would be green here and dead in a container."""
    agent, _ = completed_coder_review(tmp_path)
    home = tmp_path / "cortex-home"
    write_benchmark_profile(home)

    profile = (home / "config" / "profiles.json").read_text()

    assert POLICY_PATH_ENV not in profile
    carriers = sorted(
        path.name for path in agent.logs_dir.rglob("*")
        if path.is_file() and POLICY_PATH_ENV in path.read_text(errors="ignore")
    )
    assert carriers == [BENCHMARK_MCP_FILENAME]
    declaration = json.loads((agent.logs_dir / BENCHMARK_MCP_FILENAME).read_text())
    env = declaration["mcpServers"]["cortex-benchmark-thread"]["env"]
    assert env[POLICY_PATH_ENV] == str(EnvironmentPaths().agent_dir / THREAD_POLICY_FILENAME)


def vendor_baseline_arm() -> dict[str, object]:
    arm = cortex_arm()
    arm.pop("backend")
    arm.pop("orchestration")
    arm.update({
        "kind": "vendor-baseline", "name": "pure-claude-code", "vendor_agent": "claude-code",
    })
    return arm


def test_vendor_baseline_selects_the_harbor_builtin_and_never_installs_cortex(
    tmp_path: Path,
) -> None:
    config = build_agent_config(vendor_baseline_arm(), cli_version=CORTEX_CLI_VERSION)
    logs_dir = tmp_path / "vendor" / "agent"
    agent = AgentFactory.create_agent_from_config(config, logs_dir=logs_dir)
    container = FakeContainer(fake_backend_cli(tmp_path))

    asyncio.run(agent.setup(container))

    assert config.name == "claude-code"
    assert config.import_path is None
    assert agent.name() == "claude-code"
    assert CortexBenchAgent not in type(agent).__mro__
    for command in container.commands:
        assert "@cortex-agent/server" not in command
        assert "/installed-agent/npm" not in command
        assert "cortex agent-run" not in command
    assert not (logs_dir / "arm-resolution.json").exists()
    assert all("server.tgz" not in target for _, target in container.uploads)
