# input:  materialized arm home, pinned npm bundle, container paths
# output: model-visible assets copied beside the trajectory and inventoried
# pos:    Per-trial asset collection
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# A trial record has to answer "what did the model actually see" out of its own directory. The
# production arm reads prompts from its materialized CORTEX_HOME and plugins from the installed
# bundle, so this module copies those bytes beside the trajectory.
#
# Copying the whole 55.8 MB bundle into every trial would answer the same question and was what the
# trial dir used to carry by accident of staging location. It is 400x the bytes, 99.6% of which is
# node_modules the model never saw, and it proves nothing extra: the bundle's digest is already in
# the trial manifest, and one campaign needs one copy of it.
#
# The lift is collection and nothing more. It used to recompute the run's own `system_prompt_sha256`
# / `tool_manifest_sha256` / `plugin_manifest_sha256` from the extracted bytes and refuse
# publication on a mismatch, which meant reimplementing the container's hashing on the host to
# check the container against itself. What binds these bytes is the pinned bundle digest recorded
# in the manifest beside them.

import hashlib
import json
import tarfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

ASSET_SCHEMA_VERSION = "cortex-bench-trial-assets/2"
ASSETS_DIRNAME = "assets"
BUNDLE_DIRNAME = "bundle"
ASSET_MANIFEST_PATH = f"{ASSETS_DIRNAME}/manifest.json"
# `npm pack` roots every member at `package/`; the install prefix is stripped by the bundle root the
# container reported, so the two halves of the path meet here and nowhere else.
MEMBER_ROOT = "package"
PRODUCTION_HOME_DIRNAME = "production-cortex-home"
PRODUCTION_HOME_CONTAINER_ROOT = f"/logs/agent/{PRODUCTION_HOME_DIRNAME}"
PRODUCTION_TEMPLATES_DIR = f"{PRODUCTION_HOME_DIRNAME}/config/thread-templates/templates"
PRODUCTION_AGENTS_DIR = f"{PRODUCTION_HOME_DIRNAME}/config/thread-templates/agents"
PROMPT_FILE_PREFIX = "file:"


