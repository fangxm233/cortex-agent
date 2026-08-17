# input:  arm, production stores, composite and discovered paths
# output: exact classifications with forbidden dynamic-name refusal
# pos:    Closed-world production direct finalization layout
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath

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
PRODUCTION_THREAD_ID = re.compile(r"thr_[a-f0-9]{8}")
SAFE_DYNAMIC_ID = re.compile(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*")
FORBIDDEN_DYNAMIC_ID = re.compile(r"auth|credential|env|secret", re.IGNORECASE)
PRODUCTION_DIRECT_ROLE = "benchmark-direct"
IDENTITY_NODE_FIELDS = (
    "trial_id", "root_run_id", "thread_id", "parent_thread_id", "root_thread_id",
    "task_id", "dispatch_generation", "template", "role", "stage", "backend", "provider",
    "requested_model", "model_execution_identity_hash", "role_tool_surface_hash",
    "bundle_manifest_hash",
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
    return _dynamic_node_files(logs_dir, nodes[0], threads, discovered_paths)


def _dynamic_node_files(
    logs_dir: Path, node: Mapping[str, object], threads: Mapping[str, object],
    discovered_paths: Sequence[str],
) -> dict[tuple[str, str], str]:
    attempt = _required_text(node, "attempt_id")
    thread_id = _production_thread_id(node)
    role = _production_role(node)
    track_id, settled_backend = _thread_sessions(threads, thread_id, role)
    journal_relative, backend_id = _authoritative_attempt(logs_dir, node, attempt)
    if settled_backend is not None and settled_backend != backend_id:
        raise ProductionOutputLayoutError("production backend session identity drifted")
    relative = {
        journal_relative: "production_attempt_journal",
        _derived_output_path("data/conversation-history", f"{track_id}.jsonl"): (
            "production_conversation_history"
        ),
        _derived_output_path(f"tmp/threads/{thread_id}", "artifact.md"): (
            "production_thread_artifact"
        ),
        _pi_session_path(discovered_paths, backend_id): "production_pi_session",
    }
    relative.update(_server_log_files(node, discovered_paths))
    return {
        ("agent", f"{PRODUCTION_HOME}/{relative_path}"): source
        for relative_path, source in relative.items()
    }


def _read_mapping(path: Path) -> Mapping[str, object]:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise ProductionOutputLayoutError("production thread store is unreadable") from error
    if not isinstance(value, Mapping):
        raise ProductionOutputLayoutError("production thread store must be an object")
    return value


def _production_thread_id(node: Mapping[str, object]) -> str:
    thread_id = _required_text(node, "thread_id")
    if PRODUCTION_THREAD_ID.fullmatch(thread_id) is None:
        raise ProductionOutputLayoutError("production thread_id is invalid")
    return thread_id


def _production_role(node: Mapping[str, object]) -> str:
    role = _required_text(node, "role")
    if role != PRODUCTION_DIRECT_ROLE:
        raise ProductionOutputLayoutError("production direct role is invalid")
    return role


def _thread_sessions(
    threads: Mapping[str, object], thread_id: str, role: str,
) -> tuple[str, str | None]:
    thread = threads.get(thread_id)
    agents = thread.get("agents") if isinstance(thread, Mapping) else None
    slot = agents.get(role) if isinstance(agents, Mapping) else None
    steps = thread.get("steps") if isinstance(thread, Mapping) else None
    if not isinstance(slot, Mapping) or not isinstance(steps, list):
        raise ProductionOutputLayoutError("production thread identity is unavailable")
    track_id = _dynamic_id(slot, "sessionId")
    matches = [step for step in steps if (
        isinstance(step, Mapping) and step.get("agentSlotId") == role
    )]
    if len(matches) > 1:
        raise ProductionOutputLayoutError("production thread step identity is ambiguous")
    if not matches:
        return track_id, None
    if _dynamic_id(matches[0], "sessionId") != track_id:
        raise ProductionOutputLayoutError("production track session identity drifted")
    return track_id, _dynamic_id(matches[0], "backendSessionId")


def _json_lines(path: Path, label: str) -> list[Mapping[str, object]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        values = [json.loads(line) for line in lines]
    except OSError as error:
        raise ProductionOutputMissing(f"production {label} is missing") from error
    except (ValueError, UnicodeDecodeError) as error:
        raise ProductionOutputLayoutError(f"production {label} is malformed") from error
    if not values or any(not isinstance(value, Mapping) for value in values):
        raise ProductionOutputLayoutError(f"production {label} is malformed")
    return values


def _identity_record(home: Path, node: Mapping[str, object], attempt: str) -> Mapping[str, object]:
    rows = _json_lines(home / "data/benchmark-attempt-identities.jsonl", "identity store")
    matches = [row for row in rows if row.get("attempt_id") == attempt]
    if len(rows) != 1 or len(matches) != 1:
        raise ProductionOutputLayoutError("production attempt identity is ambiguous")
    identity = matches[0]
    matches_node = all(identity.get(key) == node.get(key) for key in IDENTITY_NODE_FIELDS)
    root_shape = (
        identity.get("schema_version") == "cortex-production-attempt-identity/2"
        and identity.get("root_attempt_id") == attempt
        and identity.get("spawn_parent_attempt_id") is None
    )
    if not matches_node or not root_shape:
        raise ProductionOutputLayoutError("production attempt identity drifted")
    return identity


def _journal_index_record(
    home: Path, identity: Mapping[str, object], attempt: str,
) -> Mapping[str, object]:
    rows = _json_lines(home / "data/benchmark-attempt-journals.jsonl", "journal index")
    matches = [row for row in rows if row.get("attempt_id") == attempt]
    if len(rows) != 1 or len(matches) != 1:
        raise ProductionOutputLayoutError("production attempt journal index is ambiguous")
    record = matches[0]
    if (
        record.get("schema_version") != "cortex-production-attempt-journal/1"
        or record.get("execution_id") != identity.get("execution_id")
    ):
        raise ProductionOutputLayoutError("production attempt journal index drifted")
    return record


def _authoritative_attempt(
    logs_dir: Path, node: Mapping[str, object], attempt: str,
) -> tuple[str, str]:
    home = logs_dir / PRODUCTION_HOME
    identity = _identity_record(home, node, attempt)
    index = _journal_index_record(home, identity, attempt)
    name = f"{hashlib.sha256(attempt.encode()).hexdigest()}.ndjson"
    relative = f"data/benchmark-attempt-journals/{name}"
    raw_path = home / relative
    try:
        raw = raw_path.read_bytes()
        exported = (logs_dir / "trajectory" / _required_text(node, "journal_path")).read_bytes()
    except OSError as error:
        raise ProductionOutputMissing("production attempt journal is missing") from error
    if raw != exported or hashlib.sha256(raw).hexdigest() != index.get("journal_sha256"):
        raise ProductionOutputLayoutError("production attempt journal bytes drifted")
    rows = _json_lines(raw_path, "attempt journal")
    if index.get("event_count") != len(rows) - 1:
        raise ProductionOutputLayoutError("production attempt journal count drifted")
    return relative, _journal_session_id(rows)


def _journal_session_id(rows: Sequence[Mapping[str, object]]) -> str:
    sessions = []
    for row in rows[1:]:
        event = row.get("event")
        if isinstance(event, Mapping) and event.get("type") == "session_started":
            sessions.append(_dynamic_id(event, "sessionId"))
    if len(sessions) != 1:
        raise ProductionOutputLayoutError("production backend session identity is ambiguous")
    return sessions[0]


def _pi_session_path(discovered_paths: Sequence[str], backend_id: str) -> str:
    prefix = f"{PRODUCTION_HOME}/logs/sessions-pi/"
    matches = []
    for path in discovered_paths:
        if not path.startswith(prefix):
            continue
        filename = path.removeprefix(prefix)
        parsed = PI_SESSION.fullmatch(filename)
        if parsed is not None and parsed.group("session") == backend_id:
            matches.append(_derived_output_path("logs/sessions-pi", filename))
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


def _derived_output_path(directory: str, filename: str) -> str:
    candidate = PurePosixPath(directory, filename)
    expected_parts = (*PurePosixPath(directory).parts, filename)
    if "/" in filename or filename in {".", ".."} or candidate.parts != expected_parts:
        raise ProductionOutputLayoutError("production dynamic output path is invalid")
    return candidate.as_posix()


def _timestamp(node: Mapping[str, object], key: str) -> datetime:
    value = _required_text(node, key)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProductionOutputLayoutError(f"production {key} is invalid") from error


def _date_tag(value: datetime) -> str:
    return value.strftime("%Y%m%d")


def _dynamic_id(value: Mapping[str, object], key: str) -> str:
    item = _required_text(value, key)
    compact = item.replace("-", "")
    if not SAFE_DYNAMIC_ID.fullmatch(item) or FORBIDDEN_DYNAMIC_ID.search(compact):
        raise ProductionOutputLayoutError(f"production {key} names a forbidden output")
    return item


def _required_text(value: Mapping[str, object], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item or "/" in item:
        raise ProductionOutputLayoutError(f"production {key} is invalid")
    return item
