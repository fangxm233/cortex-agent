# input:  the trial's arm resolution, the pinned npm bundle, and the run's own journal header
# output: the model-visible assets this trial read, written into the trial and digest-checked
# pos:    Per-trial asset extraction
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# A trial record has to answer "what did the model actually see" out of its own directory. The
# prompts, directives and skills live in the bundle, at container paths the host cannot read, so
# this module lifts exactly the members the arm resolution names out of the pinned tarball and
# writes them beside the trajectory.
#
# Copying the whole 55.8 MB bundle into every trial would answer the same question and was what the
# trial dir used to carry by accident of staging location. It is 400x the bytes, 99.6% of which is
# node_modules the model never saw, and it proves nothing extra: the bundle's digest is already in
# the trial manifest, and one campaign needs one copy of it.
#
# What makes the extract trustworthy is not that it came from the bundle but that the run itself
# vouches for it. `run_header` publishes `system_prompt_sha256`, `tool_manifest_sha256` and
# `plugin_manifest_sha256` for the slot it ran, computed inside the container from the files it
# opened (`policy-compiler.ts:478-494`, `role-surface.ts:103-122`, `runner.ts:176-183`). Recomputing
# all three here from the extracted bytes is an independent witness that the container's copy and
# the pinned bundle are the same bytes; a mismatch refuses publication.

import hashlib
import json
import tarfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

ASSET_SCHEMA_VERSION = "cortex-bench-trial-assets/1"
ASSETS_DIRNAME = "assets"
BUNDLE_DIRNAME = "bundle"
ASSET_MANIFEST_PATH = f"{ASSETS_DIRNAME}/manifest.json"
ASSET_MANIFEST_SOURCE = "trial_asset_manifest"
# `npm pack` roots every member at `package/`; the install prefix is stripped by the bundle root the
# container reported, so the two halves of the path meet here and nowhere else.
MEMBER_ROOT = "package"
# The witnesses, in the order the manifest reports them.
SLOT_WITNESSES = (
    "system_prompt_sha256", "tool_manifest_sha256", "plugin_manifest_sha256",
)


