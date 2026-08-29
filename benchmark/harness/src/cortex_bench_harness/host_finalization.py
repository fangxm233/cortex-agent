# input:  trial roots, arm records, proxy records, scan policy
# output: Cortex/vendor inventory and published outer envelope
# pos:    Shared host-side benchmark trial recorder
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# This module records; it does not verify. The launcher's parameters are written down as they were
# emitted, the production evidence tree is collected as it was found, and provenance comes from
# those records plus the versioned code that produced them. A value the launcher never emitted is
# marked unavailable rather than refused, because a trial that cannot state one parameter is still
# a trial whose evidence is worth keeping.
#
# The host used to re-derive production's own semantics here to check production against itself:
# terminal and composite schemas, journal digests, attempt projections, closed-world output
# classification. Two full implement-and-verify cycles established that doing so requires
# reimplementing the producer inside the consumer, which is the fork this benchmark exists to
# delete. Only one refusal survives, and it is not an evidence gate: a leak found by the scanner
# stops publication, because a credential or a host identity on a collected artifact is real damage
# rather than a disagreement about evidence.

import hashlib
import json
import os
import secrets
import socket
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path

from .launcher.production_home import committed_input_bundle_files
from .launcher.production_session import SESSION_OUTCOME_FILENAME
from .launcher.trial_admission import ADMISSION_EVIDENCE_FILENAME
from .launcher.trial_proxy import TrialRevocation
from .manifest import MANIFEST_FILENAME
from .scan import (
    ArtifactInventory,
    ScanPolicy,
    contains_sensitive_literal,
    scan_trial_artifacts,
)
from .trial_assets import ASSET_MANIFEST_PATH, PublishedAssets, TrialAssetError, publish_trial_assets

OUTER_ENVELOPE_FILENAME = "cortex-bench-outer-envelope.json"
OUTER_ENVELOPE_SCHEMA_VERSION = "cortex-bench-outer-envelope/5"
LAUNCH_ATTESTATION_FILENAME = "cortex-bench-launch-attestation.json"
CONTAINER_BOUNDARY_ATTESTATION_FILENAME = "cortex-bench-container-boundary-attestation.json"
VERIFIER_ROOT = "verifier"
VERIFIER_REWARD_JSON = "reward.json"
VERIFIER_REWARD_TEXT = "reward.txt"


class HostFinalizationError(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class CollectedFile:
    root: str
    relative_path: str
    #: `file` for a regular file this host could read, otherwise what stopped it being one. A
    #: symlink or an unreadable entry is still part of what the trial left behind, so it is
    #: recorded and named instead of ending the trial.
    kind: str
    size_bytes: int
    sha256: str | None
    #: The handle the leak scanner reports a finding under. The scanner refuses a source name that
    #: could carry trial content, so the name is an ordinal and this record is what resolves it.
    source: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "source": self.source, "root": self.root, "relative_path": self.relative_path,
            "kind": self.kind, "size_bytes": self.size_bytes, "sha256": self.sha256,
        }


@dataclass(frozen=True)
class HostFinalizationResult:
    path: Path
    sha256: str
    #: A published envelope is a record of a trial that ran, so it is offered for grading. What the
    #: run made of the task is the verifier's judgement and the reward beside it, not this host's.
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
        host_home_names=_host_home_names(),
    )


def _host_home_names() -> tuple[str, ...]:
    """The account names that really have a home directory beside this user's.

    This is what the broad `/home/<name>` rule is checked against. Reading the directory rather
    than trusting a shape is the whole point: `/home/asandy` inside a Python package is not a host
    disclosure, and treating it as one cost fifteen solved trials on 2026-08-27.
    """
    home = Path.home()
    names = {home.name}
    try:
        names.update(entry.name for entry in home.parent.iterdir() if entry.is_dir())
    except OSError:
        # An unreadable /home leaves the exact home literal, which is the rule that matters most.
        pass
    return tuple(sorted(name for name in names if name and not name.startswith(".")))


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
    *, logs_dir: Path, verifier_dir: Path, artifact_dir: Path, root_run_id: str,
    trial_id: str, arm: Mapping[str, object], npm_artifact: Path | None = None,
    bundle_root: str | None = None, revocation: TrialRevocation | None,
    scan_policy: ScanPolicy, container_logs_dir: Path,
    task: Mapping[str, object] | None = None,
) -> HostFinalizationResult:
    arm_kind = _arm_kind(arm)
    launch, assets = _arm_records(
        arm_kind, logs_dir, artifact_dir, npm_artifact, bundle_root,
    )
    walked, collected, scan = _collect_and_scan(
        logs_dir, verifier_dir, artifact_dir, container_logs_dir, scan_policy,
    )
    _require_trusted_security(scan, revocation, trial_id)
    envelope = _common_envelope(
        walked, collected, scan, verifier_dir, root_run_id, trial_id, arm,
        revocation, _agent_outcome(logs_dir, collected),
    )
    _add_arm_records(envelope, arm_kind, launch, assets, task)
    return _publish_outer(artifact_dir / OUTER_ENVELOPE_FILENAME, envelope)


