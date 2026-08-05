# input:  trial seed, container-observed bundle root and backend CLI facts
# output: composed phase-A ArmResolution JSON document and agent-dir file
# pos:    Launcher-owned composer for the benchmark compiler input
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath

from harbor.models.trial.paths import EnvironmentPaths

from .arms import (
    CODER_REVIEW_MODE,
    arm_backend,
    arm_coder_review_variant,
    arm_orchestration_mode,
    require_composable_arm,
)
from .credential_capabilities import project_credential_capabilities

ARM_RESOLUTION_SCHEMA_VERSION = "cortex-benchmark-arm-resolution/1"
ARM_RESOLUTION_SOURCE = "arm_resolution"
ARM_RESOLUTION_FILENAME = "arm-resolution.json"
ARM_RESOLUTION_CONTAINER_PATH: PurePosixPath = (
    EnvironmentPaths().agent_dir / ARM_RESOLUTION_FILENAME
)
DIRECT_CLAUDE_SYSTEM_PROMPT = "defaults/prompts/systemPrompts/direct.md"
DIRECT_CLAUDE_DIRECTIVE = "defaults/prompts/directives/executor.md"
DIRECT_CLAUDE_TOOLS = (
    "Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "TodoWrite", "Write",
)
# Design section 3.1(h.3) is frozen for the direct-CLAUDE parent, and (h.5)'s closing sentence lets
# the lifting gate extend the composer with its own role set rather than widen (h.3). So the direct
# PI parent is (h.3) with exactly ONE member changed: the same nine capabilities under PI-native
# labels, because a single label set shared across backends is wrong on one of them (section 6.6).
DIRECT_PI_TOOLS = (
    "agent", "bash", "edit", "glob", "grep", "read", "skill", "todo_write", "write",
)
DIRECT_PARENT_TOOLS = {"claude": DIRECT_CLAUDE_TOOLS, "pi": DIRECT_PI_TOOLS}
DIRECT_CLAUDE_PLUGIN_DIRS = ("defaults/plugins/cortex-common", "defaults/plugins/cortex-coder")

# --- coder-review composition -------------------------------------------------------------------
# A coder-review parent does the direct parent's work plus one thread start, so exactly ONE member
# of the direct surface changes: the MCP composition, and the single config path that value forces.
# `thread_run` is an MCP tool rather than a `tools` member, so the native tool list is untouched.
CODER_REVIEW_PARENT_MCP_COMPOSITION = "benchmark-thread-run"
# Design (14.6.4) EV-ENV fixes the filename to the shipped constant's basename
# (`config-generator.ts:19`, `mcp-config-benchmark-thread.json`), superseding the placeholder name
# (14.2.3)'s row originally used: two names for one declaration would be the same drift RB-EXTRACT
# exists to prevent, with each side individually valid.
BENCHMARK_THREAD_MCP_FILENAME = "mcp-config-benchmark-thread.json"
BENCHMARK_THREAD_MCP_SOURCE = "benchmark_thread_mcp"
BENCHMARK_THREAD_MCP_CONTAINER_PATH: PurePosixPath = (
    EnvironmentPaths().agent_dir / BENCHMARK_THREAD_MCP_FILENAME
)
# The spawned benchmark-thread server must read the same store root as the coordinator, or the
# trial runs with a split brain. EV-ENV therefore makes the emitted config carry the coordinator's
# CORTEX_HOME. The coordinator pins it as <trialRoot>/cortex-home
# (`pinned-node-process.ts:179,217`) where trialRoot is dirname(trajectoryRoot)/trial-home
# (`runner.ts:361`) and the shipped launcher always passes
# trajectoryRoot = <agent_dir>/trajectory (`harbor_agent.py:_agent_paths`), so the value is a
# deterministic function of the agent dir this module already writes the resolution into.
CODER_REVIEW_CORTEX_HOME: PurePosixPath = (
    EnvironmentPaths().agent_dir / "trial-home" / "cortex-home"
)
BENCHMARK_THREAD_MCP_SERVER = "cortex-benchmark-thread"
BENCHMARK_THREAD_SERVER_SCRIPT = "dist/domain/mcp/benchmark-thread-server.js"

THREAD_TEMPLATES_DIR = "defaults/config/thread-templates"
SYSTEM_PROMPTS_DIR = "defaults/prompts/systemPrompts"
DIRECTIVES_DIR = "defaults/prompts/directives"

