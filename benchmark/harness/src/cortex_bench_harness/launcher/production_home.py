# input:  direct bundle, launcher facts, host and runtime paths
# output: sealed home, auth, attestations, committed bundle inventory
# pos:    Pre-boot materializer for the production direct benchmark arm
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import os
import re
import secrets
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

LAUNCH_ATTESTATION_SCHEMA = "cortex-bench-launch-attestation/2"
EVIDENCE_CONTEXT_SCHEMA = "cortex-production-benchmark-evidence-context/1"
LAUNCH_ATTESTATION_FILENAME = "cortex-bench-launch-attestation.json"
DIRECT_ARM_BUNDLE_DIR = (
    Path(__file__).resolve().parent
    / "bundles/direct-pi-deepseek/cortex-home"
)
# The container HOME lives inside the sealed CORTEX_HOME, and the server prints its own paths into
# logs the trial collects. The leak scanner refuses any `/home/<name>` it finds there, so this
# directory may not be called `home`: that spelling made the gateway logging its own config path
# indistinguishable from a host home path and refused an otherwise complete trial.
CONTAINER_HOME_DIR = "container-home"
BACKEND_CLI_NAME = "pi"
MODEL_NAME = "deepseek-v4-flash"
PROFILE_NAME = "benchmark-direct"
PROVIDER_NAME = "deepseek"
PROFILE_MODE = "trial"
MAX_OUTPUT_TOKENS = 65_536
RESIDUE_PREFIXES = (
    "SLACK_", "FEISHU_", "LARK_", "CLAUDE_CODE_OAUTH_", "ANTHROPIC_",
    "DEEPSEEK_", "OPENAI_", "OPENROUTER_", "GOOGLE_", "GEMINI_", "GROQ_",
    "MISTRAL_", "XAI_", "CEREBRAS_", "FIREWORKS_", "TOGETHER_", "COHERE_",
    "AZURE_OPENAI_", "AWS_BEDROCK_",
)
RESIDUE_SUFFIXES = ("_API_KEY", "_BASE_URL")
# The arm is the committed bundle, so the process environment is composed, not filtered: only these
# neutral base variables survive from the host, and everything else the trial runs on is written
# below. A provider denylist cannot express this -- the server also reads host variables that name
# no provider (PI_CODING_AGENT_DIR, CLAUDE_CONFIG_DIR, CORTEX_COSTS_FILE, CORTEX_PROFILE) and each
# of them redirects a credential or state file out of the sealed home, or overrides the arm.
INHERITED_KEYS = ("LANG", "LC_ALL", "LC_CTYPE", "PATH", "TERM", "TZ")
SAFE_DUMMY_TOKEN = re.compile(r"^[A-Za-z0-9._:-]+$")
TRIAL_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class ProductionHomeError(ValueError):
    """The launcher input cannot form a sealed production home."""


@dataclass(frozen=True)
class DirectArmLaunchFacts:
    trial_id: str
    root_run_id: str
    npm_artifact: Path
    backend_cli_version: str
    proxy_base_url: str
    dummy_token_ref: str
    model_alias_policy: object


@dataclass(frozen=True)
class MaterializedProductionHome:
    cortex_home: Path
    process_environment: Mapping[str, str]
    client_token: str
    webhook_token: str
    launch_attestation_path: Path
    production_evidence_context: Mapping[str, object]
    input_bundle_sha256: str
    input_bundle_file_count: int
    cortex_home_tree_sha256: str
    cortex_home_file_count: int
    bundle_manifest_hash: str


@dataclass(frozen=True)
class _TreeSnapshot:
    files: tuple[tuple[str, bytes], ...]
    sha256: str

    @property
    def count(self) -> int:
        return len(self.files)


def _canonical_sha256(value: object) -> str:
    try:
        payload = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        )
    except (TypeError, ValueError) as error:
        raise ProductionHomeError("launcher facts must be canonical JSON values") from error
    return hashlib.sha256(payload.encode()).hexdigest()


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\n" in value:
        raise ProductionHomeError(f"{label} must be one non-empty literal string")
    return value


def _validate_proxy(value: str, trial_id: str) -> str:
    parsed = urlsplit(value)
    valid = (
        parsed.scheme == "http" and parsed.hostname is not None
        and parsed.username is None and parsed.password is None
        and not parsed.query and not parsed.fragment
    )
    if not valid:
        raise ProductionHomeError("proxy_base_url must be an absolute HTTP trial proxy URL")
    if parsed.hostname.lower().split(".", 1)[0] != trial_id:
        raise ProductionHomeError("proxy_base_url must name the current trial-scoped proxy")
    return value.rstrip("/")