def _arm_kind(arm: Mapping[str, object]) -> str:
    kind = arm.get("kind")
    if kind not in {"cortex", "vendor-baseline"}:
        raise HostFinalizationError("unsupported_arm_kind")
    return str(kind)


def _arm_records(
    arm_kind: str, logs_dir: Path, artifact_dir: Path,
    npm_artifact: Path | None, bundle_root: str | None,
) -> tuple[dict[str, object], dict[str, object]]:
    if arm_kind == "vendor-baseline":
        marker = _unavailable("not_applicable_to_vendor")
        return _vendor_launch_record(artifact_dir, marker), marker
    if npm_artifact is None or bundle_root is None:
        raise HostFinalizationError("cortex_launch_inputs_unavailable")
    attestation = _read_record(artifact_dir / LAUNCH_ATTESTATION_FILENAME)
    assets = _lift_assets(
        logs_dir, npm_artifact, bundle_root, _attested_arm(attestation, "root_template"),
    )
    return _launch_record(attestation, artifact_dir, npm_artifact), _asset_record(assets)


def _common_envelope(
    walked: Mapping[str, str], collected: Sequence[CollectedFile], scan: dict[str, object],
    verifier_dir: Path, root_run_id: str, trial_id: str, arm: Mapping[str, object],
    revocation: TrialRevocation | None, agent_outcome: Mapping[str, object] | None,
) -> dict[str, object]:
    envelope: dict[str, object] = {
        "schema_version": OUTER_ENVELOPE_SCHEMA_VERSION,
        "identity": {
            "trial_id": trial_id, "root_run_id": root_run_id, "arm_name": arm.get("name")},
        "evidence": {
            "roots": [{"root": name, "status": status} for name, status in walked.items()],
            "files": [item.as_dict() for item in collected],
        },
        "verifier": _verifier_record(verifier_dir),
        "proxy_usage": _proxy_usage(revocation, trial_id),
        "revocation": _revocation_record(revocation),
        "leak_scan": scan,
        "publication": {"root": "artifacts", "relative_path": OUTER_ENVELOPE_FILENAME,
                        "atomic": True, "post_publication_reread": True},
        "grader_admission": {"admitted": True, "reason": "recorded"},
    }
    if agent_outcome is not None:
        envelope["agent_outcome"] = dict(agent_outcome)
    return envelope


def _agent_outcome(
    logs_dir: Path, collected: Sequence[CollectedFile],
) -> dict[str, object] | None:
    record = _read_record(logs_dir / SESSION_OUTCOME_FILENAME)
    if record is None:
        return None
    outcome = dict(record)
    outcome["cost_evidence"] = _cost_evidence(collected)
    return outcome


def _cost_evidence(collected: Sequence[CollectedFile]) -> dict[str, object]:
    prefix = "production-cortex-home/container-home/.aistatus/usage/"
    paths = [
        f"{item.root}/{item.relative_path}" for item in collected
        if item.root == "agent" and item.kind == "file"
        and item.relative_path.startswith(prefix) and item.relative_path.endswith(".jsonl")
    ]
    if not paths:
        return _unavailable("run_cost_evidence_absent")
    return {"status": "recorded", "paths": paths}


def _add_arm_records(
    envelope: dict[str, object], arm_kind: str, launch: dict[str, object],
    assets: dict[str, object], task: Mapping[str, object] | None,
) -> None:
    envelope["launch"] = launch
    envelope["assets"] = assets
    if arm_kind != "vendor-baseline":
        return
    identity = envelope["identity"]
    assert isinstance(identity, dict)
    identity["arm_kind"] = arm_kind
    envelope["task"] = _vendor_task_record(task)
    envelope["telemetry"] = _unavailable("not_applicable_to_vendor")


