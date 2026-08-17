# input:  semantic arm, production stores, composite and discovered paths
# output: exact production direct output classifications
# pos:    Closed-world production direct finalization layout
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from pathlib import Path

from .launcher.production_session import is_production_direct_arm

PRODUCTION_HOME = "production-cortex-home"
PRODUCTION_PREBOOT_FILES: Mapping[str, str] = {
    "config/machines.json": "production_machine_registry",
    "config/profiles.json": "production_profile",
    "config/settings.json": "production_settings",
    "config/thread-templates/agents/benchmark-direct.json": "production_direct_agent",
    "config/thread-templates/templates/benchmark-direct.json": "production_direct_template",
    "context/projects/general/TASKS.yaml": "production_project_tasks",
    "data/mode.json": "production_mode",
    "data/schedules.json": "production_schedules",
    "prompts/directives/benchmark-direct.md": "production_directive",
    "prompts/systemPrompts/benchmark-direct.md": "production_system_prompt",
    "data/pi/auth.json": "production_pi_dummy_auth",
    "home/.aistatus/gateway.yaml": "production_gateway_route",
}
PRODUCTION_RUNTIME_FILES: Mapping[str, str] = {
    "data/versions.json": "production_versions",
    "data/pi/agents/explore.md": "production_pi_agent_explore",
    "data/pi/agents/general-purpose.md": "production_pi_agent_general",
    "data/pi/agents/plan.md": "production_pi_agent_plan",
    "data/pi/settings.json": "production_pi_settings",
    "data/threads.json": "production_threads",
    "data/executions.json": "production_executions",
    "data/session-registry.jsonl": "production_session_registry",
    "data/costs.jsonl": "production_costs",
    "data/pi/models.json": "production_pi_models",
    "data/benchmark-attempt-identities.jsonl": "production_attempt_identities",
    "data/benchmark-attempt-journals.jsonl": "production_attempt_journal_index",
    "logs/gateway.log": "production_gateway_log",
}
SERVER_LOG = re.compile(rf"{PRODUCTION_HOME}/logs/server-(?P<date>\d{{8}})\.log")
PI_SESSION = re.compile(
    r"(?:(?:\d{4}-\d{2}-\d{2}T\d{2}(?:[-:]\d{2}){2}(?:-\d{3})?Z)_)?"
    r"(?P<session>[A-Za-z0-9-]+)\.jsonl"
)


class ProductionOutputLayoutError(ValueError):
    pass


class ProductionOutputMissing(ProductionOutputLayoutError):
    pass