class TrialAssetError(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class PublishedAssets:
    #: Agent-root-relative paths of the bundle members copied into the trial directory.
    files: tuple[str, ...]
    manifest: Mapping[str, object]


def canonical_sha256(value: object) -> str:
    """The canonicalization `identity.ts:97-132` hashes: sorted keys, no whitespace, array order
    preserved.
    """
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def publish_trial_assets(
    *, logs_dir: Path, npm_artifact: Path, bundle_root: str,
    root_template: str | None = None,
) -> PublishedAssets:
    roles = _production_home_roles(logs_dir, bundle_root, root_template)
    files, trees = _asset_plan(roles, bundle_root)
    home_files, container_paths = _production_prompt_assets(
        logs_dir, roles, bundle_root)
    extracted = {
        **_extract(npm_artifact, files - home_files.keys(), trees), **home_files,
    }
    written = _write(logs_dir, extracted)
    manifest = _manifest(
        roles, extracted, written, npm_artifact, bundle_root, container_paths,
    )
    _write_manifest(logs_dir, manifest)
    return PublishedAssets(tuple(sorted(written.values())), manifest)


def _production_home_roles(
    logs_dir: Path, bundle_root: str, root_template: str | None,
) -> Mapping[str, Mapping[str, object]]:
    if not root_template:
        raise TrialAssetError("production_root_template_unattested")
    template = _read_home_document(
        logs_dir / PRODUCTION_TEMPLATES_DIR / f"{root_template}.json")
    agents = template.get("agents")
    if not isinstance(agents, list) or not agents:
        raise TrialAssetError("production_home_unreadable")
    return {
        str(name): _production_role(
            _read_home_document(logs_dir / PRODUCTION_AGENTS_DIR / f"{name}.json"),
            bundle_root,
        )
        for name in agents
    }


def _read_home_document(path: Path) -> Mapping[str, object]:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise TrialAssetError("production_home_unreadable") from error
    if not isinstance(value, Mapping):
        raise TrialAssetError("production_home_unreadable")
    return value


def _production_role(
    value: Mapping[str, object], bundle_root: str,
) -> Mapping[str, object]:
    tools = value.get("tools")
    return {
        "system_prompt_path": _prompt_path(
            value.get("systemPrompt"), bundle_root, "systemPrompts"),
        "directive_path": _prompt_path(value.get("directive"), bundle_root, "directives"),
        "tools": tuple(str(tools).split(",")) if isinstance(tools, str) and tools else (),
        "plugin_dirs": tuple(_string_sequence(value.get("pluginDirs") or [])),
    }


def _prompt_path(value: object, bundle_root: str, kind: str) -> str:
    if not isinstance(value, str) or not value.startswith(PROMPT_FILE_PREFIX):
        raise TrialAssetError("production_home_unreadable")
    return f"{bundle_root}/defaults/prompts/{kind}/{value[len(PROMPT_FILE_PREFIX):]}"


def _production_prompt_assets(
    logs_dir: Path, roles: Mapping[str, Mapping[str, object]], bundle_root: str,
) -> tuple[dict[str, bytes], dict[str, str]]:
    payloads: dict[str, bytes] = {}
    container_paths: dict[str, str] = {}
    for role in roles.values():
        for field, kind in (("system_prompt_path", "systemPrompts"),
                            ("directive_path", "directives")):
            relative = _bundle_relative(role.get(field), bundle_root)
            prefix = PurePosixPath("defaults", "prompts", kind)
            try:
                prompt = PurePosixPath(relative).relative_to(prefix)
            except ValueError as error:
                raise TrialAssetError("production_home_unreadable") from error
            local = logs_dir / PRODUCTION_HOME_DIRNAME / "prompts" / kind / prompt
            try:
                payloads[relative] = local.read_bytes()
            except OSError as error:
                raise TrialAssetError("production_home_unreadable") from error
            container_paths[relative] = str(
                PurePosixPath(PRODUCTION_HOME_CONTAINER_ROOT, "prompts", kind, prompt))
    return payloads, container_paths


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
        raise TrialAssetError("production_home_unreadable")
    if any(not isinstance(item, str) for item in value):
        raise TrialAssetError("production_home_unreadable")
    return tuple(str(item) for item in value)


def _bundle_relative(value: object, bundle_root: str) -> str:
    if not isinstance(value, str) or not value:
        raise TrialAssetError("production_home_unreadable")
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
    written: Mapping[str, str], npm_artifact: Path, bundle_root: str,
    container_paths: Mapping[str, str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": ASSET_SCHEMA_VERSION,
        "bundle_root": bundle_root,
        "npm_artifact": {
            "filename": npm_artifact.name, "sha256": _file_sha256(npm_artifact),
        },
        "roles": {
            name: _role_entry(role, written, bundle_root)
            for name, role in sorted(roles.items())
        },
        "files": [
            {"asset_path": written[relative],
             "container_path": (container_paths or {}).get(
                 relative, f"{bundle_root}/{relative}"),
             "size_bytes": len(extracted[relative]),
             "sha256": hashlib.sha256(extracted[relative]).hexdigest()}
            for relative in sorted(written)
        ],
    }


def _role_entry(
    role: Mapping[str, object], written: Mapping[str, str], bundle_root: str,
) -> dict[str, object]:
    return {
        "system_prompt": written[_bundle_relative(role.get("system_prompt_path"), bundle_root)],
        "directive": written[_bundle_relative(role.get("directive_path"), bundle_root)],
        "tools": list(_string_sequence(role.get("tools"))),
        "plugin_dirs": [
            f"{ASSETS_DIRNAME}/{BUNDLE_DIRNAME}/{_bundle_relative(path, bundle_root)}"
            for path in _string_sequence(role.get("plugin_dirs"))
        ],
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