# A child role's tools are its agent document's `tools` string in document order, with the PI-native
# image substituted for a PI arm. The bundle is a container path the host cannot read at compose
# time, so the two columns are frozen here and pinned against the documents by the server suites.
CODER_REVIEW_CHILD_TOOLS: dict[str, dict[str, tuple[str, ...]]] = {
    "claude": {
        "benchmark-coder": (
            "Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite", "Skill",
        ),
        "benchmark-reviewer": ("Bash", "Read", "Glob", "Grep", "TodoWrite", "Skill"),
        "benchmark-fixer": (
            "Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite", "Skill",
        ),
    },
    "pi": {
        "benchmark-coder": (
            "bash", "read", "write", "edit", "glob", "grep", "todo_write", "skill",
        ),
        "benchmark-reviewer": ("bash", "read", "glob", "grep", "todo_write", "skill"),
        "benchmark-fixer": (
            "bash", "read", "write", "edit", "glob", "grep", "todo_write", "skill",
        ),
    },
}
# The variant selects the child roles, never the parent's surface.
CODER_REVIEW_CHILD_SLOTS: dict[str, tuple[str, ...]] = {
    "audit-retry": ("benchmark-coder", "benchmark-reviewer"),
    "reviewer-fix": ("benchmark-coder", "benchmark-fixer"),
}
CODER_REVIEW_TEMPLATE: dict[str, str] = {
    "audit-retry": "benchmark-coder-review",
    "reviewer-fix": "benchmark-coder-review-fix",
}


@dataclass(frozen=True)
class TrialSeed:
    """Caller-known trial facts. Every other resolution member is launcher-owned."""

    arm: Mapping[str, object]
    arm_path: str
    trial_id: str
    root_run_id: str
    task: Mapping[str, object]
    profile_name: str
    paid_run: bool
    credential: Mapping[str, object]
    model_alias_policy: object
    expected_asset_hashes: Mapping[str, str] | None = None
    pi_benchmark_capability_proven: bool | None = None


@dataclass(frozen=True)
class ContainerFacts:
    """Facts only the running container can answer, captured at install time."""

    bundle_root: str
    backend_cli_path: str
    backend_cli_version: str


@dataclass(frozen=True)
class ArmResolutionInputs:
    arm: Mapping[str, object]
    arm_path: str
    trial_id: str
    root_run_id: str
    task: Mapping[str, object]
    profile_name: str
    paid_run: bool
    credential: Mapping[str, object]
    cli_artifact: Mapping[str, object]
    model_alias_policy: object
    roles: Mapping[str, object]
    thread_templates: Mapping[str, str]
    thread_agents: Mapping[str, str]
    artifact_inventory_spec: object
    expected_asset_hashes: Mapping[str, str] | None = None
    pi_benchmark_capability_proven: bool | None = None


SEED_REQUIRED_FIELDS = frozenset({
    "arm", "arm_path", "trial_id", "root_run_id", "task", "profile_name", "paid_run",
    "credential", "model_alias_policy",
})
SEED_OPTIONAL_FIELDS = frozenset({
    "expected_asset_hashes", "pi_benchmark_capability_proven",
})


def _seed_text(values: Mapping[str, object], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"TrialSeed field '{key}' must be a non-empty string")
    return value


def _seed_mapping(values: Mapping[str, object], key: str) -> Mapping[str, object]:
    value = values.get(key)
    if not isinstance(value, Mapping):
        raise ValueError(f"TrialSeed field '{key}' must be a mapping")
    return value


def parse_trial_seed(source: Mapping[str, object]) -> TrialSeed:
    rejected = sorted(set(source) - SEED_REQUIRED_FIELDS - SEED_OPTIONAL_FIELDS)
    if rejected:
        raise ValueError(f"TrialSeed rejects launcher-owned fields {rejected}")
    missing = sorted(SEED_REQUIRED_FIELDS - set(source))
    if missing:
        raise ValueError(f"TrialSeed requires fields {missing}")
    values = _json_copy(source)
    if not isinstance(values, Mapping):
        raise ValueError("TrialSeed must be a mapping")
    paid_run = values["paid_run"]
    if not isinstance(paid_run, bool):
        raise ValueError("TrialSeed field 'paid_run' must be a boolean")
    hashes = values.get("expected_asset_hashes")
    if hashes is not None and not isinstance(hashes, Mapping):
        raise ValueError("TrialSeed field 'expected_asset_hashes' must be a mapping")
    proven = values.get("pi_benchmark_capability_proven")
    if proven is not None and not isinstance(proven, bool):
        raise ValueError("TrialSeed field 'pi_benchmark_capability_proven' must be a boolean")
    return TrialSeed(
        arm=_seed_mapping(values, "arm"),
        arm_path=_seed_text(values, "arm_path"),
        trial_id=_seed_text(values, "trial_id"),
        root_run_id=_seed_text(values, "root_run_id"),
        task=_seed_mapping(values, "task"),
        profile_name=_seed_text(values, "profile_name"),
        paid_run=paid_run,
        credential=_seed_mapping(values, "credential"),
        model_alias_policy=values["model_alias_policy"],
        expected_asset_hashes=hashes,
        pi_benchmark_capability_proven=proven,
    )


