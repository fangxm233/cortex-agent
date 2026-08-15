# input:  a synthetic checkout, a built artifact and its provenance sidecar
# output: assertions that the staleness gate fires on every way an artifact can stop being current
# pos:    Contract test for the trial artifact provenance gate
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The r6 campaign ran a 34-hour-stale agent-server and nothing objected. These tests are the
# objection. A gate that silently passes is worse than no gate, because it converts "nobody
# checked" into "something checked and was happy", so each case here breaks the correspondence in
# one specific way and asserts a refusal.

import json
import subprocess
from pathlib import Path

import pytest

from cortex_bench_harness.artifact_provenance import (
    PROVENANCE_SCHEMA_VERSION,
    ProvenanceError,
    SourceScope,
    read_source_state,
    sidecar_path,
    verify_artifact,
    write_provenance,
)

SCOPE = SourceScope("test_scope", ("src", "config.json"), ("src/generated/",))


def git(checkout: Path, *arguments: str) -> None:
    subprocess.run(["git", *arguments], cwd=checkout, check=True, capture_output=True, text=True)


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text("print('one')\n", encoding="utf-8")
    (root / "config.json").write_text("{}\n", encoding="utf-8")
    (root / "dist").mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "test")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "initial")
    return root


def build_artifact(checkout: Path, content: bytes = b"artifact-bytes") -> Path:
    artifact = checkout / "dist" / "thing.tgz"
    artifact.write_bytes(content)
    write_provenance(artifact, read_source_state(checkout, SCOPE), built_at="2026-01-01T00:00:00Z")
    return artifact


def test_a_freshly_built_artifact_verifies_against_its_own_checkout(checkout: Path) -> None:
    artifact = build_artifact(checkout)

    verified = verify_artifact(artifact, checkout, SCOPE)

    assert verified["scope"] == SCOPE.name
    assert verified["dirty"] is False


def test_editing_a_source_file_makes_the_artifact_stale(checkout: Path) -> None:
    """The r6 case exactly: source moved forward, the artifact did not."""
    artifact = build_artifact(checkout)
    (checkout / "src" / "main.py").write_text("print('two')\n", encoding="utf-8")

    with pytest.raises(ProvenanceError, match="built from different source"):
        verify_artifact(artifact, checkout, SCOPE)


def test_an_unstaged_new_source_file_makes_the_artifact_stale(checkout: Path) -> None:
    """A file nobody has added yet still compiles into the build, so it must count."""
    artifact = build_artifact(checkout)
    (checkout / "src" / "extra.py").write_text("print('new')\n", encoding="utf-8")

    with pytest.raises(ProvenanceError, match="built from different source"):
        verify_artifact(artifact, checkout, SCOPE)


def test_renaming_a_source_file_makes_the_artifact_stale(checkout: Path) -> None:
    """Identical bytes at a different path are a different tree, so the path is digested too."""
    artifact = build_artifact(checkout)
    (checkout / "src" / "main.py").rename(checkout / "src" / "renamed.py")

    with pytest.raises(ProvenanceError, match="built from different source"):
        verify_artifact(artifact, checkout, SCOPE)


def test_replacing_the_artifact_after_recording_it_is_refused(checkout: Path) -> None:
    artifact = build_artifact(checkout)
    artifact.write_bytes(b"swapped-bytes")

    with pytest.raises(ProvenanceError, match="has changed since its provenance"):
        verify_artifact(artifact, checkout, SCOPE)


def test_an_artifact_without_provenance_is_refused(checkout: Path) -> None:
    artifact = build_artifact(checkout)
    sidecar_path(artifact).unlink()

    with pytest.raises(ProvenanceError, match="carries no provenance record"):
        verify_artifact(artifact, checkout, SCOPE)


def test_a_missing_artifact_is_refused(checkout: Path) -> None:
    with pytest.raises(ProvenanceError, match="does not exist"):
        verify_artifact(checkout / "dist" / "absent.tgz", checkout, SCOPE)


def test_a_provenance_document_from_another_schema_is_refused(checkout: Path) -> None:
    artifact = build_artifact(checkout)
    sidecar = sidecar_path(artifact)
    document = json.loads(sidecar.read_text(encoding="utf-8"))
    document["schema_version"] = "cortex-bench-artifact-provenance/99"
    sidecar.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ProvenanceError, match="declares schema"):
        verify_artifact(artifact, checkout, SCOPE)


def test_provenance_recorded_for_another_scope_is_refused(checkout: Path) -> None:
    """The two artifacts have different source scopes; one's record must not satisfy the other."""
    artifact = build_artifact(checkout)
    other = SourceScope("different_scope", SCOPE.roots, SCOPE.excluded)

    with pytest.raises(ProvenanceError, match="records scope"):
        verify_artifact(artifact, checkout, other)


def test_build_outputs_do_not_move_the_fingerprint(checkout: Path) -> None:
    """Writing the sidecar into an excluded output directory must not invalidate the artifact.

    Otherwise recording provenance would immediately falsify it, and every launch would refuse.
    """
    artifact = build_artifact(checkout)
    (checkout / "dist" / "leftover.txt").write_text("junk\n", encoding="utf-8")
    (checkout / "src" / "generated").mkdir()
    (checkout / "src" / "generated" / "out.py").write_text("generated\n", encoding="utf-8")

    assert verify_artifact(artifact, checkout, SCOPE)["scope"] == SCOPE.name


def test_a_scope_matching_nothing_is_refused_rather_than_hashing_to_a_constant(
    checkout: Path,
) -> None:
    """An empty scope digests to the same value for every tree, so it would verify anything."""
    empty = SourceScope("empty", ("no/such/path",), ())

    with pytest.raises(ProvenanceError, match="no source files found"):
        read_source_state(checkout, empty)


def test_a_dirty_build_is_pinned_to_the_tree_it_was_built_from(checkout: Path) -> None:
    """Uncommitted work is recorded, and verified as strictly as committed work."""
    (checkout / "src" / "main.py").write_text("print('uncommitted')\n", encoding="utf-8")
    artifact = build_artifact(checkout)

    verified = verify_artifact(artifact, checkout, SCOPE)
    assert verified["dirty"] is True

    document = json.loads(sidecar_path(artifact).read_text(encoding="utf-8"))
    assert document["schema_version"] == PROVENANCE_SCHEMA_VERSION
    assert document["source"]["dirty"] is True

    git(checkout, "checkout", "--", "src/main.py")
    with pytest.raises(ProvenanceError, match="built from different source"):
        verify_artifact(artifact, checkout, SCOPE)


def test_an_edit_confined_to_an_excluded_path_is_not_reported_as_dirty(checkout: Path) -> None:
    """`dirty` tracks the files the artifact is built from, or it trains operators to ignore it."""
    build_artifact(checkout)
    (checkout / "src" / "generated").mkdir()
    (checkout / "src" / "generated" / "out.py").write_text("generated\n", encoding="utf-8")

    assert read_source_state(checkout, SCOPE).dirty is False

    (checkout / "src" / "main.py").write_text("print('edited')\n", encoding="utf-8")
    assert read_source_state(checkout, SCOPE).dirty is True
