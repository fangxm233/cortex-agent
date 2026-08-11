# input:  inner terminal/composite documents, frozen arm
# output: host-side composite wire validity
# pos:    Mirrors the production inner composite contract
# >>> If I am updated, update my header and folder CORTEX.md <<<

import math
import re
from collections.abc import Mapping, Sequence

SHA256 = re.compile(r"^[a-f0-9]{64}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
ATTEMPT_KEYS = frozenset({
    "trial_id", "root_run_id", "task_id", "parent_task_id", "dispatch_generation",
    "attempt_id", "attempt_ordinal", "thread_id", "parent_thread_id", "root_thread_id",
    "task_ancestry", "template", "role", "stage", "backend", "provider",
    "requested_model", "reported_model", "model_execution_identity_hash",
    "role_tool_surface_hash", "bundle_manifest_hash", "terminal_state", "terminal_reason",
    "disposition", "superseded_by", "artifact_path", "artifact_sha256", "journal_path",
    "journal_sha256", "event_count", "terminal_manifest_path", "terminal_manifest_sha256",
    "edges", "started_at", "ended_at", "steps", "cost_usd", "tokens",
    "provider_requests",
})
ACCOUNTING_KEYS = frozenset({
    "schema_version", "trial_id", "proxy", "journal", "tolerance", "deltas",
    "reconciled", "unaccounted_roles", "checks",
})
PROXY_ACCOUNTING_KEYS = frozenset({
    "requests", "cost_usd", "input_tokens", "output_tokens", "audit_log", "lease_echo",
    "source",
})
JOURNAL_ACCOUNTING_KEYS = frozenset({"requests", "cost_usd", "steps", "tokens", "source"})
TOKEN_KEYS = frozenset({"input", "output", "cache_read", "cache_creation"})
SHARED_CHECK_IDS = ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8")
MODE_CHECK_IDS = {
    "direct": ("D1", "D2", "D3", "D4", "D5", "D6"),
    "coder-review": ("C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"),
    "manager": tuple(f"M-{index}" for index in range(1, 17)),
}
DISPOSITIONS = frozenset({"accepted", "rejected", "superseded", "invalidated", "none"})
EDGE_LEGALITY = {
    "spawn": ({"attempt"}, {"attempt"}),
    "decompose": ({"attempt"}, {"task"}),
    "depends_on": ({"task"}, {"task"}),
    "dispatch": ({"task"}, {"attempt"}),
    "proposal": ({"attempt"}, {"proposal"}),
    "seal": ({"proposal"}, {"outcome"}),
    "delivery": ({"outcome"}, {"attempt"}),
    "verdict": ({"attempt"}, {"attempt"}),
    "rework": ({"attempt"}, {"attempt"}),
    "supersede": ({"attempt"}, {"attempt"}),
    "rotation": ({"attempt"}, {"attempt"}),
    "question": ({"attempt"}, {"attempt", "direct-parent"}),
    "answer": ({"attempt", "direct-parent"}, {"attempt"}),
}


def valid_composite_structure(
    composite: Mapping[str, object], terminal: Mapping[str, object],
    root_run_id: str, trial_id: str, arm: Mapping[str, object],
) -> bool:
    mode = _orchestration_mode(arm)
    nodes = composite.get("nodes")
    edges = composite.get("edges")
    roots = composite.get("roots")
    checks = (
        _valid_identity(composite.get("identity"), terminal),
        _valid_accounting(composite.get("accounting"), trial_id),
        _valid_predicate(composite.get("predicate"), mode),
        _valid_roots(roots, mode, root_run_id),
        _valid_edges(edges, nodes, roots),
        _valid_nodes(nodes, edges, roots, root_run_id, trial_id),
        _valid_direct_shape(mode, nodes, edges, roots),
    )
    return all(checks)


def _orchestration_mode(arm: Mapping[str, object]) -> object:
    orchestration = arm.get("orchestration")
    return orchestration.get("mode") if isinstance(orchestration, Mapping) else None


def _valid_identity(identity: object, terminal: Mapping[str, object]) -> bool:
    if not isinstance(identity, Mapping) or set(identity) != {
        "model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash",
    }:
        return False
    model = identity.get("model_execution_identity_hash")
    role = identity.get("role_tool_surface_hash")
    return (
        _valid_hash_map(model) and _valid_hash_map(role)
        and model.get("parent") == terminal.get("model_execution_identity_hash")
        and role.get("parent") == terminal.get("role_tool_surface_hash")
        and identity.get("bundle_manifest_hash") == terminal.get("bundle_manifest_hash")
    )


def _valid_hash_map(value: object) -> bool:
    return (
        isinstance(value, Mapping) and bool(value)
        and all(isinstance(key, str) and key and _valid_sha(item) for key, item in value.items())
    )


def _valid_accounting(value: object, trial_id: str) -> bool:
    if not isinstance(value, Mapping) or set(value) != ACCOUNTING_KEYS:
        return False
    proxy = value.get("proxy")
    journal = value.get("journal")
    return (
        value.get("schema_version") == "cortex-bench-accounting/1"
        and value.get("trial_id") == trial_id
        and isinstance(proxy, Mapping) and set(proxy) == PROXY_ACCOUNTING_KEYS
        and proxy.get("source") == "proxy_export"
        and isinstance(journal, Mapping) and set(journal) == JOURNAL_ACCOUNTING_KEYS
        and journal.get("source") == "trajectory_merge"
        and isinstance(value.get("unaccounted_roles"), list)
        and isinstance(value.get("checks"), list)
    )


def _valid_predicate(value: object, mode: object) -> bool:
    if not isinstance(value, Mapping) or set(value) != {"mode", "checks"}:
        return False
    expected = MODE_CHECK_IDS.get(mode)
    checks = value.get("checks")
    if expected is None or value.get("mode") != mode or not isinstance(checks, list):
        return False
    identifiers = [check.get("check_id") for check in checks if isinstance(check, Mapping)]
    return identifiers == [*SHARED_CHECK_IDS, *expected] and all(
        _valid_predicate_check(check) for check in checks
    )


def _valid_predicate_check(value: object) -> bool:
    if not isinstance(value, Mapping) or set(value) != {"check_id", "result", "detail"}:
        return False
    result = value.get("result")
    detail = value.get("detail")
    return (
        result == "pass" and detail is None
        or result == "unavailable" and isinstance(detail, str) and bool(detail)
    )


def _valid_roots(value: object, mode: object, root_run_id: str) -> bool:
    if not isinstance(value, Mapping) or set(value) != {"parent_attempt_id", "root_task_id"}:
        return False
    task = value.get("root_task_id")
    return (
        value.get("parent_attempt_id") == f"run-{root_run_id}"
        and (task is None if mode in {"direct", "coder-review"} else _text(task))
    )


def _valid_nodes(
    value: object, edges: object, roots: object, root_run_id: str, trial_id: str,
) -> bool:
    if not isinstance(value, list) or not value or not isinstance(edges, list):
        return False
    if not isinstance(roots, Mapping):
        return False
    attempt_ids = [node.get("attempt_id") for node in value if isinstance(node, Mapping)]
    parent_id = roots.get("parent_attempt_id")
    return (
        len(attempt_ids) == len(value) == len(set(attempt_ids))
        and sum(identifier == parent_id for identifier in attempt_ids) == 1
        and all(_valid_node(node, edges, root_run_id, trial_id) for node in value)
        and all(_valid_node_projection(node, edges) for node in value)
    )


def _valid_node(
    value: object, edges: Sequence[object], root_run_id: str, trial_id: str,
) -> bool:
    if not isinstance(value, Mapping) or set(value) != ATTEMPT_KEYS:
        return False
    checks = (
        value.get("trial_id") == trial_id, value.get("root_run_id") == root_run_id,
        _text(value.get("task_id")), _text(value.get("attempt_id")),
        _valid_count(value.get("attempt_ordinal"), positive=True),
        _nullable_text(value.get("parent_task_id")), _nullable_text(value.get("dispatch_generation")),
        _nullable_text(value.get("thread_id")), _nullable_text(value.get("parent_thread_id")),
        _nullable_text(value.get("root_thread_id")), _nullable_text(value.get("template")),
        _text(value.get("role")), _nullable_text(value.get("stage")), _text(value.get("backend")),
        _nullable_text(value.get("provider")), _text(value.get("requested_model")),
        _nullable_text(value.get("reported_model")), _valid_node_identity(value),
        value.get("terminal_state") == "completed", value.get("terminal_reason") == "ok",
        value.get("disposition") in DISPOSITIONS, _valid_supersession(value),
        _valid_artifact_pair(value), _valid_node_evidence(value),
        _valid_timestamp(value.get("started_at")), _valid_timestamp(value.get("ended_at")),
        _valid_count_or_none(value.get("steps")), _valid_number_or_none(value.get("cost_usd")),
        _valid_tokens(value.get("tokens")), _valid_count_or_none(value.get("provider_requests")),
        _valid_ancestry(value), _valid_thread_scope(value), isinstance(value.get("edges"), list),
    )
    return all(checks)


def _valid_node_identity(value: Mapping[str, object]) -> bool:
    return all(_valid_sha(value.get(key)) for key in (
        "model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash",
    ))


def _valid_supersession(value: Mapping[str, object]) -> bool:
    superseded = value.get("disposition") == "superseded"
    replacement = value.get("superseded_by")
    return (superseded and _text(replacement)) or (not superseded and replacement is None)


def _valid_artifact_pair(value: Mapping[str, object]) -> bool:
    path = value.get("artifact_path")
    digest = value.get("artifact_sha256")
    return (path is None and digest is None) or (_text(path) and _valid_sha(digest))


def _valid_node_evidence(value: Mapping[str, object]) -> bool:
    terminal = value.get("terminal_manifest_path")
    return (
        _text(value.get("journal_path")) and _valid_sha(value.get("journal_sha256"))
        and _valid_count(value.get("event_count"))
        and _text(terminal) and terminal.endswith(".terminal.json")
        and _valid_sha(value.get("terminal_manifest_sha256"))
    )


def _valid_ancestry(value: Mapping[str, object]) -> bool:
    ancestry = value.get("task_ancestry")
    return (
        isinstance(ancestry, list) and bool(ancestry)
        and all(_text(item) for item in ancestry) and ancestry[-1] == value.get("task_id")
    )


def _valid_thread_scope(value: Mapping[str, object]) -> bool:
    parent = value.get("thread_id") is None
    return (
        (value.get("root_thread_id") is None) == parent
        and (value.get("template") is None) == parent
    )


def _valid_tokens(value: object) -> bool:
    return (
        isinstance(value, Mapping) and set(value) == TOKEN_KEYS
        and all(_valid_number_or_none(item) for item in value.values())
    )


def _valid_node_projection(node: object, edges: Sequence[object]) -> bool:
    if not isinstance(node, Mapping):
        return False
    attempt_id = node.get("attempt_id")
    projected = [edge for edge in edges if _edge_from_attempt(edge, attempt_id)]
    return node.get("edges") == projected


def _edge_from_attempt(edge: object, attempt_id: object) -> bool:
    if not isinstance(edge, Mapping):
        return False
    source = edge.get("from")
    return isinstance(source, Mapping) and source.get("ref") == "attempt" and source.get("id") == attempt_id


def _valid_edges(value: object, nodes: object, roots: object) -> bool:
    if not isinstance(value, list) or not isinstance(nodes, list) or not isinstance(roots, Mapping):
        return False
    attempts = {node.get("attempt_id") for node in nodes if isinstance(node, Mapping)}
    tasks = {node.get("task_id") for node in nodes if isinstance(node, Mapping)}
    canonical = [repr(edge) for edge in value]
    return len(canonical) == len(set(canonical)) and all(
        _valid_edge(edge, attempts, tasks, roots.get("parent_attempt_id")) for edge in value
    )


def _valid_edge(edge: object, attempts: set[object], tasks: set[object], parent: object) -> bool:
    if not isinstance(edge, Mapping) or set(edge) != {"kind", "from", "to"}:
        return False
    legality = EDGE_LEGALITY.get(edge.get("kind"))
    if legality is None:
        return False
    source, target = edge.get("from"), edge.get("to")
    return (
        _valid_endpoint(source, legality[0], attempts, tasks, parent)
        and _valid_endpoint(target, legality[1], attempts, tasks, parent)
    )


def _valid_endpoint(
    value: object, allowed: set[str], attempts: set[object], tasks: set[object], parent: object,
) -> bool:
    if not isinstance(value, Mapping) or value.get("ref") not in allowed:
        return False
    kind = value.get("ref")
    if kind == "direct-parent":
        return set(value) == {"ref"} and parent in attempts
    return set(value) == {"ref", "id"} and _text(value.get("id")) and _resolved(
        kind, value.get("id"), attempts, tasks)


def _resolved(kind: object, identifier: object, attempts: set[object], tasks: set[object]) -> bool:
    if kind == "task":
        return identifier in tasks
    return identifier in attempts


def _valid_direct_shape(mode: object, nodes: object, edges: object, roots: object) -> bool:
    if mode != "direct":
        return True
    if not isinstance(nodes, list) or len(nodes) != 1 or edges != []:
        return False
    node = nodes[0]
    return (
        isinstance(node, Mapping) and isinstance(roots, Mapping)
        and roots.get("root_task_id") is None and node.get("thread_id") is None
        and node.get("role") == "parent" and node.get("attempt_id") == roots.get("parent_attempt_id")
    )


def _text(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def _nullable_text(value: object) -> bool:
    return value is None or _text(value)


def _valid_sha(value: object) -> bool:
    return isinstance(value, str) and SHA256.fullmatch(value) is not None


def _valid_timestamp(value: object) -> bool:
    return isinstance(value, str) and TIMESTAMP.fullmatch(value) is not None


def _valid_count(value: object, *, positive: bool = False) -> bool:
    minimum = 1 if positive else 0
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _valid_count_or_none(value: object) -> bool:
    return value is None or _valid_count(value)


def _valid_number_or_none(value: object) -> bool:
    return value is None or (
        isinstance(value, (int, float)) and not isinstance(value, bool)
        and math.isfinite(value) and value >= 0
    )