def _plain_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {str(key): _plain_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json(item) for item in value]
    return value


def _json_copy(value: object) -> object:
    return json.loads(json.dumps(_plain_json(value)))


def _require_fields(
    value: Mapping[str, object], expected: frozenset[str], label: str,
) -> None:
    if set(value) != expected:
        raise ValueError(f"ArmResolution {label} fields must be exactly {sorted(expected)}")


def _validate_inputs(inputs: ArmResolutionInputs) -> None:
    if inputs.arm.get("kind") != "cortex":
        raise ValueError("ArmResolution is emitted only for Cortex arms")
    _require_fields(
        inputs.task, frozenset({"task_id", "image_ref", "image_digest"}), "task",
    )
    _require_fields(inputs.credential, frozenset({
        "upstream_base_url", "route_identity_host", "proxy_base_url", "dummy_token_ref",
    }), "credential")
    _require_fields(inputs.cli_artifact, frozenset({"path", "version"}), "cli_artifact")
    expected = (
        inputs.artifact_inventory_spec.get("expected")
        if isinstance(inputs.artifact_inventory_spec, Mapping) else None
    )
    if not isinstance(expected, list) or ARM_RESOLUTION_SOURCE not in expected:
        raise ValueError(f"artifact inventory must declare {ARM_RESOLUTION_SOURCE}")


def _base_document(inputs: ArmResolutionInputs) -> dict[str, object]:
    return {
        "schema_version": ARM_RESOLUTION_SCHEMA_VERSION,
        "arm": inputs.arm,
        "arm_path": inputs.arm_path,
        "trial_id": inputs.trial_id,
        "root_run_id": inputs.root_run_id,
        "task": inputs.task,
        "profile_name": inputs.profile_name,
        "paid_run": inputs.paid_run,
        "credential_capabilities": project_credential_capabilities(),
        "credential": inputs.credential,
        "cli_artifact": inputs.cli_artifact,
        "model_alias_policy": inputs.model_alias_policy,
        "roles": inputs.roles,
        "thread_templates": inputs.thread_templates,
        "thread_agents": inputs.thread_agents,
        "artifact_inventory_spec": inputs.artifact_inventory_spec,
    }


def build_arm_resolution(inputs: ArmResolutionInputs) -> dict[str, object]:
    _validate_inputs(inputs)
    document = _base_document(inputs)
    if inputs.expected_asset_hashes is not None:
        document["expected_asset_hashes"] = inputs.expected_asset_hashes
    if inputs.pi_benchmark_capability_proven is not None:
        document["pi_benchmark_capability_proven"] = inputs.pi_benchmark_capability_proven
    copied = _json_copy(document)
    assert isinstance(copied, dict)
    return copied


def _direct_parent_role(bundle_root: str, backend: str) -> dict[str, object]:
    """The frozen direct parent surface. Every member but `tools` is backend-neutral by inspection:
    prompt and directive name prompt files, plugin dirs name skill directories, and the MCP and hook
    members are policy literals. `benchmark_policy_guard` stays absent by design (h.3) — the phase-B
    compiler derives it from this role, so a document that authored one would be a guard the model
    can read out of its own agent dir.
    """
    root = PurePosixPath(bundle_root)
    return {
        "system_prompt_path": str(root / DIRECT_CLAUDE_SYSTEM_PROMPT),
        "directive_path": str(root / DIRECT_CLAUDE_DIRECTIVE),
        # require_composable_arm has already refused every backend outside this map, so a KeyError
        # here means a backend was admitted without declaring its parent surface — fail, never
        # fall back to another backend's labels.
        "tools": list(DIRECT_PARENT_TOOLS[backend]),
        "plugin_dirs": [str(root / directory) for directory in DIRECT_CLAUDE_PLUGIN_DIRS],
        "mcp_composition": "none",
        "mcp_config_paths": [],
        "disable_hooks": True,
    }


def _coder_review_parent_role(bundle_root: str, backend: str) -> dict[str, object]:
    """The direct parent with exactly one member changed. Every other member is taken verbatim from
    the frozen direct surface, so a later change to (h.3) reaches both modes or neither.
    """
    role = _direct_parent_role(bundle_root, backend)
    role["mcp_composition"] = CODER_REVIEW_PARENT_MCP_COMPOSITION
    # Forced by the line above: the composition must expose only `cortex-benchmark-thread`, and the
    # file that declares it is written beside the resolution in the same agent dir.
    role["mcp_config_paths"] = [str(BENCHMARK_THREAD_MCP_CONTAINER_PATH)]
    return role


