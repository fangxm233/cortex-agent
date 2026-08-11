# input:  inner manifests, revoked proxy evidence, trial roots, scan policy
# output: atomically published and reread outer grader envelope
# pos:    Fail-closed host finalizer for Cortex benchmark trials
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import os
import re
import secrets
import socket
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .launcher.trial_proxy import (
    ADAPTER_SELECTION_RECORD_SOURCE,
    ADAPTER_SELECTION_FILENAME,
    AUDIT_LOG_FILENAME,
    EXPORT_FILENAME,
    LEASE_ECHO_FILENAME,
    LEASE_ECHO_RECORD_SOURCE,
    PROXY_AUDIT_LOG_SOURCE,
    PROXY_EXPORT_SOURCE,
    TrialRevocation,
)
from .manifest import MANIFEST_FILENAME
from .scan import ArtifactInventory, ScanPolicy, scan_trial_artifacts

OUTER_ENVELOPE_FILENAME = "cortex-bench-outer-envelope.json"
OUTER_ENVELOPE_SCHEMA_VERSION = "cortex-bench-outer-envelope/1"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
TERMINAL_KEYS = frozenset({
    "schema_version", "state", "started_at", "ended_at", "journal_path",
    "journal_sha256", "event_count", "supervisor", "steps", "cost_usd", "tokens",
    "model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash",
    "terminal_reason",
})
COMPOSITE_KEYS = frozenset({
    "schema_version", "trial_id", "root_run_id", "arm_name", "arm_canonical_sha256",
    "identity", "nodes", "edges", "roots", "accounting", "predicate",
})
FORBIDDEN_FILENAMES = frozenset({".env", "credentials.json", "auth.json", "secrets.json"})