def production_preboot_matches(
    logs_dir: Path, arm: Mapping[str, object], attestation: Mapping[str, object],
) -> bool:
    if not is_production_direct_arm(arm):
        return True
    home = logs_dir / PRODUCTION_HOME
    try:
        entries = [{
            "path": relative, "type": "file",
            "sha256": hashlib.sha256((home / relative).read_bytes()).hexdigest(),
        } for relative in sorted(PRODUCTION_PREBOOT_FILES)]
    except OSError:
        return False
    payload = json.dumps(
        entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    return (
        len(entries) == attestation.get("cortex_home_file_count")
        and hashlib.sha256(payload.encode()).hexdigest()
        == attestation.get("cortex_home_tree_sha256")
    )


def production_direct_required_files(
    arm: Mapping[str, object],
) -> dict[tuple[str, str], str]:
    if not is_production_direct_arm(arm):
        return {}
    files = {**PRODUCTION_PREBOOT_FILES, **PRODUCTION_RUNTIME_FILES}
    return {
        ("agent", f"{PRODUCTION_HOME}/{relative}"): source
        for relative, source in files.items()
    }


def production_direct_dynamic_files(
    logs_dir: Path, arm: Mapping[str, object], composite: Mapping[str, object] | None,
    discovered_paths: Sequence[str],
) -> dict[tuple[str, str], str]:
    if not is_production_direct_arm(arm):
        return {}
    nodes = composite.get("nodes") if isinstance(composite, Mapping) else None
    if not isinstance(nodes, list) or len(nodes) != 1 or not isinstance(nodes[0], Mapping):
        raise ProductionOutputLayoutError("production direct composite must have one node")
    threads = _read_mapping(logs_dir / PRODUCTION_HOME / "data/threads.json")
    return _dynamic_node_files(nodes[0], threads, discovered_paths)


def _dynamic_node_files(
    node: Mapping[str, object], threads: Mapping[str, object],
    discovered_paths: Sequence[str],
) -> dict[tuple[str, str], str]:
    attempt = _required_text(node, "attempt_id")
    thread_id = _required_text(node, "thread_id")
    role = _required_text(node, "role")
    step = _thread_step(threads, thread_id, role)
    track_id = _required_text(step, "sessionId")
    backend_id = _required_text(step, "backendSessionId")
    session_path = _pi_session_path(discovered_paths, backend_id)
    relative = {
        f"data/benchmark-attempt-journals/{hashlib.sha256(attempt.encode()).hexdigest()}.ndjson": (
            "production_attempt_journal"
        ),
        f"data/conversation-history/{_safe_track_id(track_id)}.jsonl": (
            "production_conversation_history"
        ),
        f"tmp/threads/{thread_id}/artifact.md": "production_thread_artifact",
        session_path: "production_pi_session",
    }
    relative.update(_server_log_files(node, discovered_paths))
    return {
        ("agent", f"{PRODUCTION_HOME}/{path}"): source
        for path, source in relative.items()
    }


def _read_mapping(path: Path) -> Mapping[str, object]:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise ProductionOutputLayoutError("production thread store is unreadable") from error
    if not isinstance(value, Mapping):
        raise ProductionOutputLayoutError("production thread store must be an object")
    return value


def _thread_step(
    threads: Mapping[str, object], thread_id: str, role: str,
) -> Mapping[str, object]:
    thread = threads.get(thread_id)
    steps = thread.get("steps") if isinstance(thread, Mapping) else None
    matches = [
        step for step in steps or []
        if isinstance(step, Mapping) and step.get("agentSlotId") == role
    ]
    if len(matches) != 1:
        raise ProductionOutputLayoutError("production thread step identity is ambiguous")
    return matches[0]


def _pi_session_path(discovered_paths: Sequence[str], backend_id: str) -> str:
    prefix = f"{PRODUCTION_HOME}/logs/sessions-pi/"
    matches = []
    for path in discovered_paths:
        if not path.startswith(prefix):
            continue
        filename = path.removeprefix(prefix)
        parsed = PI_SESSION.fullmatch(filename)
        if parsed is not None and parsed.group("session") == backend_id:
            matches.append(f"logs/sessions-pi/{filename}")
    if not matches:
        raise ProductionOutputMissing("production PI session output is missing")
    if len(matches) != 1:
        raise ProductionOutputLayoutError("production PI session output is ambiguous")
    return matches[0]


def _server_log_files(
    node: Mapping[str, object], discovered_paths: Sequence[str],
) -> dict[str, str]:
    started = _timestamp(node, "started_at")
    ended = _timestamp(node, "ended_at")
    allowed = {
        _date_tag(value + timedelta(days=offset))
        for value in (started, ended) for offset in (-1, 0, 1)
    }
    discovered = {
        match.group("date") for path in discovered_paths
        if (match := SERVER_LOG.fullmatch(path)) is not None
    }
    matched = allowed & discovered
    if not matched:
        raise ProductionOutputMissing("production server log is missing")
    if len(matched) > 2:
        raise ProductionOutputLayoutError("production server logs are ambiguous")
    return {
        f"logs/server-{tag}.log": f"production_server_log:{tag}"
        for tag in sorted(matched)
    }


def _safe_track_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", value)


def _timestamp(node: Mapping[str, object], key: str) -> datetime:
    value = _required_text(node, key)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProductionOutputLayoutError(f"production {key} is invalid") from error


def _date_tag(value: datetime) -> str:
    return value.strftime("%Y%m%d")


def _required_text(value: Mapping[str, object], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item or "/" in item:
        raise ProductionOutputLayoutError(f"production {key} is invalid")
    return item