class TrialAssetError(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class PublishedAssets:
    #: Agent-root-relative path -> classification source, for the closed-world output check.
    files: Mapping[str, str]
    manifest: Mapping[str, object]


def canonical_sha256(value: object) -> str:
    """The canonicalization `identity.ts:97-132` hashes: sorted keys, no whitespace, array order
    preserved. Shared with the outer envelope's arm digest so the two never drift apart.
    """
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def publish_trial_assets(
    *, logs_dir: Path, npm_artifact: Path, bundle_root: str, header: Mapping[str, object],
) -> PublishedAssets:
    roles = _roles(_read_resolution(logs_dir))
    files, trees = _asset_plan(roles, bundle_root)
    extracted = _extract(npm_artifact, files, trees)
    slot, witnesses = _verify(roles, header, extracted, bundle_root)
    written = _write(logs_dir, extracted)
    manifest = _manifest(
        roles, extracted, written, npm_artifact, bundle_root, slot, witnesses,
    )
    _write_manifest(logs_dir, manifest)
    published = {path: f"trial_asset:{relative}" for relative, path in written.items()}
    published[ASSET_MANIFEST_PATH] = ASSET_MANIFEST_SOURCE
    return PublishedAssets(published, manifest)


def _read_resolution(logs_dir: Path) -> Mapping[str, object]:
    try:
        value = json.loads((logs_dir / "arm-resolution.json").read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise TrialAssetError("arm_resolution_unreadable") from error
    if not isinstance(value, Mapping):
        raise TrialAssetError("arm_resolution_unreadable")
    return value


def _roles(resolution: Mapping[str, object]) -> Mapping[str, Mapping[str, object]]:
    roles = resolution.get("roles")
    if not isinstance(roles, Mapping) or not roles:
        raise TrialAssetError("arm_resolution_unreadable")
    for role in roles.values():
        if not isinstance(role, Mapping):
            raise TrialAssetError("arm_resolution_unreadable")
    return {str(slot): role for slot, role in roles.items()}


def _asset_plan(
    roles: Mapping[str, Mapping[str, object]], bundle_root: str,
) -> tuple[frozenset[str], frozenset[str]]:
    """Which bundle members this trial's composition names: prompt and directive files by path,
    plugin directories as whole trees (their skills are what the Skill tool can reach).
    """
    files: set[str] = set()
    trees: set[str] = set()
    for role in roles.values():
        for key in ("system_prompt_path", "directive_path"):
            files.add(_bundle_relative(role.get(key), bundle_root))
        trees.update(
            _bundle_relative(directory, bundle_root)
            for directory in _string_sequence(role.get("plugin_dirs"))
        )
    return frozenset(files), frozenset(trees)


def _string_sequence(value: object) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TrialAssetError("arm_resolution_unreadable")
    if any(not isinstance(item, str) for item in value):
        raise TrialAssetError("arm_resolution_unreadable")
    return tuple(str(item) for item in value)


def _bundle_relative(value: object, bundle_root: str) -> str:
    if not isinstance(value, str) or not value:
        raise TrialAssetError("arm_resolution_unreadable")
    try:
        relative = PurePosixPath(value).relative_to(PurePosixPath(bundle_root))
    except ValueError as error:
        # A composition asset the bundle does not own is not something this module can lift, and
        # silently skipping it would publish a record that claims to be complete and is not.
        raise TrialAssetError("trial_asset_outside_bundle") from error
    if not relative.parts or ".." in relative.parts:
        raise TrialAssetError("trial_asset_outside_bundle")
    return relative.as_posix()


def _extract(
    npm_artifact: Path, files: frozenset[str], trees: frozenset[str],
) -> dict[str, bytes]:
    prefixes = tuple(f"{tree}/" for tree in sorted(trees))
    extracted: dict[str, bytes] = {}
    try:
        with tarfile.open(npm_artifact, "r:gz") as tar:
            for member in tar:
                if not member.isfile():
                    continue
                relative = _member_relative(member.name)
                if relative is None or not (
                    relative in files or relative.startswith(prefixes)
                ):
                    continue
                payload = tar.extractfile(member)
                if payload is None:
                    raise TrialAssetError("trial_asset_unreadable")
                extracted[relative] = payload.read()
    except (OSError, tarfile.TarError) as error:
        raise TrialAssetError("trial_asset_unreadable") from error
    if files - set(extracted) or any(
        not any(name.startswith(prefix) for name in extracted) for prefix in prefixes
    ):
        raise TrialAssetError("trial_asset_missing")
    return extracted


def _member_relative(name: str) -> str | None:
    parts = PurePosixPath(name).parts
    if len(parts) < 2 or parts[0] != MEMBER_ROOT or ".." in parts:
        return None
    return PurePosixPath(*parts[1:]).as_posix()


def _verify(
    roles: Mapping[str, Mapping[str, object]], header: Mapping[str, object],
    extracted: Mapping[str, bytes], bundle_root: str,
) -> tuple[str, dict[str, str]]:
    """Hold the extract against the run's own header. The header speaks for one slot — the run this
    journal belongs to — so that is the slot with a witness; a child role's assets are bound only by
    the bundle digest, and the manifest says which is which.
    """
    slot = header.get("agent_slot")
    role = roles.get(slot) if isinstance(slot, str) else None
    if role is None:
        raise TrialAssetError("trial_asset_slot_unknown")
    computed = {
        "system_prompt_sha256": hashlib.sha256(
            extracted[_bundle_relative(role.get("system_prompt_path"), bundle_root)],
        ).hexdigest(),
        "tool_manifest_sha256": canonical_sha256(
            list(_string_sequence(role.get("tools"))),
        ),
        "plugin_manifest_sha256": canonical_sha256(
            _plugin_manifest(role, extracted, bundle_root),
        ),
    }
    if any(computed[name] != header.get(name) for name in SLOT_WITNESSES):
        raise TrialAssetError("trial_asset_mismatch")
    return str(slot), computed


def _plugin_manifest(
    role: Mapping[str, object], extracted: Mapping[str, bytes], bundle_root: str,
) -> dict[str, object]:
    """`role-surface.ts:62-88` projected onto the extract: one content hash per plugin dir, one per
    skill directory, both sorted the way `promptHashes` sorts them before hashing.
    """
    directories = [
        (path, _bundle_relative(path, bundle_root))
        for path in _string_sequence(role.get("plugin_dirs"))
    ]
    plugin_dirs = sorted(
        (
            {"path": path, "content_sha256": _directory_sha256(extracted, relative)}
            for path, relative in directories
        ),
        key=lambda entry: entry["path"],
    )
    skills = sorted(
        (
            {"name": name, "content_sha256": _directory_sha256(
                extracted, f"{relative}/skills/{name}")}
            for _, relative in directories
            for name in _skill_names(extracted, relative)
        ),
        key=lambda entry: entry["name"],
    )
    return {"plugin_dirs": plugin_dirs, "skills": skills}


def _skill_names(extracted: Mapping[str, bytes], relative: str) -> tuple[str, ...]:
    prefix = f"{relative}/skills/"
    return tuple(sorted({
        name[len(prefix):].split("/")[0]
        for name in extracted if name.startswith(prefix) and "/" in name[len(prefix):]
    }))


def _directory_sha256(extracted: Mapping[str, bytes], relative: str) -> str:
    """`directoryContentSha256`: every regular file under the directory, keyed by its path relative
    to that directory. The bundle carries no symlinks under these trees, and one appearing would
    surface as a witness mismatch rather than as a silently different hash.
    """
    prefix = f"{relative}/"
    entries = sorted(
        (
            {"path": name[len(prefix):], "type": "file",
             "sha256": hashlib.sha256(payload).hexdigest()}
            for name, payload in extracted.items() if name.startswith(prefix)
        ),
        key=lambda entry: entry["path"],
    )
    return canonical_sha256(entries)


def _write(logs_dir: Path, extracted: Mapping[str, bytes]) -> dict[str, str]:
    root = logs_dir / ASSETS_DIRNAME / BUNDLE_DIRNAME
    written: dict[str, str] = {}
    try:
        for relative, payload in sorted(extracted.items()):
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)
            written[relative] = f"{ASSETS_DIRNAME}/{BUNDLE_DIRNAME}/{relative}"
    except OSError as error:
        raise TrialAssetError("trial_asset_write_failed") from error
    return written


def _write_manifest(logs_dir: Path, manifest: Mapping[str, object]) -> None:
    try:
        (logs_dir / ASSET_MANIFEST_PATH).write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8",
        )
    except OSError as error:
        raise TrialAssetError("trial_asset_write_failed") from error