class HostFinalizationError(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class InnerEvidence:
    terminal_sha256: str
    composite_sha256: str
    composite: Mapping[str, object]
    required_agent_files: Mapping[str, str]


@dataclass(frozen=True)
class ClassifiedFile:
    source: str
    root: str
    relative_path: str
    classification: str
    size_bytes: int
    sha256: str

    def as_dict(self) -> dict[str, object]:
        return {
            "source": self.source, "root": self.root, "relative_path": self.relative_path,
            "classification": self.classification, "size_bytes": self.size_bytes,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class HostFinalizationResult:
    path: Path
    sha256: str


def parse_host_scan_policy(
    source: Mapping[str, object], environ: Mapping[str, str] | None = None,
) -> ScanPolicy:
    required = {
        "secret_environment", "forbidden_environment", "forbidden_argv_environment",
        "repository_checkout_environment", "host_identity_environment",
    }
    if set(source) != required:
        raise ValueError("host scan policy has an unsupported shape")
    values = os.environ if environ is None else environ
    return ScanPolicy(
        secrets=_environment_mapping(source, "secret_environment", values),
        repository_checkout=_environment_literal(
            source, "repository_checkout_environment", values),
        hostname=socket.gethostname(),
        forbidden_environment=_environment_mapping(source, "forbidden_environment", values),
        forbidden_argv=_environment_mapping(source, "forbidden_argv_environment", values),
        home_path=str(Path.home()),
        host_identities=_environment_mapping(source, "host_identity_environment", values),
    )


def _environment_literal(
    source: Mapping[str, object], key: str, environ: Mapping[str, str],
) -> str:
    name = source.get(key)
    if not isinstance(name, str) or not name:
        raise ValueError("host scan policy contains an invalid environment reference")
    value = environ.get(name)
    if not value or "\n" in value or "\r" in value:
        raise ValueError("host scan policy environment reference is unavailable")
    return value


def _environment_mapping(
    source: Mapping[str, object], key: str, environ: Mapping[str, str],
) -> dict[str, str]:
    value = source.get(key)
    if not isinstance(value, Mapping):
        raise ValueError("host scan policy contains an invalid environment map")
    result: dict[str, str] = {}
    for rule, name in value.items():
        if not isinstance(rule, str) or not rule:
            raise ValueError("host scan policy contains an invalid rule name")
        result[rule] = _environment_literal({key: name}, key, environ)
    return result


def finalize_host_trial(
    *, logs_dir: Path, artifact_dir: Path, root_run_id: str, trial_id: str,
    arm: Mapping[str, object], staged_npm_artifact: Path,
    revocation: TrialRevocation | None, scan_policy: ScanPolicy,
) -> HostFinalizationResult:
    try:
        inner = _validate_inner(logs_dir, root_run_id, trial_id, arm)
        usage = _reconcile_proxy(revocation, inner, trial_id)
        classified = _classify_outputs(
            logs_dir, artifact_dir, staged_npm_artifact, inner, arm,
        )
        scan = _scan_outputs(classified, logs_dir, artifact_dir, scan_policy)
        envelope = _outer_envelope(inner, usage, revocation, classified, scan, trial_id, arm)
        return _publish_outer(artifact_dir / OUTER_ENVELOPE_FILENAME, envelope)
    except HostFinalizationError:
        raise
    except Exception as error:
        raise HostFinalizationError("host_finalization_failed") from error


def _validate_inner(
    logs_dir: Path, root_run_id: str, trial_id: str, arm: Mapping[str, object],
) -> InnerEvidence:
    root = logs_dir / "trajectory"
    terminal_name = f"run-{root_run_id}.terminal.json"
    terminal_path = root / terminal_name
    terminal_bytes, terminal = _read_json(terminal_path)
    _validate_terminal(terminal)
    composite_bytes, composite = _read_json(root / "composite-manifest.json")
    _validate_composite(composite, terminal, terminal_bytes, root_run_id, trial_id, arm)
    required = _attempt_files(root, composite)
    required[terminal_name] = "run_terminal"
    required[f"run-{root_run_id}.started.json"] = "run_started"
    required["trajectory.json"] = "merged_trajectory"
    required["composite-manifest.json"] = "composite_manifest"
    return InnerEvidence(
        hashlib.sha256(terminal_bytes).hexdigest(), hashlib.sha256(composite_bytes).hexdigest(),
        composite, required,
    )


def _read_json(path: Path) -> tuple[bytes, Mapping[str, object]]:
    try:
        payload = path.read_bytes()
        value = json.loads(payload)
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError("inner_manifest_invalid") from error
    if not isinstance(value, Mapping):
        raise HostFinalizationError("inner_manifest_invalid")
    return payload, value


def _validate_terminal(terminal: Mapping[str, object]) -> None:
    checks = (
        set(terminal) == TERMINAL_KEYS,
        terminal.get("schema_version") == "cortex-bench-manifest/1",
        terminal.get("state") == "completed", terminal.get("terminal_reason") == "ok",
        _valid_timestamp(terminal.get("started_at")), _valid_timestamp(terminal.get("ended_at")),
        _valid_sha(terminal.get("journal_sha256")),
        _valid_count(terminal.get("event_count")), _valid_supervisor(terminal.get("supervisor")),
        _valid_identity_values(terminal), _valid_tokens(terminal.get("tokens")),
    )
    if not all(checks):
        raise HostFinalizationError("inner_terminal_invalid")


def _valid_timestamp(value: object) -> bool:
    return isinstance(value, str) and TIMESTAMP.fullmatch(value) is not None


def _valid_sha(value: object) -> bool:
    return isinstance(value, str) and SHA256.fullmatch(value) is not None


def _valid_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _valid_supervisor(value: object) -> bool:
    return isinstance(value, Mapping) and dict(value) == {"quiescent": True, "descendants": 0}


def _valid_identity_values(value: Mapping[str, object]) -> bool:
    keys = (
        "model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash",
    )
    return all(_valid_sha(value.get(key)) for key in keys)


def _valid_tokens(value: object) -> bool:
    if not isinstance(value, Mapping) or not {"input", "output"} <= set(value):
        return False
    allowed = {"input", "output", "cache_read", "cache_creation"}
    return set(value) <= allowed and all(
        item is None or isinstance(item, (int, float)) and not isinstance(item, bool)
        for item in value.values()
    )


def _validate_composite(
    composite: Mapping[str, object], terminal: Mapping[str, object], terminal_bytes: bytes,
    root_run_id: str, trial_id: str, arm: Mapping[str, object],
) -> None:
    expected = (
        set(composite) == COMPOSITE_KEYS,
        composite.get("schema_version") == "cortex-bench-composite-manifest/1",
        composite.get("trial_id") == trial_id, composite.get("root_run_id") == root_run_id,
        composite.get("arm_name") == arm.get("name"),
        composite.get("arm_canonical_sha256") == _canonical_sha256(arm),
        _valid_composite_identity(composite.get("identity"), terminal),
        _valid_predicate(composite.get("predicate"), arm),
        _valid_composite_shape(composite, arm, root_run_id),
        _parent_terminal_link(composite, terminal, terminal_bytes, root_run_id),
    )
    if not all(expected):
        raise HostFinalizationError("inner_composite_invalid")


def _canonical_sha256(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def _valid_composite_identity(identity: object, terminal: Mapping[str, object]) -> bool:
    if not isinstance(identity, Mapping):
        return False
    model = identity.get("model_execution_identity_hash")
    role = identity.get("role_tool_surface_hash")
    return (
        isinstance(model, Mapping) and model.get("parent") == terminal.get(
            "model_execution_identity_hash")
        and isinstance(role, Mapping) and role.get("parent") == terminal.get(
            "role_tool_surface_hash")
        and identity.get("bundle_manifest_hash") == terminal.get("bundle_manifest_hash")
    )


def _valid_predicate(predicate: object, arm: Mapping[str, object]) -> bool:
    if not isinstance(predicate, Mapping):
        return False
    orchestration = arm.get("orchestration")
    mode = orchestration.get("mode") if isinstance(orchestration, Mapping) else None
    checks = predicate.get("checks")
    return (
        predicate.get("mode") == mode and isinstance(checks, list) and bool(checks)
        and all(isinstance(check, Mapping) and check.get("result") == "pass"
                and check.get("detail") is None for check in checks)
    )


def _valid_composite_shape(
    composite: Mapping[str, object], arm: Mapping[str, object], root_run_id: str,
) -> bool:
    nodes = composite.get("nodes")
    edges = composite.get("edges")
    roots = composite.get("roots")
    if not isinstance(nodes, list) or not nodes or not isinstance(edges, list):
        return False
    if not isinstance(roots, Mapping) or roots.get("parent_attempt_id") != f"run-{root_run_id}":
        return False
    orchestration = arm.get("orchestration")
    mode = orchestration.get("mode") if isinstance(orchestration, Mapping) else None
    return mode != "direct" or (len(nodes) == 1 and not edges and roots.get("root_task_id") is None)


def _parent_terminal_link(
    composite: Mapping[str, object], terminal: Mapping[str, object], terminal_bytes: bytes,
    root_run_id: str,
) -> bool:
    nodes = composite.get("nodes")
    parent = next((node for node in nodes if isinstance(node, Mapping)
                   and node.get("attempt_id") == f"run-{root_run_id}"), None)
    return isinstance(parent, Mapping) and (
        parent.get("terminal_manifest_path") == f"run-{root_run_id}.terminal.json"
        and parent.get("terminal_manifest_sha256") == hashlib.sha256(terminal_bytes).hexdigest()
        and parent.get("journal_path") == terminal.get("journal_path")
        and parent.get("journal_sha256") == terminal.get("journal_sha256")
    )


def _attempt_files(root: Path, composite: Mapping[str, object]) -> dict[str, str]:
    required: dict[str, str] = {"events.jsonl": "parent_journal"}
    for node in composite.get("nodes", []):
        if not isinstance(node, Mapping):
            raise HostFinalizationError("inner_composite_invalid")
        attempt = node.get("attempt_id")
        terminal = _safe_relative(node.get("terminal_manifest_path"))
        journal = _safe_relative(node.get("journal_path"))
        _validate_attempt_bytes(root, node, terminal, journal)
        required[terminal] = f"attempt_{attempt}_terminal"
        required[terminal.replace(".terminal.json", ".started.json")] = f"attempt_{attempt}_started"
        required[journal] = "parent_journal" if journal == "events.jsonl" else f"attempt_{attempt}_journal"
    return required


def _safe_relative(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise HostFinalizationError("inner_path_invalid")
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise HostFinalizationError("inner_path_invalid")
    return candidate.as_posix()


def _validate_attempt_bytes(
    root: Path, node: Mapping[str, object], terminal_name: str, journal_name: str,
) -> None:
    terminal_bytes, terminal = _read_json(root / terminal_name)
    _validate_terminal(terminal)
    if hashlib.sha256(terminal_bytes).hexdigest() != node.get("terminal_manifest_sha256"):
        raise HostFinalizationError("inner_digest_mismatch")
    journal_path = root / journal_name
    if _sha256_file(journal_path) != node.get("journal_sha256"):
        raise HostFinalizationError("inner_digest_mismatch")
    if terminal.get("journal_sha256") != node.get("journal_sha256"):
        raise HostFinalizationError("inner_digest_mismatch")
    _validate_attempt_identity(node, terminal)
    _validate_started(root, terminal_name, journal_name)


def _validate_attempt_identity(
    node: Mapping[str, object], terminal: Mapping[str, object],
) -> None:
    keys = (
        "model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash",
    )
    if any(node.get(key) != terminal.get(key) for key in keys):
        raise HostFinalizationError("inner_identity_mismatch")


def _validate_started(root: Path, terminal_name: str, journal_name: str) -> None:
    started_name = terminal_name.replace(".terminal.json", ".started.json")
    _, started = _read_json(root / started_name)
    if started.get("journal_path") != journal_name:
        raise HostFinalizationError("inner_manifest_invalid")


def _reconcile_proxy(
    revocation: TrialRevocation | None, inner: InnerEvidence, trial_id: str,
) -> dict[str, object]:
    if revocation is None or not _valid_revocation(revocation.revocation, trial_id):
        raise HostFinalizationError("proxy_revocation_uncertain")
    _, export = _read_json(revocation.export_path)
    _, lease = _read_json(revocation.lease_echo_path)
    requests = _available(export.get("requests"), int)
    cost = _available(export.get("cost_usd"), str)
    audit = _available(export.get("audit_log"), Mapping)
    echo = export.get("lease_echo")
    if not _valid_proxy_export(export, lease, audit, trial_id):
        raise HostFinalizationError("proxy_reconciliation_failed")
    journal_cost = _journal_cost(inner.composite)
    if not _cost_reconciled(cost, journal_cost):
        raise HostFinalizationError("proxy_reconciliation_failed")
    return {
        "schema_version": export["schema_version"], "trial_id": trial_id,
        "requests": requests, "cost_usd": cost,
        "input_tokens": _available(export.get("input_tokens"), int),
        "output_tokens": _available(export.get("output_tokens"), int),
        "audit_entries": audit.get("entries"), "lease_echo": echo,
        "journal_cost_usd": journal_cost, "reconciled": True,
    }


def _valid_revocation(value: object, trial_id: str) -> bool:
    expected = {
        "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": trial_id,
        "route_active": False, "listener_present": False, "serving_thread_alive": False,
        "active_handlers": 0, "body_handlers": 0,
    }
    return isinstance(value, Mapping) and dict(value) == expected


def _available(value: object, expected: type) -> object:
    if not isinstance(value, Mapping) or value.get("status") != "available":
        raise HostFinalizationError("proxy_reconciliation_failed")
    payload = value.get("value")
    valid = isinstance(payload, expected) and not (
        expected is int and isinstance(payload, bool))
    if not valid:
        raise HostFinalizationError("proxy_reconciliation_failed")
    return payload


def _valid_proxy_export(
    export: Mapping[str, object], lease: Mapping[str, object], audit: object, trial_id: str,
) -> bool:
    if export.get("schema_version") != "cortex-bench-proxy-export/1":
        return False
    if export.get("trial_id") != trial_id or not isinstance(audit, Mapping):
        return False
    requests = _available(export.get("requests"), int)
    cost = _available(export.get("cost_usd"), str)
    durable = audit.get("durable_requests") == requests and audit.get("durable_cost_usd") == cost
    return durable and audit.get("agrees_with_counters") is True and (
        lease.get("trial_id") == trial_id and lease.get("lease_echo") == export.get("lease_echo")
        and isinstance(export.get("lease_echo"), Mapping)
        and export["lease_echo"].get("status") == "available"
    )


def _journal_cost(inner: Mapping[str, object]) -> str:
    accounting = inner.get("accounting")
    journal = accounting.get("journal") if isinstance(accounting, Mapping) else None
    tagged = journal.get("cost_usd") if isinstance(journal, Mapping) else None
    value = _available(tagged, str)
    return str(value)


def _cost_reconciled(proxy: object, journal: str) -> bool:
    try:
        observed, expected = Decimal(str(proxy)), Decimal(journal)
    except InvalidOperation:
        return False
    tolerance = max(abs(observed) * Decimal("0.01"), Decimal("0.000001"))
    return observed >= 0 and expected >= 0 and abs(observed - expected) <= tolerance


def _classify_outputs(
    logs_dir: Path, artifact_dir: Path, staged: Path,
    inner: InnerEvidence, arm: Mapping[str, object],
) -> tuple[ClassifiedFile, ...]:
    roots = {"agent": logs_dir, "artifacts": artifact_dir}
    discovered = _discover_roots(roots)
    required = _required_files(logs_dir, staged, inner, arm)
    optional = {("artifacts", "workspace.diff"): "workspace_diff"}
    classified: list[ClassifiedFile] = []
    for key, path in discovered.items():
        source, disposition = _classification(key, required, optional)
        digest = _sha256_file(path)
        classified.append(ClassifiedFile(
            source, key[0], key[1], disposition, path.stat().st_size, digest,
        ))
    if set(required) - set(discovered):
        raise HostFinalizationError("required_output_missing")
    return tuple(sorted(classified, key=lambda item: (item.root, item.relative_path)))


def _required_files(
    logs_dir: Path, staged: Path, inner: InnerEvidence, arm: Mapping[str, object],
) -> dict[tuple[str, str], str]:
    staged_relative = _relative_to(staged, logs_dir)
    required = {
        ("agent", "arm-resolution.json"): "arm_resolution",
        ("agent", "instruction.md"): "instruction",
        ("agent", "stdout.txt"): "stdout", ("agent", "stderr.txt"): "stderr",
        ("agent", staged_relative): "setup_artifact",
        ("artifacts", MANIFEST_FILENAME): "manifest",
        ("artifacts", f"proxy/{AUDIT_LOG_FILENAME}"): PROXY_AUDIT_LOG_SOURCE,
        ("artifacts", f"proxy/{EXPORT_FILENAME}"): PROXY_EXPORT_SOURCE,
        ("artifacts", f"proxy/{LEASE_ECHO_FILENAME}"): LEASE_ECHO_RECORD_SOURCE,
        ("artifacts", f"proxy/{ADAPTER_SELECTION_FILENAME}"): ADAPTER_SELECTION_RECORD_SOURCE,
    }
    required.update({("agent", f"trajectory/{path}"): source
                     for path, source in inner.required_agent_files.items()})
    _add_mode_files(required, arm)
    return required


def _add_mode_files(required: dict[tuple[str, str], str], arm: Mapping[str, object]) -> None:
    orchestration = arm.get("orchestration")
    mode = orchestration.get("mode") if isinstance(orchestration, Mapping) else None
    if mode != "coder-review":
        return
    required[("agent", "mcp-config-benchmark-thread.json")] = "benchmark_thread_mcp"
    required[("agent", "benchmark-thread-policy.json")] = "benchmark_thread_policy"


def _relative_to(path: Path, root: Path) -> str:
    try:
        return path.resolve(strict=True).relative_to(root.resolve(strict=True)).as_posix()
    except (OSError, ValueError) as error:
        raise HostFinalizationError("output_escape") from error


def _discover_roots(roots: Mapping[str, Path]) -> dict[tuple[str, str], Path]:
    physical = {name: _physical_root(path) for name, path in roots.items()}
    values = tuple(physical.values())
    if any(left != right and (left.is_relative_to(right) or right.is_relative_to(left))
           for left in values for right in values):
        raise HostFinalizationError("overlapping_trial_roots")
    discovered: dict[tuple[str, str], Path] = {}
    for name, root in roots.items():
        for path in _walk_files(root, physical[name]):
            discovered[(name, path.relative_to(root).as_posix())] = path
    return discovered


def _physical_root(root: Path) -> Path:
    try:
        if root.is_symlink() or not root.is_dir():
            raise OSError("root unavailable")
        return root.resolve(strict=True)
    except OSError as error:
        raise HostFinalizationError("trial_root_unreadable") from error


def _walk_files(root: Path, physical_root: Path) -> tuple[Path, ...]:
    files: list[Path] = []
    stack = [root]
    try:
        while stack:
            directory = stack.pop()
            for entry in os.scandir(directory):
                path = Path(entry.path)
                info = entry.stat(follow_symlinks=False)
                _admit_discovered(path, info, physical_root, files, stack)
    except OSError as error:
        raise HostFinalizationError("trial_root_unreadable") from error
    return tuple(files)


def _admit_discovered(
    path: Path, info: os.stat_result, root: Path,
    files: list[Path], stack: list[Path],
) -> None:
    if stat.S_ISLNK(info.st_mode):
        raise HostFinalizationError("symlink_output_forbidden")
    if stat.S_ISDIR(info.st_mode):
        stack.append(path)
        return
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise HostFinalizationError("non_regular_output_forbidden")
    if not path.resolve(strict=True).is_relative_to(root):
        raise HostFinalizationError("output_escape")
    files.append(path)


def _classification(
    key: tuple[str, str], required: Mapping[tuple[str, str], str],
    optional: Mapping[tuple[str, str], str],
) -> tuple[str, str]:
    if key in required:
        return required[key], "required"
    if key in optional:
        return optional[key], "optional-classified"
    if Path(key[1]).name in FORBIDDEN_FILENAMES or key[1] == OUTER_ENVELOPE_FILENAME:
        raise HostFinalizationError("forbidden_output_present")
    raise HostFinalizationError("unknown_output_present")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise HostFinalizationError("output_hash_failed") from error
    return digest.hexdigest()


def _scan_outputs(
    classified: Sequence[ClassifiedFile], logs_dir: Path, artifact_dir: Path,
    policy: ScanPolicy,
) -> dict[str, object]:
    roots = {"agent": logs_dir, "artifacts": artifact_dir}
    sources = {item.source: roots[item.root] / item.relative_path for item in classified}
    if len(sources) != len(classified):
        raise HostFinalizationError("duplicate_output_classification")
    try:
        report = scan_trial_artifacts(
            ArtifactInventory(sources, frozenset(sources), tuple(roots.values())), policy,
        )
    except Exception as error:
        raise HostFinalizationError("output_scan_failed") from error
    if not report.clean:
        raise HostFinalizationError("output_leak_or_inventory_failure")
    _verify_stable_hashes(classified, roots)
    return report.as_dict()


def _verify_stable_hashes(
    classified: Sequence[ClassifiedFile], roots: Mapping[str, Path],
) -> None:
    if any(_sha256_file(roots[item.root] / item.relative_path) != item.sha256
           for item in classified):
        raise HostFinalizationError("output_digest_mismatch")


def _outer_envelope(
    inner: InnerEvidence, usage: Mapping[str, object], revocation: TrialRevocation | None,
    classified: Sequence[ClassifiedFile], scan: Mapping[str, object], trial_id: str,
    arm: Mapping[str, object],
) -> dict[str, object]:
    return {
        "schema_version": OUTER_ENVELOPE_SCHEMA_VERSION,
        "identity": {"trial_id": trial_id, "root_run_id": inner.composite["root_run_id"],
                     "arm_name": arm["name"]},
        "inner": {"terminal_sha256": inner.terminal_sha256,
                  "composite_sha256": inner.composite_sha256},
        "proxy_usage": dict(usage), "revocation": dict(revocation.revocation),
        "classification": {"ok": True, "files": [item.as_dict() for item in classified]},
        "publication": {
            "source": "outer_envelope", "root": "artifacts",
            "relative_path": OUTER_ENVELOPE_FILENAME, "classification": "required",
            "atomic": True, "post_publication_reread": True,
        },
        "leak_scan": dict(scan), "grader_admission": {"admitted": True},
    }


def _publish_outer(path: Path, document: Mapping[str, object]) -> HostFinalizationResult:
    payload = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}")
    if path.exists() or path.is_symlink():
        raise HostFinalizationError("outer_publication_exists")
    _write_publication(temporary, path, payload)
    reread = _reread_publication(path)
    expected = hashlib.sha256(payload).hexdigest()
    if reread != payload or hashlib.sha256(reread).hexdigest() != expected:
        raise HostFinalizationError("outer_reread_failed")
    try:
        if json.loads(reread) != document:
            raise HostFinalizationError("outer_reread_failed")
    except (ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError("outer_reread_failed") from error
    return HostFinalizationResult(path, expected)


def _write_publication(temporary: Path, final: Path, payload: bytes) -> None:
    descriptor: int | None = None
    linked = False
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        _write_all(descriptor, payload)
        _flush_descriptor(descriptor)
        _close_descriptor(descriptor)
        descriptor = None
        _link_publication(temporary, final)
        linked = True
        temporary.unlink()
        _sync_directory(final.parent)
    except Exception as error:
        _cleanup_publication(descriptor, temporary, final if linked else None)
        raise HostFinalizationError("outer_publication_failed") from error


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if written <= 0:
            raise OSError("zero-byte publication write")
        offset += written


def _flush_descriptor(descriptor: int) -> None:
    os.fsync(descriptor)


def _close_descriptor(descriptor: int) -> None:
    os.close(descriptor)


def _link_publication(temporary: Path, final: Path) -> None:
    os.link(temporary, final)


def _sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _cleanup_publication(
    descriptor: int | None, temporary: Path, final: Path | None,
) -> None:
    if descriptor is not None:
        try:
            os.close(descriptor)
        except OSError:
            pass
    for path in (temporary, final):
        try:
            if path is not None:
                path.unlink(missing_ok=True)
        except OSError:
            pass


def _reread_publication(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise HostFinalizationError("outer_reread_failed") from error