def _vendor_task_record(task: Mapping[str, object] | None) -> dict[str, str]:
    required = ("task_id", "image_ref", "image_digest")
    if task is None or any(not isinstance(task.get(key), str) or not task[key] for key in required):
        raise HostFinalizationError("vendor_task_pin_unavailable")
    return {key: str(task[key]) for key in required}


def _require_trusted_security(
    scan: Mapping[str, object], revocation: TrialRevocation | None, trial_id: str,
) -> None:
    # Coverage uncertainty stays in the envelope; only an observed leak blocks publication.
    if scan.get("matches") != []:
        raise HostFinalizationError("output_scan_untrusted")
    record = _revocation_record(revocation)
    expected = {
        "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": trial_id,
        "route_active": False, "listener_present": False,
        "serving_thread_alive": False, "active_handlers": 0, "body_handlers": 0,
    }
    for key, value in expected.items():
        actual = record.get(key)
        if type(actual) is not type(value) or actual != value:
            raise HostFinalizationError("proxy_revocation_uncertain")


def _collect_and_scan(
    logs_dir: Path, verifier_dir: Path, artifact_dir: Path,
    container_logs_dir: Path, scan_policy: ScanPolicy,
) -> tuple[dict[str, str], tuple[CollectedFile, ...], dict[str, object]]:
    roots = {"agent": logs_dir, VERIFIER_ROOT: verifier_dir, "artifacts": artifact_dir}
    walked, collected = _collect_roots(roots)
    scan_roots = {name: root for name, root in roots.items() if walked[name] == "collected"}
    scan = _scan_collected(
        collected, scan_roots, {"agent": container_logs_dir}, scan_policy,
    )
    return walked, collected, scan


def _unavailable(reason: str) -> dict[str, str]:
    return {"status": "unavailable", "reason": reason}


def _lift_assets(
    logs_dir: Path, npm_artifact: Path, bundle_root: str, root_template: str | None,
) -> PublishedAssets | str:
    """Copy the production arm's model-visible assets into the trial record.

    A failed lift is recorded as unavailable.
    """
    try:
        return publish_trial_assets(
            logs_dir=logs_dir, npm_artifact=npm_artifact, bundle_root=bundle_root,
            root_template=root_template,
        )
    except TrialAssetError as error:
        return error.reason


def _asset_record(assets: PublishedAssets | str) -> dict[str, object]:
    if isinstance(assets, str):
        return _unavailable(assets)
    return {
        "manifest_path": f"agent/{ASSET_MANIFEST_PATH}",
        "npm_artifact": assets.manifest["npm_artifact"],
        "file_count": len(assets.files),
    }


def _collect_roots(
    roots: Mapping[str, Path],
) -> tuple[dict[str, str], tuple[CollectedFile, ...]]:
    walked: dict[str, str] = {}
    collected: list[CollectedFile] = []
    for name, root in roots.items():
        try:
            entries = _walk_root(name, root)
        except OSError:
            walked[name] = "unavailable"
            continue
        walked[name] = "collected"
        collected.extend(entries)
    ordered = sorted(collected, key=lambda item: (item.root, item.relative_path))
    return walked, tuple(
        replace(item, source=f"collected:{index:04d}")
        for index, item in enumerate(ordered)
    )


def _walk_root(name: str, root: Path) -> list[CollectedFile]:
    collected: list[CollectedFile] = []
    stack = [root]
    while stack:
        for entry in os.scandir(stack.pop()):
            path = Path(entry.path)
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                stack.append(path)
                continue
            collected.append(_collected_file(name, root, path, info))
    return collected


def _collected_file(
    name: str, root: Path, path: Path, info: os.stat_result,
) -> CollectedFile:
    relative = path.relative_to(root).as_posix()
    if stat.S_ISLNK(info.st_mode):
        return CollectedFile(name, relative, "symlink", info.st_size, None)
    if not stat.S_ISREG(info.st_mode):
        return CollectedFile(name, relative, "other", info.st_size, None)
    digest = _sha256_file(path)
    kind = "file" if digest is not None else "unreadable"
    return CollectedFile(name, relative, kind, info.st_size, digest)