def _coder_review_child_role(bundle_root: str, backend: str, slot: str) -> dict[str, object]:
    root = PurePosixPath(bundle_root)
    return {
        "system_prompt_path": str(root / SYSTEM_PROMPTS_DIR / f"{slot}.md"),
        "directive_path": str(root / DIRECTIVES_DIR / f"{slot}.md"),
        "tools": list(CODER_REVIEW_CHILD_TOOLS[backend][slot]),
        "plugin_dirs": [],
        "mcp_composition": "none",
        "mcp_config_paths": [],
        "disable_hooks": True,
    }


def _coder_review_roles(
    bundle_root: str, backend: str, variant: str,
) -> dict[str, object]:
    roles: dict[str, object] = {"parent": _coder_review_parent_role(bundle_root, backend)}
    for slot in CODER_REVIEW_CHILD_SLOTS[variant]:
        roles[slot] = _coder_review_child_role(bundle_root, backend, slot)
    return roles


def _thread_assets(bundle_root: str, variant: str) -> tuple[dict[str, str], dict[str, str]]:
    root = PurePosixPath(bundle_root) / THREAD_TEMPLATES_DIR
    template = CODER_REVIEW_TEMPLATE[variant]
    templates = {template: str(root / "templates" / f"{template}.json")}
    agents = {
        slot: str(root / "agents" / f"{slot}.json")
        for slot in CODER_REVIEW_CHILD_SLOTS[variant]
    }
    return templates, agents


def build_benchmark_thread_mcp_config(bundle_root: str) -> dict[str, object]:
    """The declaration a coder-review parent's `mcp_config_paths` names. Exactly one server: the
    compile refuses any other set for a `benchmark-thread-run` role. Carries the coordinator's
    CORTEX_HOME per EV-ENV: the config's own `env` is the only channel that reaches the MCP child
    through Claude's stdio allowlist merge (EV3), and without it the server reads a different
    DATA_DIR than the agent-run that admitted the trial.
    """
    return {
        "mcpServers": {
            BENCHMARK_THREAD_MCP_SERVER: {
                "command": "node",
                "args": [str(PurePosixPath(bundle_root) / BENCHMARK_THREAD_SERVER_SCRIPT)],
                "cwd": bundle_root,
                "env": {"CORTEX_HOME": str(CODER_REVIEW_CORTEX_HOME)},
            },
        },
    }


def write_benchmark_thread_mcp_config(agent_dir: Path, bundle_root: str) -> Path:
    output = agent_dir / BENCHMARK_THREAD_MCP_FILENAME
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(build_benchmark_thread_mcp_config(bundle_root), indent=2, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    return output


def compose_arm_resolution(seed: TrialSeed, facts: ContainerFacts) -> dict[str, object]:
    require_composable_arm(seed.arm)
    backend = arm_backend(seed.arm)
    inventory = [ARM_RESOLUTION_SOURCE]
    if arm_orchestration_mode(seed.arm) == CODER_REVIEW_MODE:
        variant = arm_coder_review_variant(seed.arm)
        roles = _coder_review_roles(facts.bundle_root, backend, variant)
        thread_templates, thread_agents = _thread_assets(facts.bundle_root, variant)
        # The MCP config is a new file under the trial roots; an unclassified file fails section
        # 3.1(f) closed, so its source is declared here rather than left to the inventory default.
        inventory.append(BENCHMARK_THREAD_MCP_SOURCE)
    else:
        roles = {"parent": _direct_parent_role(facts.bundle_root, backend)}
        thread_templates, thread_agents = {}, {}
    return build_arm_resolution(ArmResolutionInputs(
        arm=seed.arm,
        arm_path=seed.arm_path,
        trial_id=seed.trial_id,
        root_run_id=seed.root_run_id,
        task=seed.task,
        profile_name=seed.profile_name,
        paid_run=seed.paid_run,
        credential=seed.credential,
        cli_artifact={"path": facts.backend_cli_path, "version": facts.backend_cli_version},
        model_alias_policy=seed.model_alias_policy,
        roles=roles,
        thread_templates=thread_templates,
        thread_agents=thread_agents,
        artifact_inventory_spec={"expected": inventory},
        expected_asset_hashes=seed.expected_asset_hashes,
        pi_benchmark_capability_proven=seed.pi_benchmark_capability_proven,
    ))


def write_arm_resolution(
    agent_dir: Path, document: Mapping[str, object],
) -> Path:
    output = agent_dir / ARM_RESOLUTION_FILENAME
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return output
