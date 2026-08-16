# input:  inner/proxy evidence, host attestations, pinned bundle
# output: validated token-linked assets and outer grader envelope
# pos:    Host-side benchmark v2 finalization gate
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import math
import os
import re
import secrets
import socket
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from .host_evidence_validation import validate_host_owned_identity
from .inner_validation import valid_composite_structure
from .launcher.trial_admission import ADMISSION_EVIDENCE_FILENAME
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
from .trial_assets import (
    ASSET_MANIFEST_PATH,
    PublishedAssets,
    TrialAssetError,
    canonical_sha256,
    publish_trial_assets,
)

OUTER_ENVELOPE_FILENAME = "cortex-bench-outer-envelope.json"
OUTER_ENVELOPE_SCHEMA_VERSION = "cortex-bench-outer-envelope/4"
LAUNCH_ATTESTATION_FILENAME = "cortex-bench-launch-attestation.json"
CONTAINER_BOUNDARY_ATTESTATION_FILENAME = "cortex-bench-container-boundary-attestation.json"
# The inner contract's own state -> reason table (`manifest-contract.ts:70-78`), mirrored so a
# terminal that is merely *not ok* can be told apart from one that is malformed. The first is an
# outcome of the run and is gradable; the second is evidence that cannot be trusted and is not.
TERMINAL_REASONS: Mapping[str, frozenset[str]] = {
    "completed": frozenset({"ok"}),
    "failed": frozenset({
        "child_failure", "trajectory_write_failed", "containment_failure", "rate_limited",
        "protocol_violation", "step_limit_exceeded", "cost_limit_exceeded", "provider_error",
    }),
    "cancelled": frozenset({"cancelled"}),
    "timeout": frozenset({"deadline", "deadline_exceeded"}),
    "aborted": frozenset({"aborted"}),
}
# What a proxy audit outcome says about *where* a trial's trouble was. The mapping is total: an
# outcome this table does not name is still reported, as a refusal the proxy itself made, so a new
# outcome can never make a failure invisible here.
PROXY_OBSERVATIONS: Mapping[str, str] = {
    "upstream_unavailable": "upstream_failure",
    "upstream_response_too_large": "upstream_failure",
    "client_gone_after_accounting": "undelivered_response",
    # The provider answered, but not in a shape the adapter could bill, so the proxy refused a
    # response it could not account for. Distinct from a policy refusal: the cause is what came
    # back, not what we would allow.
    "usage_accounting_unavailable": "unaccountable_response",
    # The host credential could not be injected. Never the provider, and never the trial.
    "auth_injection_unavailable": "credential_unavailable",
}
SHA256 = re.compile(r"^[a-f0-9]{64}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
TERMINAL_KEYS = frozenset({
    "schema_version", "state", "started_at", "ended_at", "journal_path",
    "journal_sha256", "event_count", "steps", "cost_usd", "tokens",
    "model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash",
    "terminal_reason",
})
COMPOSITE_KEYS = frozenset({
    "schema_version", "trial_id", "root_run_id", "arm_name", "arm_canonical_sha256",
    "identity", "nodes", "edges", "roots", "accounting", "predicate",
})
FORBIDDEN_FILENAMES = frozenset({".env", "credentials.json", "auth.json", "secrets.json"})
OPTIONAL_TRIAL_STATE_PREFIXES = (
    "trial-home/home/", "trial-home/projects/", "trial-home/xdg-config/",
    "trial-home/xdg-cache/", "trial-home/claude-config/", "trial-home/pi-agent/",
    "trial-home/pi-sessions/", "trial-home/tmp/", "trial-home/logs/",
)


class HostFinalizationError(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class TerminalOutcome:
    """How the inner run ended, and whether that makes it gradable."""

    admitted: bool
    state: str
    reason: str


@dataclass(frozen=True)
class RootJournal:
    """The root run's journal, as the terminal marker names it."""

    name: str
    digest: str
    header: Mapping[str, object]
    event_count: int


@dataclass(frozen=True)
class InnerEvidence:
    terminal_sha256: str
    #: Absent exactly when the run did not complete: `runner.ts:compositeApplicability` publishes
    #: no composite for a non-completed terminal, by design.
    composite_sha256: str | None
    composite: Mapping[str, object] | None
    required_agent_files: Mapping[str, str]
    terminal: TerminalOutcome
    root_run_id: str
    #: The run's own first-class record of what it compiled: prompt, tool and plugin digests. It is
    #: written before the first step and survives every terminal state, so the assets can be
    #: witnessed on the failed path exactly as on the completed one.
    journal_header: Mapping[str, object]


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
    #: The published envelope's own judgement. A non-admitted trial is finalized and published
    #: exactly like an admitted one; what differs is that its result is not offered for grading.
    admitted: bool


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
    *, logs_dir: Path, verifier_dir: Path, artifact_dir: Path,
    root_run_id: str, trial_id: str, arm: Mapping[str, object],
    npm_artifact: Path, bundle_root: str, revocation: TrialRevocation | None,
    scan_policy: ScanPolicy,
) -> HostFinalizationResult:
    try:
        roots = _trial_roots(logs_dir, verifier_dir, artifact_dir)
        # The physical inventory stays the first thing that touches the trial: a required output
        # that is a symlink has to be refused before any read can follow it.
        discovered = _discover_roots(roots)
        inner = _validate_inner(logs_dir, root_run_id, trial_id, arm)
        _validate_trial_attestations(artifact_dir, npm_artifact, trial_id, inner.journal_header)
        assets = _publish_assets(logs_dir, npm_artifact, bundle_root, inner)
        discovered = _rediscover(roots, discovered, assets)
        validate_host_owned_identity(artifact_dir, trial_id, root_run_id, arm.get("name"))
        usage = _proxy_usage(revocation, trial_id)
        classified = _classify_outputs(roots, discovered, assets, inner, arm)
        scan = _scan_outputs(classified, roots, scan_policy)
        envelope = _outer_envelope(
            inner, usage, revocation, classified, scan, trial_id, arm, assets)
        return _publish_outer(
            artifact_dir / OUTER_ENVELOPE_FILENAME, envelope, inner.terminal.admitted)
    except HostFinalizationError:
        raise
    except Exception as error:
        raise HostFinalizationError("host_finalization_failed") from error


def _rediscover(
    roots: Mapping[str, Path], discovered: Mapping[tuple[str, str], Path],
    assets: PublishedAssets,
) -> dict[tuple[str, str], Path]:
    """Walk again now that the assets are on disk, and hold the difference to exactly what this
    host wrote. The closed world still closes over a real walk rather than over the writer's word,
    so anything else that appeared while finalization ran is still refused.
    """
    rediscovered = _discover_roots(roots)
    written = {("agent", path) for path in assets.files}
    if set(rediscovered) - set(discovered) - written or set(discovered) - set(rediscovered):
        raise HostFinalizationError("unknown_output_present")
    return rediscovered


def _publish_assets(
    logs_dir: Path, npm_artifact: Path, bundle_root: str, inner: InnerEvidence,
) -> PublishedAssets:
    try:
        return publish_trial_assets(
            logs_dir=logs_dir, npm_artifact=npm_artifact, bundle_root=bundle_root,
            header=inner.journal_header,
        )
    except TrialAssetError as error:
        raise HostFinalizationError(error.reason) from error


def _validate_inner(
    logs_dir: Path, root_run_id: str, trial_id: str, arm: Mapping[str, object],
) -> InnerEvidence:
    root = logs_dir / "trajectory"
    terminal_name = f"run-{root_run_id}.terminal.json"
    terminal_path = root / terminal_name
    terminal_bytes, terminal = _read_json(terminal_path)
    outcome = _classify_terminal(terminal)
    journal = _read_root_journal(root, terminal)
    composite_sha256: str | None = None
    composite: Mapping[str, object] | None = None
    if outcome.admitted:
        composite_bytes, composite = _read_json(root / "composite-manifest.json")
        _validate_composite(composite, terminal, terminal_bytes, root_run_id, trial_id, arm)
        composite_sha256 = hashlib.sha256(composite_bytes).hexdigest()
        required = _attempt_files(root, composite)
        # `runner.ts:1811` publishes the merged trajectory and the composite as one all-or-nothing
        # pair, so a run that has neither is not missing an output — it never had one to miss.
        required["composite-manifest.json"] = "composite_manifest"
        required["trajectory.json"] = "merged_trajectory"
    else:
        required = _non_admitted_files(root, terminal, root_run_id, journal)
    required[terminal_name] = "run_terminal"
    required[f"run-{root_run_id}.started.json"] = "run_started"
    return InnerEvidence(
        hashlib.sha256(terminal_bytes).hexdigest(), composite_sha256, composite, required,
        outcome, root_run_id, journal.header,
    )


def _read_root_journal(root: Path, terminal: Mapping[str, object]) -> RootJournal:
    """The journal the root run wrote, read once for both duties it serves: the non-admitted path
    validates the terminal against it, and the asset lift is held against its header.
    """
    name = _safe_relative(terminal.get("journal_path"))
    try:
        digest, header, event_count = _read_journal(root / name)
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError("inner_manifest_invalid") from error
    return RootJournal(name, digest, header, event_count)


def _non_admitted_files(
    root: Path, terminal: Mapping[str, object], root_run_id: str, journal: RootJournal,
) -> dict[str, str]:
    """Check the run against the only witness a failed run has: its own terminal marker.

    The admitted path validates every attempt through the composite's nodes. With no composite
    there are no nodes, so the terminal is checked directly against the journal it names — same
    digest, same event count, same identity hashes — and the started marker must agree on the
    path. What is genuinely lost is the composite's attestation of `trial_id` and the arm; that
    binding survives only host-side (`validate_host_owned_identity`) and via the terminal's
    filename, which is one reason such a trial is not admitted for grading.
    """
    if journal.digest != terminal.get("journal_sha256"):
        raise HostFinalizationError("inner_digest_mismatch")
    checks = (
        journal.header.get("schema_version") == "cortex-bench-journal/1",
        journal.header.get("type") == "run_header",
        journal.header.get("root_run_id") == root_run_id,
        journal.event_count == terminal.get("event_count"),
        _identity_matches(journal.header, terminal),
    )
    if not all(checks):
        raise HostFinalizationError("inner_manifest_invalid")
    _validate_started(root, f"run-{root_run_id}.terminal.json", journal.name)
    return {journal.name: (
        "parent_journal" if journal.name == "events.jsonl" else "run_journal")}


def _read_json(path: Path) -> tuple[bytes, Mapping[str, object]]:
    try:
        payload = path.read_bytes()
        value = json.loads(payload)
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError("inner_manifest_invalid") from error
    if not isinstance(value, Mapping):
        raise HostFinalizationError("inner_manifest_invalid")
    return payload, value


def _read_attestation(path: Path, reason: str) -> Mapping[str, object]:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError(reason) from error
    if not isinstance(value, Mapping):
        raise HostFinalizationError(reason)
    return value


def _launcher_bundle_hash(value: Mapping[str, object]) -> str:
    inputs = {
        "npm_artifact_sha256": value.get("npm_artifact_sha256"),
        "backend_cli": value.get("backend_cli"),
        "pre_boot_input_bundle_sha256": value.get("pre_boot_input_bundle_sha256"),
    }
    payload = json.dumps(inputs, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def _validate_launch_attestation(
    value: Mapping[str, object], npm_artifact: Path, trial_id: str,
    journal_header: Mapping[str, object],
) -> None:
    expected_keys = {
        "schema_version", "trial_id", "capture_boundary", "npm_artifact_sha256",
        "backend_cli", "pre_boot_input_bundle_sha256", "input_bundle_file_count",
        "cortex_home_tree_sha256", "cortex_home_file_count", "bundle_manifest_hash",
    }
    backend = value.get("backend_cli")
    valid = (
        set(value) == expected_keys
        and value.get("schema_version") == "cortex-bench-launch-attestation/2"
        and value.get("trial_id") == trial_id
        and value.get("capture_boundary") == "launcher_pre_boot"
        and value.get("npm_artifact_sha256") == _sha256_file(npm_artifact)
        and _valid_sha(value.get("pre_boot_input_bundle_sha256"))
        and _valid_count(value.get("input_bundle_file_count"), positive=True)
        and _valid_sha(value.get("cortex_home_tree_sha256"))
        and _valid_count(value.get("cortex_home_file_count"), positive=True)
        and isinstance(backend, Mapping) and set(backend) == {"name", "version"}
        and all(isinstance(backend.get(key), str) and backend.get(key) for key in backend)
        and value.get("bundle_manifest_hash") == _launcher_bundle_hash(value)
        and value.get("bundle_manifest_hash") == journal_header.get("bundle_manifest_hash")
    )
    if not valid:
        raise HostFinalizationError("launch_attestation_invalid")


def _validate_container_boundary_attestation(
    value: Mapping[str, object], trial_id: str,
) -> None:
    container = value.get("container_exit")
    post_stop = value.get("post_stop")
    valid = (
        set(value) == {"schema_version", "trial_id", "observed_at", "container_exit", "post_stop"}
        and value.get("schema_version") == "cortex-bench-container-boundary-attestation/1"
        and value.get("trial_id") == trial_id and _valid_timestamp(value.get("observed_at"))
        and isinstance(container, Mapping)
        and dict(container) == {"status": "exited", "exit_code": container.get("exit_code"),
                                "running": False, "pid": 0}
        and isinstance(container.get("exit_code"), int)
        and not isinstance(container.get("exit_code"), bool)
        and isinstance(post_stop, Mapping)
        and dict(post_stop) == {"descendants_alive": 0, "process_namespace_alive": False}
    )
    if not valid:
        raise HostFinalizationError("container_boundary_unproven")


def _validate_trial_attestations(
    artifact_dir: Path, npm_artifact: Path, trial_id: str,
    journal_header: Mapping[str, object],
) -> None:
    launch = _read_attestation(
        artifact_dir / LAUNCH_ATTESTATION_FILENAME, "launch_attestation_invalid")
    boundary = _read_attestation(
        artifact_dir / CONTAINER_BOUNDARY_ATTESTATION_FILENAME, "container_boundary_unproven")
    _validate_launch_attestation(launch, npm_artifact, trial_id, journal_header)
    _validate_container_boundary_attestation(boundary, trial_id)


def _validate_terminal(terminal: Mapping[str, object]) -> None:
    """Validate terminal truth without requiring every historical attempt to complete."""
    _classify_terminal(terminal)


def _classify_terminal(terminal: Mapping[str, object]) -> TerminalOutcome:
    """Split "this run failed" from "this evidence is not trustworthy".

    A structurally sound marker naming a legal non-ok pair is the run's own outcome, and the
    verifier is entitled to score the attempt on its merits. Anything else — a wrong key set, a
    bad digest or a state and reason the inner contract does not admit together — is a harness
    fault and still refuses.
    """
    checks = (
        set(terminal) == TERMINAL_KEYS,
        terminal.get("schema_version") == "cortex-bench-manifest/2",
        _valid_timestamp(terminal.get("started_at")), _valid_timestamp(terminal.get("ended_at")),
        isinstance(terminal.get("journal_path"), str) and bool(terminal.get("journal_path")),
        _valid_sha(terminal.get("journal_sha256")), _valid_count(terminal.get("event_count")),
        _valid_identity_values(terminal), _valid_tokens(terminal.get("tokens")),
    )
    state, reason = terminal.get("state"), terminal.get("terminal_reason")
    legal_pair = (
        isinstance(state, str) and isinstance(reason, str)
        and reason in TERMINAL_REASONS.get(state, frozenset())
    )
    if not all(checks) or not legal_pair:
        raise HostFinalizationError("inner_terminal_invalid")
    return TerminalOutcome(state == "completed", str(state), str(reason))


def _valid_timestamp(value: object) -> bool:
    return isinstance(value, str) and TIMESTAMP.fullmatch(value) is not None


def _valid_sha(value: object) -> bool:
    return isinstance(value, str) and SHA256.fullmatch(value) is not None


def _valid_count(value: object, *, positive: bool = False) -> bool:
    minimum = 1 if positive else 0
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _valid_identity_values(value: Mapping[str, object]) -> bool:
    keys = (
        "model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash",
    )
    return all(_valid_sha(value.get(key)) for key in keys)


def _valid_tokens(value: object) -> bool:
    if not isinstance(value, Mapping) or set(value) != {
        "input", "output", "cache_read", "cache_creation",
    }:
        return False
    return all(
        item is None or isinstance(item, (int, float)) and not isinstance(item, bool)
        and math.isfinite(item) and item >= 0
        for item in value.values()
    )


def _validate_composite(
    composite: Mapping[str, object], terminal: Mapping[str, object], terminal_bytes: bytes,
    root_run_id: str, trial_id: str, arm: Mapping[str, object],
) -> None:
    expected = (
        set(composite) == COMPOSITE_KEYS,
        composite.get("schema_version") == "cortex-bench-composite-manifest/2",
        composite.get("trial_id") == trial_id, composite.get("root_run_id") == root_run_id,
        composite.get("arm_name") == arm.get("name"),
        composite.get("arm_canonical_sha256") == canonical_sha256(arm),
        valid_composite_structure(composite, terminal, root_run_id, trial_id, arm),
        _parent_terminal_link(composite, terminal, terminal_bytes, root_run_id),
    )
    if not all(expected):
        raise HostFinalizationError("inner_composite_invalid")


def _parent_terminal_link(
    composite: Mapping[str, object], terminal: Mapping[str, object], terminal_bytes: bytes,
    root_run_id: str,
) -> bool:
    nodes = composite.get("nodes")
    roots = composite.get("roots")
    root_id = roots.get("root_attempt_id") if isinstance(roots, Mapping) else None
    root = next((node for node in nodes if isinstance(node, Mapping)
                 and node.get("attempt_id") == root_id), None)
    return isinstance(root, Mapping) and (
        root.get("terminal_manifest_path") == f"run-{root_run_id}.terminal.json"
        and root.get("terminal_manifest_sha256") == hashlib.sha256(terminal_bytes).hexdigest()
        and root.get("journal_path") == terminal.get("journal_path")
        and root.get("journal_sha256") == terminal.get("journal_sha256")
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
        _add_attempt_artifact(root, node, attempt, required)
    return required


def _safe_relative(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise HostFinalizationError("inner_path_invalid")
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise HostFinalizationError("inner_path_invalid")
    return candidate.as_posix()


def _add_attempt_artifact(
    root: Path, node: Mapping[str, object], attempt: object, required: dict[str, str],
) -> None:
    value = node.get("artifact_path")
    if value is None:
        return
    artifact = _safe_relative(value)
    if _sha256_file(root / artifact) != node.get("artifact_sha256"):
        raise HostFinalizationError("inner_digest_mismatch")
    required[artifact] = f"attempt_{attempt}_artifact"


def _validate_attempt_bytes(
    root: Path, node: Mapping[str, object], terminal_name: str, journal_name: str,
) -> None:
    terminal_bytes, terminal = _read_json(root / terminal_name)
    _validate_terminal(terminal)
    terminal_digest = hashlib.sha256(terminal_bytes).hexdigest()
    journal_digest = _validate_journal(root / journal_name, node, terminal)
    if terminal_digest != node.get("terminal_manifest_sha256"):
        raise HostFinalizationError("inner_digest_mismatch")
    if journal_digest != node.get("journal_sha256"):
        raise HostFinalizationError("inner_digest_mismatch")
    _validate_attempt_projection(node, terminal, journal_name)
    _validate_started(root, terminal_name, journal_name)


def _validate_journal(
    path: Path, node: Mapping[str, object], terminal: Mapping[str, object],
) -> str:
    try:
        digest, header, event_count = _read_journal(path)
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError("inner_manifest_invalid") from error
    checks = (
        header.get("schema_version") == "cortex-bench-journal/1",
        header.get("type") == "run_header",
        header.get("root_run_id") == node.get("root_run_id"),
        header.get("thread_id") == node.get("thread_id"),
        header.get("agent_slot") == node.get("role"),
        event_count == terminal.get("event_count") == node.get("event_count"),
        _identity_matches(node, header),
    )
    if not all(checks):
        raise HostFinalizationError("inner_manifest_invalid")
    return digest


def _read_journal(path: Path) -> tuple[str, Mapping[str, object], int]:
    digest = hashlib.sha256()
    documents: list[Mapping[str, object]] = []
    with path.open("rb") as handle:
        for line in handle:
            digest.update(line)
            value = json.loads(line)
            if not isinstance(value, Mapping):
                raise ValueError("journal record must be an object")
            documents.append(value)
    if not documents:
        raise ValueError("journal is empty")
    event_count = sum(record.get("type") != "state_admission" for record in documents[1:])
    return digest.hexdigest(), documents[0], event_count


def _validate_attempt_projection(
    node: Mapping[str, object], terminal: Mapping[str, object], journal_name: str,
) -> None:
    checks = (
        terminal.get("journal_path") == journal_name,
        terminal.get("journal_sha256") == node.get("journal_sha256"),
        node.get("terminal_state") == terminal.get("state"),
        node.get("terminal_reason") == terminal.get("terminal_reason"),
        node.get("started_at") == terminal.get("started_at"),
        node.get("ended_at") == terminal.get("ended_at"),
        node.get("steps") == terminal.get("steps"),
        node.get("cost_usd") == terminal.get("cost_usd"),
        node.get("tokens") == _node_tokens(terminal.get("tokens")),
        _identity_matches(node, terminal),
    )
    if not all(checks):
        raise HostFinalizationError("inner_identity_mismatch")


def _node_tokens(value: object) -> dict[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    return {key: value.get(key) for key in ("input", "output", "cache_read", "cache_creation")}


def _identity_matches(left: Mapping[str, object], right: Mapping[str, object]) -> bool:
    keys = ("model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash")
    return all(left.get(key) == right.get(key) for key in keys)


def _validate_started(root: Path, terminal_name: str, journal_name: str) -> None:
    started_name = terminal_name.replace(".terminal.json", ".started.json")
    _, started = _read_json(root / started_name)
    if started.get("journal_path") != journal_name:
        raise HostFinalizationError("inner_manifest_invalid")


def _proxy_usage(
    revocation: TrialRevocation | None, trial_id: str,
) -> dict[str, object]:
    """What the host's own meter observed for this trial, stated and not cross-checked.

    This used to also compare the proxy's figures against the run's own and refuse the trial when
    they disagreed. The comparison was on COST, and cost is not a quantity either side observes:
    it is a token count multiplied by whichever price list the observer happens to hold. The proxy
    had no cache-read rate and the run did, so on 99.2% cached traffic their two correct answers
    differed by 12.7x and a finished trial was discarded for an accounting fault that never
    happened.

    The proxy no longer prices anything, which removes that particular disagreement, and the
    cross-check itself is now removed by decision rather than replaced. Both sides' measured
    figures still reach the record — the proxy's here, the run's in its own composite — so a reader
    who wants to compare them still can. What no longer happens is this side refusing a trial over
    the result.
    """
    if revocation is None or not _valid_revocation(revocation.revocation, trial_id):
        raise HostFinalizationError("proxy_revocation_uncertain")
    _, export = _read_json(revocation.export_path)
    _, lease = _read_json(revocation.lease_echo_path)
    audit = _available(export.get("audit_log"), Mapping)
    if not _valid_proxy_export(export, lease, audit, trial_id):
        raise HostFinalizationError("proxy_export_invalid")
    return {
        "schema_version": export["schema_version"], "trial_id": trial_id,
        "requests": _available(export.get("requests"), int),
        "input_tokens": _available(export.get("input_tokens"), int),
        "output_tokens": _available(export.get("output_tokens"), int),
        "cached_tokens": export.get("cached_tokens"),
        "audit_entries": audit.get("entries"), "audit_outcomes": _audit_outcomes(audit),
        "lease_echo": export.get("lease_echo"),
    }


def _audit_outcomes(audit: Mapping[str, object]) -> dict[str, int]:
    """The tally of what the proxy recorded going wrong, request by request.

    Required, not optional: an export without it comes from a proxy that could not have observed
    these things at all, and reading its silence as "nothing went wrong" is the mistake this
    field exists to prevent.
    """
    value = audit.get("outcomes")
    valid = isinstance(value, Mapping) and all(
        isinstance(key, str) and key and isinstance(count, int)
        and not isinstance(count, bool) and count > 0
        for key, count in value.items()
    )
    if not valid:
        raise HostFinalizationError("proxy_export_invalid")
    return dict(sorted(value.items()))


def _valid_revocation(value: object, trial_id: str) -> bool:
    expected = {
        "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": trial_id,
        "route_active": False, "listener_present": False, "serving_thread_alive": False,
        "active_handlers": 0, "body_handlers": 0,
    }
    return isinstance(value, Mapping) and dict(value) == expected


def _available(value: object, expected: type) -> object:
    if not isinstance(value, Mapping) or value.get("status") != "available":
        raise HostFinalizationError("proxy_export_invalid")
    payload = value.get("value")
    valid = isinstance(payload, expected) and not (
        expected is int and isinstance(payload, bool))
    if not valid:
        raise HostFinalizationError("proxy_export_invalid")
    return payload


def _valid_proxy_export(
    export: Mapping[str, object], lease: Mapping[str, object], audit: object, trial_id: str,
) -> bool:
    if export.get("schema_version") != "cortex-bench-proxy-export/1":
        return False
    if export.get("trial_id") != trial_id or not isinstance(audit, Mapping):
        return False
    requests = _available(export.get("requests"), int)
    durable_tokens = audit.get("durable_tokens")
    durable = audit.get("durable_requests") == requests and isinstance(durable_tokens, Mapping) and (
        durable_tokens.get("input") == _available(export.get("input_tokens"), int)
        and durable_tokens.get("output") == _available(export.get("output_tokens"), int)
    )
    return durable and audit.get("agrees_with_counters") is True and (
        lease.get("schema_version") == "cortex-bench-lease-echo-record/1"
        and lease.get("trial_id") == trial_id
        and lease.get("lease_echo") == export.get("lease_echo")
        and isinstance(export.get("lease_echo"), Mapping)
        and export["lease_echo"].get("status") == "available"
    )


def _trial_roots(
    logs_dir: Path, verifier_dir: Path, artifact_dir: Path,
) -> dict[str, Path]:
    return {"agent": logs_dir, "verifier": verifier_dir, "artifacts": artifact_dir}


def _classify_outputs(
    roots: Mapping[str, Path], discovered: Mapping[tuple[str, str], Path],
    assets: PublishedAssets, inner: InnerEvidence, arm: Mapping[str, object],
) -> tuple[ClassifiedFile, ...]:
    required = _required_files(assets, inner, arm)
    classified: list[ClassifiedFile] = []
    for key, path in discovered.items():
        source, disposition = _classification(key, required)
        digest = _sha256_file(path)
        classified.append(ClassifiedFile(
            source, key[0], key[1], disposition, path.stat().st_size, digest,
        ))
    if set(required) - set(discovered):
        raise HostFinalizationError("required_output_missing")
    _validate_workspace_evidence(roots["agent"] / "workspace.diff")
    return tuple(sorted(classified, key=lambda item: (item.root, item.relative_path)))


def _validate_workspace_evidence(path: Path) -> None:
    try:
        with path.open("rb") as handle:
            header = json.loads(handle.readline())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError("collected_output_invalid") from error
    if header != {"schema_version": "cortex-bench-workspace-evidence/1"}:
        raise HostFinalizationError("collected_output_invalid")


def _required_files(
    assets: PublishedAssets, inner: InnerEvidence, arm: Mapping[str, object],
) -> dict[tuple[str, str], str]:
    required = {
        ("agent", "arm-resolution.json"): "arm_resolution",
        ("agent", "instruction.md"): "instruction",
        ("agent", "stdout.txt"): "stdout", ("agent", "stderr.txt"): "stderr",
        ("agent", "workspace.diff"): "workspace_diff",
        ("artifacts", ADMISSION_EVIDENCE_FILENAME): "harbor_launch_admission",
        ("artifacts", LAUNCH_ATTESTATION_FILENAME): "pre_boot_launch_attestation",
        ("artifacts", CONTAINER_BOUNDARY_ATTESTATION_FILENAME): "container_boundary_attestation",
        ("artifacts", MANIFEST_FILENAME): "manifest",
        ("artifacts", f"proxy/{AUDIT_LOG_FILENAME}"): PROXY_AUDIT_LOG_SOURCE,
        ("artifacts", f"proxy/{EXPORT_FILENAME}"): PROXY_EXPORT_SOURCE,
        ("artifacts", f"proxy/{LEASE_ECHO_FILENAME}"): LEASE_ECHO_RECORD_SOURCE,
        ("artifacts", f"proxy/{ADAPTER_SELECTION_FILENAME}"): ADAPTER_SELECTION_RECORD_SOURCE,
    }
    required.update({("agent", f"trajectory/{path}"): source
                     for path, source in inner.required_agent_files.items()})
    required.update({("agent", path): source for path, source in assets.files.items()})
    _add_mode_files(required, arm)
    _add_trial_state_files(required, arm)
    return required


def _add_trial_state_files(
    required: dict[tuple[str, str], str], arm: Mapping[str, object],
) -> None:
    state = "trial-home/cortex-home/state"
    required[("agent", "trial-home/cortex-home/config/profiles.json")] = "trial_profile"
    for name in ("tasks", "threads", "sessions", "executions"):
        required[("agent", f"{state}/{name}.json")] = f"trial_{name}_state"
    if arm.get("backend") == "pi":
        required[("agent", "trial-home/pi-agent/auth.json")] = "pi_dummy_auth"
        required[("agent", "trial-home/pi-agent/models.json")] = "pi_model_catalog"


def _add_mode_files(required: dict[tuple[str, str], str], arm: Mapping[str, object]) -> None:
    orchestration = arm.get("orchestration")
    mode = orchestration.get("mode") if isinstance(orchestration, Mapping) else None
    if mode != "coder-review":
        return
    required[("agent", "mcp-config-benchmark-thread.json")] = "benchmark_thread_mcp"
    required[("agent", "benchmark-thread-policy.json")] = "benchmark_thread_policy"


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
) -> tuple[str, str]:
    if key in required:
        return required[key], "required"
    if Path(key[1]).name in FORBIDDEN_FILENAMES or key[1] == OUTER_ENVELOPE_FILENAME:
        raise HostFinalizationError("forbidden_output_present")
    return _optional_classification(key)


def _optional_classification(key: tuple[str, str]) -> tuple[str, str]:
    if key[0] == "agent" and key[1].startswith(OPTIONAL_TRIAL_STATE_PREFIXES):
        return f"trial_state:{key[1]}", "optional-classified"
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
    classified: Sequence[ClassifiedFile], roots: Mapping[str, Path], policy: ScanPolicy,
) -> dict[str, object]:
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
    arm: Mapping[str, object], assets: PublishedAssets,
) -> dict[str, object]:
    return {
        "schema_version": OUTER_ENVELOPE_SCHEMA_VERSION,
        "identity": {"trial_id": trial_id, "root_run_id": inner.root_run_id,
                     "arm_name": arm["name"]},
        "inner": {"terminal_sha256": inner.terminal_sha256,
                  "composite_sha256": inner.composite_sha256},
        "assets": _asset_evidence(assets),
        "proxy_usage": dict(usage), "revocation": dict(revocation.revocation),
        "classification": {"ok": True, "files": [item.as_dict() for item in classified]},
        "publication": {
            "source": "outer_envelope", "root": "artifacts",
            "relative_path": OUTER_ENVELOPE_FILENAME, "classification": "required",
            "atomic": True, "post_publication_reread": True,
        },
        "leak_scan": dict(scan), "grader_admission": _grader_admission(inner.terminal),
        "cause": _cause(inner.terminal, usage),
    }


def _asset_evidence(assets: PublishedAssets) -> dict[str, object]:
    """What the trial can now answer out of its own directory: which bytes the model was given, and
    on whose word. The files themselves are in `classification`, each with its digest; this block is
    the part that is a claim rather than an inventory.
    """
    manifest = assets.manifest
    return {
        "manifest_path": f"agent/{ASSET_MANIFEST_PATH}",
        "npm_artifact": manifest["npm_artifact"],
        "witnessed_slot": manifest["witnessed_slot"],
        "witnesses": manifest["witnesses"],
        "file_count": len(assets.files),
    }


def _cause(terminal: TerminalOutcome, usage: Mapping[str, object]) -> dict[str, object] | None:
    """Why this trial is not gradable, in the one place a reader would look.

    It exists to keep two failures apart that look identical from the outside. A run that ends
    `provider_error` while the proxy recorded upstream failures was failed by the provider. A run
    that ends `provider_error` while the proxy answered every request and recorded nothing wrong
    was failed on our side of the proxy — which is exactly what the 2026-08-13 paid run was, and
    it was read as a model failure for a day. The terminal reason alone cannot tell those apart;
    the pairing can.
    """
    if terminal.admitted:
        return None
    outcomes = usage.get("audit_outcomes")
    outcomes = outcomes if isinstance(outcomes, Mapping) else {}
    return {
        "terminal_state": terminal.state, "terminal_reason": terminal.reason,
        "proxy_observed": sorted({
            PROXY_OBSERVATIONS.get(str(name), "proxy_refusal") for name in outcomes}),
        "audit_outcomes": dict(outcomes),
    }


def _grader_admission(terminal: TerminalOutcome) -> dict[str, object]:
    """A judgement, where this used to be the literal `True`.

    It was true by construction — reaching that line meant every gate had passed, including the
    one that refused a failed run outright. Now that a failed run gets this far, the envelope has
    to say so, and say why, instead of being silent about the outcome it carries.
    """
    return {
        "admitted": terminal.admitted,
        "reason": "ok" if terminal.admitted else "inner_terminal_not_ok",
        "terminal_state": terminal.state, "terminal_reason": terminal.reason,
    }


def _publish_outer(
    path: Path, document: Mapping[str, object], admitted: bool,
) -> HostFinalizationResult:
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
    return HostFinalizationResult(path, expected, admitted)


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
