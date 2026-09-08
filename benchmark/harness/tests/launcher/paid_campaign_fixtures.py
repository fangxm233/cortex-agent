# input:  committed campaigns, temporary Git trees, provenance APIs
# output: isolated campaign paths and verified synthetic artifacts
# pos:    Hermetic paid-launch infrastructure fixtures
# >>> If I am updated, update my header and folder CORTEX.md <<<

import subprocess
from pathlib import Path

import yaml

from cortex_bench_harness.artifact_provenance import (
    NPM_SCOPE,
    WHEEL_SCOPE,
    read_source_state,
    verify_artifact,
    write_provenance,
)

SOURCE_FILES = {
    "wheel_path": "benchmark/harness/src/fixture.py",
    "npm_artifact_path": "agent-server/src/fixture.ts",
}
ARTIFACT_SCOPES = {"wheel_path": WHEEL_SCOPE, "npm_artifact_path": NPM_SCOPE}


def git(checkout: Path, *arguments: str) -> None:
    subprocess.run(
        ["git", *arguments], cwd=checkout,
        check=True, capture_output=True, text=True,
    )


def synthetic_checkout(root: Path) -> Path:
    checkout = root / "checkout"
    for relative in SOURCE_FILES.values():
        path = checkout / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# synthetic source\n", encoding="utf-8")
    (checkout / "benchmark/harness/uv.lock").write_text("version = 1\n", encoding="utf-8")
    (checkout / ".gitignore").write_text("dist/\n", encoding="utf-8")
    git(checkout, "init", "-q")
    git(checkout, "add", ".")
    git(checkout, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic fixture sources")
    return checkout


def synthetic_artifacts(checkout: Path, manifest: dict[str, object]) -> None:
    """Only byte provenance is exercised; these packages are never installed."""
    artifacts = checkout / "benchmark/harness/dist"
    artifacts.mkdir(parents=True)
    for key, scope in ARTIFACT_SCOPES.items():
        artifact = artifacts / Path(str(manifest[key])).name
        artifact.write_bytes(f"synthetic {key} bytes\n".encode())
        write_provenance(
            artifact, read_source_state(checkout, scope), built_at="2026-01-01T00:00:00Z")
        manifest[key] = str(artifact)
    # Both start valid before a negative case spoils exactly one target.
    for key, scope in ARTIFACT_SCOPES.items():
        verify_artifact(Path(str(manifest[key])), checkout, scope)


def stage_campaign(root: Path, source_path: Path) -> Path:
    """Preserve the committed experiment; relocate only its infrastructure."""
    checkout = synthetic_checkout(root)
    document = yaml.safe_load(source_path.read_text(encoding="utf-8"))
    manifest = document["manifest"]
    manifest["lockfile_path"] = str(checkout / "benchmark/harness/uv.lock")
    synthetic_artifacts(checkout, manifest)
    for task in document["tasks"]:
        task["path"] = str((source_path.parent / task["path"]).resolve())
    document["trials_dir"] = str(checkout / "trials")
    campaigns = checkout / "benchmark/campaigns"
    campaigns.mkdir(parents=True)
    path = campaigns / source_path.name
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return path
