# input:  wheel/lock bytes, run metadata, manifest serializer
# output: exact H3 schema and hash assertions
# pos:    Contract tests for the harness run manifest
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import platform
from datetime import UTC, datetime
from pathlib import Path

from cortex_bench_harness.cwd import ResolvedCwd
from cortex_bench_harness.manifest import (
    ContainerImage,
    HarnessManifestInput,
    build_harness_manifest,
    write_harness_manifest,
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


EXPECTED_MANIFEST = {
    "schema_version": "cortex-bench-harness-manifest/1",
    "created_at": "2026-08-01T12:00:00Z",
    "root_run_id": "root-install-only",
    "trial_id": "trial-install-only",
    "arm": "cortex-direct",
    "wheel": {
        "filename": "cortex_bench_harness-0.1.0-py3-none-any.whl",
        "sha256": sha256(b"fixed-wheel"),
    },
    "lockfile": {
        "path": "benchmark/harness/uv.lock",
        "sha256": sha256(b"locked-dependencies"),
    },
    "python": {"version": platform.python_version()},
    "harbor": {"distribution": "harbor", "version": "0.20.0"},
    "container": {
        "image_ref": "debian@sha256:abc",
        "image_digest": None,
        "image_size_bytes": None,
    },
    "resolved_cwd": {"pwd_raw": "/app", "realpath": "/app", "exists": True},
    "cortex_cli": {"version": None},
    "model_execution_identity_hash": None,
    "role_tool_surface_hash": None,
    "bundle_manifest_hash": None,
    "proxy": None,
}


def manifest_input(tmp_path: Path) -> HarnessManifestInput:
    wheel_path = tmp_path / "cortex_bench_harness-0.1.0-py3-none-any.whl"
    lockfile_path = tmp_path / "uv.lock"
    wheel_path.write_bytes(b"fixed-wheel")
    lockfile_path.write_bytes(b"locked-dependencies")
    return HarnessManifestInput(
        root_run_id="root-install-only",
        trial_id="trial-install-only",
        arm="cortex-direct",
        wheel_path=wheel_path,
        lockfile_path=lockfile_path,
        lockfile_manifest_path="benchmark/harness/uv.lock",
        container=ContainerImage("debian@sha256:abc", None, None),
        resolved_cwd=ResolvedCwd("/app", "/app", True),
    )


def test_builds_exact_h3_manifest_with_explicit_nulls(tmp_path: Path) -> None:
    document = build_harness_manifest(
        manifest_input(tmp_path),
        created_at=datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
    )

    assert document == EXPECTED_MANIFEST


def test_writes_manifest_to_trial_artifact_directory(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    document = build_harness_manifest(
        manifest_input(tmp_path), created_at=datetime(2026, 8, 1, tzinfo=UTC)
    )

    output_path = write_harness_manifest(artifact_dir, document)

    assert output_path == artifact_dir / "cortex-bench-harness-manifest.json"
    assert json.loads(output_path.read_text()) == document