def _manifest(
    roles: Mapping[str, Mapping[str, object]], extracted: Mapping[str, bytes],
    written: Mapping[str, str], npm_artifact: Path, bundle_root: str, slot: str,
    witnesses: Mapping[str, str],
) -> dict[str, object]:
    return {
        "schema_version": ASSET_SCHEMA_VERSION,
        "bundle_root": bundle_root,
        "npm_artifact": {
            "filename": npm_artifact.name, "sha256": _file_sha256(npm_artifact),
        },
        "witnessed_slot": slot,
        "witnesses": {
            name: {"value": witnesses[name], "witness": f"run_header.{name}"}
            for name in SLOT_WITNESSES
        },
        "roles": {
            name: _role_entry(role, written, bundle_root, name == slot)
            for name, role in sorted(roles.items())
        },
        "files": [
            {"asset_path": written[relative],
             "container_path": f"{bundle_root}/{relative}",
             "size_bytes": len(extracted[relative]),
             "sha256": hashlib.sha256(extracted[relative]).hexdigest()}
            for relative in sorted(written)
        ],
    }


def _role_entry(
    role: Mapping[str, object], written: Mapping[str, str], bundle_root: str, witnessed: bool,
) -> dict[str, object]:
    return {
        "system_prompt": written[_bundle_relative(role.get("system_prompt_path"), bundle_root)],
        "directive": written[_bundle_relative(role.get("directive_path"), bundle_root)],
        "tools": list(_string_sequence(role.get("tools"))),
        "plugin_dirs": [
            f"{ASSETS_DIRNAME}/{BUNDLE_DIRNAME}/{_bundle_relative(path, bundle_root)}"
            for path in _string_sequence(role.get("plugin_dirs"))
        ],
        # The directive has no digest of its own in `run_header`; it reaches the record through the
        # bundle only. Saying so is the point of the field.
        "bound_by": "run_header_and_bundle_digest" if witnessed else "bundle_digest",
    }


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise TrialAssetError("trial_asset_unreadable") from error
    return digest.hexdigest()