def _sha256_file(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _scan_collected(
    collected: Sequence[CollectedFile], roots: Mapping[str, Path],
    container_roots: Mapping[str, Path], policy: ScanPolicy,
) -> dict[str, object]:
    """Scan all collected files; only a leak finding stops publication."""
    if any(contains_sensitive_literal(item.relative_path, policy) for item in collected):
        raise HostFinalizationError("output_leak_detected")
    if not roots:
        return {
            **_unavailable("evidence_roots_unavailable"),
            "ok": False, "clean": False, "sources": [], "matches": [],
            "missing_sources": [], "unclassified_files": [],
        }
    sources = {
        item.source: roots[item.root] / item.relative_path
        for item in collected if item.kind == "file"
    }
    root_aliases = {
        roots[name]: container for name, container in container_roots.items()
        if name in roots
    }
    try:
        report = scan_trial_artifacts(
            ArtifactInventory(
                sources, frozenset(sources), tuple(roots.values()), root_aliases,
            ),
            policy,
        )
    except Exception as error:
        raise HostFinalizationError("output_scan_failed") from error
    if report.findings:
        raise HostFinalizationError("output_leak_detected")
    return report.as_dict()


def _read_record(path: Path) -> Mapping[str, object] | None:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, Mapping) else None


def _field(
    record: Mapping[str, object] | None, key: str, absent: str = "record_absent",
) -> object:
    if record is None:
        return _unavailable(absent)
    value = record.get(key)
    return _unavailable("field_absent") if value is None else value


def _block(record: Mapping[str, object] | None, key: str) -> Mapping[str, object] | None:
    value = record.get(key) if record is not None else None
    return value if isinstance(value, Mapping) else None


def _launch_record(
    attestation: Mapping[str, object] | None, artifact_dir: Path, npm_artifact: Path,
) -> dict[str, object]:
    """The parameters the launcher passed the container, written down as it emitted them."""
    return {
        "npm_artifact": _npm_artifact_record(attestation, npm_artifact),
        "arm_bundle": _field(attestation, "arm_bundle", "launch_attestation_absent"),
        "confinement": _field(attestation, "arm_confinement", "launch_attestation_absent"),
        "config_bundle": _config_bundle_record(attestation),
        **_boundary_launch_record(artifact_dir),
    }


def _vendor_launch_record(
    artifact_dir: Path, marker: dict[str, str],
) -> dict[str, object]:
    return {
        "npm_artifact": marker, "arm_bundle": marker,
        "confinement": marker, "config_bundle": marker,
        **_boundary_launch_record(artifact_dir),
    }


def _boundary_launch_record(artifact_dir: Path) -> dict[str, object]:
    admission = _read_record(artifact_dir / ADMISSION_EVIDENCE_FILENAME)
    boundary = _read_record(artifact_dir / CONTAINER_BOUNDARY_ATTESTATION_FILENAME)
    manifest = _read_record(artifact_dir / MANIFEST_FILENAME)
    image = _block(admission, "image")
    return {
        "sealed_environment_allowlist": _field(
            _block(admission, "environment"), "admitted_keys", "admission_evidence_absent"),
        "image": {
            "reference": _field(image, "reference", "admission_evidence_absent"),
            "digest": _field(
                _block(manifest, "container"), "image_digest", "harness_manifest_absent"),
            "pinned": _field(image, "pinned", "admission_evidence_absent"),
        },
        "container_exit": _field(
            boundary, "container_exit", "container_boundary_attestation_absent"),
        "post_stop_census": _field(
            boundary, "post_stop", "container_boundary_attestation_absent"),
    }


def _npm_artifact_record(
    attestation: Mapping[str, object] | None, npm_artifact: Path,
) -> dict[str, object]:
    return {
        "filename": npm_artifact.name,
        "sha256": _field(attestation, "npm_artifact_sha256", "launch_attestation_absent"),
    }


def _attested_arm(attestation: Mapping[str, object] | None, field: str) -> str | None:
    """What the launch attestation states about the arm that ran, or None when it stated none."""
    block = _block(attestation, "arm_bundle")
    value = block.get(field) if block is not None else None
    return value if isinstance(value, str) and value else None


def _config_bundle_record(attestation: Mapping[str, object] | None) -> dict[str, object]:
    """The bundle hash and count as the attestation states them, beside the file list they were
    computed over. The list is read off the committed bundle THIS trial's attestation names,
    because the attestation carries no list of its own; a trial whose launcher wrote no attestation
    had no such bundle, and gets the marker rather than another arm's inventory.
    """
    absent = _unavailable("launch_attestation_absent")
    if attestation is None:
        return {"canonical_sha256": absent, "file_count": absent, "files": absent}
    key = _attested_arm(attestation, "key")
    try:
        files: object = list(committed_input_bundle_files(str(key)))
    except Exception:
        files = _unavailable("committed_input_bundle_unreadable")
    return {
        "canonical_sha256": _field(attestation, "pre_boot_input_bundle_sha256"),
        "file_count": _field(attestation, "input_bundle_file_count"),
        "files": files,
    }


