# input:  build artifacts, CLI version, Harbor metadata, resolved cwd
# output: versioned cortex-bench-harness-manifest.json document
# pos:    Reproducibility manifest serializer
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import platform
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from typing import Any, Mapping

from .cwd import ResolvedCwd

MANIFEST_FILENAME = "cortex-bench-harness-manifest.json"
SCHEMA_VERSION = "cortex-bench-harness-manifest/1"


@dataclass(frozen=True)
class ContainerImage:
    image_ref: str | None
    image_digest: str | None
    image_size_bytes: int | None


@dataclass(frozen=True)
class HarnessManifestInput:
    root_run_id: str
    trial_id: str
    arm: str
    wheel_path: Path
    lockfile_path: Path
    lockfile_manifest_path: str
    npm_artifact_path: Path
    container: ContainerImage
    resolved_cwd: ResolvedCwd
    cortex_cli_version: str


@dataclass(frozen=True)
class HarnessManifestSeed:
    root_run_id: str
    trial_id: str
    arm: str
    wheel_path: Path
    lockfile_path: Path
    lockfile_manifest_path: str
    npm_artifact_path: Path
    container: ContainerImage

    def with_cwd(
        self, resolved_cwd: ResolvedCwd, npm_artifact_path: Path,
        cortex_cli_version: str,
    ) -> HarnessManifestInput:
        return HarnessManifestInput(
            root_run_id=self.root_run_id,
            trial_id=self.trial_id,
            arm=self.arm,
            wheel_path=self.wheel_path,
            lockfile_path=self.lockfile_path,
            lockfile_manifest_path=self.lockfile_manifest_path,
            npm_artifact_path=npm_artifact_path,
            container=self.container,
            resolved_cwd=resolved_cwd,
            cortex_cli_version=cortex_cli_version,
        )


def _required_text(values: Mapping[str, object], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"manifest field '{key}' must be a non-empty string")
    return value


def _optional_text(values: Mapping[str, object], key: str) -> str | None:
    value = values.get(key)
    if value is None or isinstance(value, str):
        return value
    raise ValueError(f"manifest field '{key}' must be a string or null")


def parse_manifest_seed(values: Mapping[str, object]) -> HarnessManifestSeed:
    image_size = values.get("image_size_bytes")
    if image_size is not None and not isinstance(image_size, int):
        raise ValueError("manifest field 'image_size_bytes' must be an integer or null")
    return HarnessManifestSeed(
        root_run_id=_required_text(values, "root_run_id"),
        trial_id=_required_text(values, "trial_id"),
        arm=_required_text(values, "arm"),
        wheel_path=Path(_required_text(values, "wheel_path")),
        lockfile_path=Path(_required_text(values, "lockfile_path")),
        lockfile_manifest_path=_required_text(values, "lockfile_manifest_path"),
        npm_artifact_path=Path(_required_text(values, "npm_artifact_path")),
        container=ContainerImage(
            _optional_text(values, "image_ref"),
            _optional_text(values, "image_digest"),
            image_size,
        ),
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _created_at(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _artifact_blocks(inputs: HarnessManifestInput) -> dict[str, object]:
    return {
        "wheel": {
            "filename": inputs.wheel_path.name,
            "sha256": _sha256_file(inputs.wheel_path),
        },
        "lockfile": {
            "path": inputs.lockfile_manifest_path,
            "sha256": _sha256_file(inputs.lockfile_path),
        },
        "cortex_npm_artifact": {
            "filename": inputs.npm_artifact_path.name,
            "sha256": _sha256_file(inputs.npm_artifact_path),
        },
    }


def build_harness_manifest(
    inputs: HarnessManifestInput, *, created_at: datetime | None = None
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "created_at": _created_at(created_at or datetime.now(UTC)),
        "root_run_id": inputs.root_run_id,
        "trial_id": inputs.trial_id,
        "arm": inputs.arm,
        **_artifact_blocks(inputs),
        "python": {"version": platform.python_version()},
        "harbor": {"distribution": "harbor", "version": version("harbor")},
        "container": asdict(inputs.container),
        "resolved_cwd": asdict(inputs.resolved_cwd),
        "cortex_cli": {"version": inputs.cortex_cli_version},
        "model_execution_identity_hash": None,
        "role_tool_surface_hash": None,
        "bundle_manifest_hash": None,
        "proxy": None,
    }
    return document


def write_harness_manifest(
    artifact_dir: Path, document: Mapping[str, object]
) -> Path:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    output_path = artifact_dir / MANIFEST_FILENAME
    output_path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    return output_path