def _validate_facts(facts: DirectArmLaunchFacts) -> str:
    trial_id = _required_text(facts.trial_id, "trial_id")
    if not TRIAL_ID_PATTERN.fullmatch(trial_id):
        raise ProductionHomeError("trial_id must be one lowercase DNS label")
    _required_text(facts.root_run_id, "root_run_id")
    _required_text(facts.backend_cli_version, "backend_cli_version")
    token = _required_text(facts.dummy_token_ref, "dummy_token_ref")
    if not SAFE_DUMMY_TOKEN.fullmatch(token):
        raise ProductionHomeError("dummy_token_ref contains unsupported YAML characters")
    _canonical_sha256(facts.model_alias_policy)
    if not facts.npm_artifact.is_file() or facts.npm_artifact.is_symlink():
        raise ProductionHomeError("npm_artifact must be one regular file")
    return _validate_proxy(
        _required_text(facts.proxy_base_url, "proxy_base_url"), trial_id,
    )


def _snapshot_tree(root: Path) -> _TreeSnapshot:
    if not root.is_dir() or root.is_symlink():
        raise ProductionHomeError("input bundle must be one real directory")
    files: list[tuple[str, bytes]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise ProductionHomeError("input bundle may contain only directories and regular files")
        if path.is_file():
            files.append((path.relative_to(root).as_posix(), path.read_bytes()))
    if not files:
        raise ProductionHomeError("input bundle must contain regular files")
    snapshot = tuple(files)
    return _TreeSnapshot(snapshot, _canonical_sha256(list(_snapshot_entries(snapshot))))


def _snapshot_entries(
    files: tuple[tuple[str, bytes], ...],
) -> tuple[dict[str, str], ...]:
    return tuple(
        {"path": name, "type": "file", "sha256": hashlib.sha256(body).hexdigest()}
        for name, body in files
    )


def committed_input_bundle_files() -> tuple[dict[str, str], ...]:
    """The committed pre-boot input bundle, entry by entry, in the shape
    `pre_boot_input_bundle_sha256` is computed over.

    The attestation states that digest and a file count but never the list, and a record that only
    counts its inputs cannot be read back to what they were. The list is therefore read off the
    committed bundle it was computed from, never reconstructed from the digest.
    """
    return _snapshot_entries(_snapshot_tree(DIRECT_ARM_BUNDLE_DIR).files)


def _digest_tree(root: Path) -> tuple[str, int]:
    snapshot = _snapshot_tree(root)
    return snapshot.sha256, snapshot.count


def _write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _copy_snapshot(snapshot: _TreeSnapshot, destination: Path) -> None:
    for relative, payload in snapshot.files:
        _write_bytes(destination / relative, payload)


def _gateway_yaml(proxy_base_url: str, dummy_token_ref: str) -> bytes:
    lines = (
        "port: 9880", "mode: trial", "status_check: false", "max_body_size_mb: 64",
        "deepseek:", "  trial:", f"    base_url: {proxy_base_url}",
        "    auth_style: openai", "    keys:", f"      - {dummy_token_ref}", "",
    )
    return "\n".join(lines).encode()


def _write_dynamic_inputs(
    cortex_home: Path, proxy_base_url: str, dummy_token_ref: str,
) -> None:
    auth = {PROVIDER_NAME: {"type": "api_key", "key": dummy_token_ref}}
    _write_bytes(
        cortex_home / "data/pi/auth.json",
        (json.dumps(auth, indent=2, ensure_ascii=False) + "\n").encode(),
    )
    _write_bytes(
        cortex_home / f"{CONTAINER_HOME_DIR}/.aistatus/gateway.yaml",
        _gateway_yaml(proxy_base_url, dummy_token_ref),
    )


def _is_residue(key: str) -> bool:
    return key.startswith(RESIDUE_PREFIXES) or key.endswith(RESIDUE_SUFFIXES)


def _auth_token() -> str:
    return secrets.token_hex(32)


def _sealed_environment(
    source: Mapping[str, str], runtime_home: Path, facts: DirectArmLaunchFacts,
) -> Mapping[str, str]:
    environment = {
        key: source[key] for key in INHERITED_KEYS
        if isinstance(source.get(key), str)
    }
    environment.update({
        "CORTEX_HOME": str(runtime_home),
        "CORTEX_PROJECTS_DIR": str(runtime_home / "context/projects"),
        "HOME": str(runtime_home / CONTAINER_HOME_DIR),
        "XDG_CACHE_HOME": str(runtime_home / f"{CONTAINER_HOME_DIR}/.cache"),
        "XDG_CONFIG_HOME": str(runtime_home / f"{CONTAINER_HOME_DIR}/.config"),
        "CORTEX_CONFIG_IMMUTABLE": "1", "CORTEX_WEBHOOK_THREAD_OP_ONLY": "1",
        "CORTEX_WEBHOOK_SINGLE_ROOT": "1",
        "WEBHOOK_PORT": "3001",
        "CORTEX_TUI": "1", "CORTEX_TUI_PORT": "3003",
    })
    if any(_is_residue(key) for key in environment):
        raise ProductionHomeError("provider or chat residue survived environment sealing")
    return dict(sorted(environment.items()))


def _make_read_only(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_file():
            path.chmod(0o444)
    for relative in ("config", "prompts", "context", f"{CONTAINER_HOME_DIR}/.aistatus"):
        immutable = root / relative
        for path in sorted(immutable.rglob("*"), reverse=True):
            if path.is_dir():
                path.chmod(0o555)
        immutable.chmod(0o555)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json_atomic(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, indent=2, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o444)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _bundle_manifest_hash(
    npm_sha256: str, backend_cli_version: str, input_bundle_sha256: str,
) -> str:
    return _canonical_sha256({
        "npm_artifact_sha256": npm_sha256,
        "backend_cli": {"name": BACKEND_CLI_NAME, "version": backend_cli_version},
        "pre_boot_input_bundle_sha256": input_bundle_sha256,
    })


def _launch_attestation(
    facts: DirectArmLaunchFacts, npm_sha256: str, bundle: _TreeSnapshot,
    home_sha256: str, home_count: int, manifest_hash: str,
) -> dict[str, object]:
    return {
        "schema_version": LAUNCH_ATTESTATION_SCHEMA,
        "trial_id": facts.trial_id,
        "capture_boundary": "launcher_pre_boot",
        "npm_artifact_sha256": npm_sha256,
        "backend_cli": {"name": BACKEND_CLI_NAME, "version": facts.backend_cli_version},
        "pre_boot_input_bundle_sha256": bundle.sha256,
        "input_bundle_file_count": bundle.count,
        "cortex_home_tree_sha256": home_sha256,
        "cortex_home_file_count": home_count,
        "bundle_manifest_hash": manifest_hash,
    }


def _evidence_context(
    facts: DirectArmLaunchFacts, bundle_manifest_hash: str,
) -> Mapping[str, object]:
    value = {
        "schema_version": EVIDENCE_CONTEXT_SCHEMA,
        "trial_id": facts.trial_id,
        "root_run_id": facts.root_run_id,
        "bundle_manifest_hash": bundle_manifest_hash,
        "model_execution": {
            "model_alias_policy": facts.model_alias_policy,
            "cli_name": BACKEND_CLI_NAME,
            "cli_version": facts.backend_cli_version,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
        },
    }
    return value


def _validate_destinations(cortex_home: Path, attestation_path: Path) -> None:
    if cortex_home.exists() or cortex_home.is_symlink():
        raise ProductionHomeError(f"fresh CORTEX_HOME already exists: {cortex_home}")
    if attestation_path.exists() or attestation_path.is_symlink():
        raise ProductionHomeError(f"launch attestation already exists: {attestation_path}")


def _runtime_home(value: Path | None, local_home: Path) -> Path:
    runtime_home = Path(value) if value is not None else local_home
    if not runtime_home.is_absolute():
        raise ProductionHomeError("runtime CORTEX_HOME must be absolute")
    return runtime_home


def materialize_direct_arm_home(
    *, cortex_home: Path, artifacts_dir: Path, facts: DirectArmLaunchFacts,
    inherited_environment: Mapping[str, str], runtime_cortex_home: Path | None = None,
) -> MaterializedProductionHome:
    home = Path(cortex_home).resolve()
    runtime_home = _runtime_home(runtime_cortex_home, home)
    attestation_path = Path(artifacts_dir).resolve() / LAUNCH_ATTESTATION_FILENAME
    _validate_destinations(home, attestation_path)
    proxy_base_url = _validate_facts(facts)
    bundle = _snapshot_tree(DIRECT_ARM_BUNDLE_DIR)
    environment = _sealed_environment(inherited_environment, runtime_home, facts)
    client_token, webhook_token = _auth_token(), _auth_token()
    _copy_snapshot(bundle, home)
    _write_dynamic_inputs(home, proxy_base_url, facts.dummy_token_ref)
    _make_read_only(home)
    home_sha256, home_count = _digest_tree(home)
    npm_sha256 = _sha256_file(facts.npm_artifact)
    manifest_hash = _bundle_manifest_hash(
        npm_sha256, facts.backend_cli_version, bundle.sha256)
    attestation = _launch_attestation(
        facts, npm_sha256, bundle, home_sha256, home_count, manifest_hash)
    _write_json_atomic(attestation_path, attestation)
    return MaterializedProductionHome(
        cortex_home=home, process_environment=environment,
        client_token=client_token, webhook_token=webhook_token,
        launch_attestation_path=attestation_path,
        production_evidence_context=_evidence_context(facts, manifest_hash),
        input_bundle_sha256=bundle.sha256, input_bundle_file_count=bundle.count,
        cortex_home_tree_sha256=home_sha256, cortex_home_file_count=home_count,
        bundle_manifest_hash=manifest_hash,
    )