def _verifier_record(verifier_dir: Path) -> dict[str, object]:
    """The Harbor reward when it is already on disk at this boundary, and where it will land when
    it is not. Finalization runs when the agent container stops, which is before the verifier
    phase, so the path is usually all there is to say.
    """
    reward: object = _unavailable("verifier_reward_absent")
    document = _read_record(verifier_dir / VERIFIER_REWARD_JSON)
    if document is not None:
        reward = document
    else:
        try:
            reward = (verifier_dir / VERIFIER_REWARD_TEXT).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            pass
    return {
        "root": VERIFIER_ROOT, "reward": reward,
        "evidence_paths": [
            f"{VERIFIER_ROOT}/{VERIFIER_REWARD_JSON}", f"{VERIFIER_ROOT}/{VERIFIER_REWARD_TEXT}",
        ],
    }


def _revocation_record(revocation: TrialRevocation | None) -> dict[str, object]:
    if revocation is None or not isinstance(revocation.revocation, Mapping):
        return _unavailable("proxy_revocation_absent")
    return dict(revocation.revocation)


def _proxy_usage(
    revocation: TrialRevocation | None, trial_id: str,
) -> dict[str, object]:
    """What the host's own meter observed for this trial, stated and not cross-checked.

    This used to also compare the proxy's figures against the run's own and refuse the trial when
    they disagreed. The comparison was on COST, and cost is not a quantity either side observes:
    it is a token count multiplied by whichever price list the observer happens to hold. The proxy
    had no cache-read rate and the run did, so on 99.2% cached traffic their two correct answers
    differed by 12.7x and a finished trial was discarded for an accounting fault that never
    happened. Both sides' figures still reach the record; neither side refuses over the other's.
    """
    absent = _unavailable("proxy_export_absent")
    export = (
        None if revocation is None else _read_record(revocation.export_path)
    )
    if export is None:
        return {
            "schema_version": absent, "trial_id": trial_id, "requests": absent,
            "input_tokens": absent, "output_tokens": absent, "cached_tokens": absent,
            "audit_entries": absent, "audit_outcomes": absent,
            "lease_echo": _unavailable("unavailable_by_design"),
        }
    audit = _as_emitted(export.get("audit_log"))
    return {
        "schema_version": _field(export, "schema_version"), "trial_id": trial_id,
        "requests": _as_emitted(export.get("requests")),
        "input_tokens": _as_emitted(export.get("input_tokens")),
        "output_tokens": _as_emitted(export.get("output_tokens")),
        "cached_tokens": _as_emitted(export.get("cached_tokens")),
        "audit_entries": _audit_field(audit, "entries"),
        "audit_outcomes": _audit_field(audit, "outcomes"),
        "lease_echo": _unavailable("unavailable_by_design"),
    }


def _as_emitted(value: object) -> object:
    """A proxy counter as the export states it: the value when the proxy could observe it, and the
    proxy's own unavailability marker when it could not.
    """
    if isinstance(value, Mapping) and value.get("status") == "available":
        return value.get("value")
    return _unavailable("field_absent") if value is None else value


def _audit_field(audit: object, key: str) -> object:
    if not isinstance(audit, Mapping):
        return _unavailable("proxy_audit_log_unavailable")
    return _field(audit, key)


def _publish_outer(
    path: Path, document: Mapping[str, object],
) -> HostFinalizationResult:
    payload = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}")
    if path.exists() or path.is_symlink():
        raise HostFinalizationError("outer_publication_exists")
    _write_publication(temporary, path, payload)
    try:
        expected = _verify_publication(path, payload, document)
    except HostFinalizationError:
        _cleanup_publication(None, path, None)
        raise
    return HostFinalizationResult(path, expected, True)


def _verify_publication(
    path: Path, payload: bytes, document: Mapping[str, object],
) -> str:
    reread = _reread_publication(path)
    expected = hashlib.sha256(payload).hexdigest()
    if reread != payload or hashlib.sha256(reread).hexdigest() != expected:
        raise HostFinalizationError("outer_reread_failed")
    try:
        if json.loads(reread) != document:
            raise HostFinalizationError("outer_reread_failed")
    except (ValueError, UnicodeDecodeError) as error:
        raise HostFinalizationError("outer_reread_failed") from error
    return expected


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
