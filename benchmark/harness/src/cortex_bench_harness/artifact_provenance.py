# input:  a built trial artifact and the checkout it was supposed to be built from
# output: a provenance sidecar, and the verdict on whether an artifact still matches its source
# pos:    Trial artifact source-provenance record and staleness gate
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# WHY THIS EXISTS
#
# `manifest.py` already records the sha256 of every artifact a trial installs, so a published trial
# can always answer "which bytes ran". It cannot answer "are those bytes this source", and nothing
# else asked. On 2026-08-14 the r6 campaign ran with a fresh Python wheel and an
# `cortex-agent-server-2026.8.6.tgz` packed 34 hours earlier: the D2 journal-grouping fix was
# committed, the host ran it, the container did not, and every trial died of the bug that had
# already been fixed. The manifest recorded that stale artifact's digest faithfully. The run looked
# reproducible and traceable the whole way down, and was measuring code that no longer existed.
#
# So each artifact gets a sidecar naming the source it came from, and the launcher refuses to start
# a campaign whose artifacts do not match the checkout it is launching from. The digest answers
# which bytes; this answers whether they are the right ones.
#
# WHAT THE FINGERPRINT COVERS, and what it does not
#
# Every file git knows about under the artifact's source roots -- tracked, plus untracked files that
# are not ignored, so that a new source file nobody staged yet still counts. Content is read from
# the working tree, not from the index, because the working tree is what a build compiles.
#
# Ignored paths are excluded, which excludes `node_modules` and `dist`. A dependency tree changed in
# place therefore does not move the fingerprint; the lockfiles that determine it are tracked and do.
# That is the deliberate edge of this check: it catches source drift, not a hand-edited dependency.
#
# The roots are wide on purpose. Naming the precise build inputs would be smaller and would invite
# exactly the failure this file exists to prevent -- an input nobody listed, silently not covered.
# Over-inclusion costs a rebuild that was not strictly needed, and a rebuild is cheap.

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

PROVENANCE_SCHEMA_VERSION = "cortex-bench-artifact-provenance/1"
PROVENANCE_SUFFIX = ".provenance.json"

# Repository-relative roots whose contents determine each artifact, and the paths inside them that
# are build outputs rather than build inputs.
WHEEL_SOURCE_ROOTS = ("benchmark/harness",)
WHEEL_EXCLUDED = ("benchmark/harness/dist/", "benchmark/harness/tests/")

NPM_SOURCE_ROOTS = (
    "agent-server", "web", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
)
NPM_EXCLUDED = ("agent-server/dist/", "agent-server/web/dist/", "web/dist/")

_READ_CHUNK = 1 << 20


class ProvenanceError(RuntimeError):
    """An artifact could not be shown to correspond to the checkout being launched from."""


@dataclass(frozen=True)
class SourceScope:
    """The part of a checkout that determines one artifact."""

    name: str
    roots: tuple[str, ...]
    excluded: tuple[str, ...]


WHEEL_SCOPE = SourceScope("cortex_bench_harness_wheel", WHEEL_SOURCE_ROOTS, WHEEL_EXCLUDED)
NPM_SCOPE = SourceScope("cortex_agent_server_npm", NPM_SOURCE_ROOTS, NPM_EXCLUDED)


@dataclass(frozen=True)
class SourceState:
    """What the checkout looked like when an artifact was built."""

    scope: str
    commit: str
    dirty: bool
    file_count: int
    fingerprint: str

    def as_document(self) -> dict[str, object]:
        return {
            "scope": self.scope, "commit": self.commit, "dirty": self.dirty,
            "file_count": self.file_count, "fingerprint": self.fingerprint,
        }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_READ_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def read_source_state(checkout: Path, scope: SourceScope) -> SourceState:
    """Digest every source file in one scope, in a fixed order, as the working tree holds it.

    The per-file digest is bound to the path it was read from, so moving a file between two names
    changes the fingerprint even though the bytes on disk did not change.
    """
    paths = _scoped_paths(checkout, scope)
    digest = hashlib.sha256()
    counted = 0
    for relative in paths:
        absolute = checkout / relative
        try:
            content = sha256_file(absolute)
        except OSError:
            # A path git lists but that cannot be read -- a dangling symlink, a race with an editor.
            # It is part of the source state, so it is recorded as unreadable rather than skipped:
            # skipping would let two different trees agree.
            content = "unreadable"
        digest.update(f"{relative}\0{content}\0".encode())
        counted += 1
    return SourceState(
        scope=scope.name, commit=_git_commit(checkout), dirty=_git_dirty(checkout, scope),
        file_count=counted, fingerprint=digest.hexdigest(),
    )


def sidecar_path(artifact: Path) -> Path:
    return artifact.with_name(artifact.name + PROVENANCE_SUFFIX)


def write_provenance(artifact: Path, source: SourceState, *, built_at: str) -> Path:
    document = {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "artifact": {"filename": artifact.name, "sha256": sha256_file(artifact)},
        "source": source.as_document(),
        "built_at": built_at,
    }
    target = sidecar_path(artifact)
    target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


def verify_artifact(artifact: Path, checkout: Path, scope: SourceScope) -> dict[str, object]:
    """Refuse unless this artifact was built from the source this checkout currently holds.

    Every failure is a refusal. There is no warn-and-continue path, because the whole cost of the
    r6 incident was that a stale artifact produced a run that looked entirely normal.
    """
    if not artifact.is_file():
        raise ProvenanceError(f"{artifact} does not exist: build the trial artifacts first")
    sidecar = sidecar_path(artifact)
    if not sidecar.is_file():
        raise ProvenanceError(
            f"{artifact.name} carries no provenance record ({sidecar.name}). It cannot be shown to "
            "match this checkout, which is the one thing a paid run must not guess. Rebuild with "
            "scripts/build-trial-artifacts.py")
    try:
        document = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProvenanceError(f"{sidecar.name} is unreadable: {error}") from error
    if not isinstance(document, dict):
        raise ProvenanceError(f"{sidecar.name} is not a provenance document")
    version = document.get("schema_version")
    if version != PROVENANCE_SCHEMA_VERSION:
        raise ProvenanceError(
            f"{sidecar.name} declares schema {version!r}, not {PROVENANCE_SCHEMA_VERSION!r}")
    recorded = document.get("artifact")
    if not isinstance(recorded, dict) or not isinstance(recorded.get("sha256"), str):
        raise ProvenanceError(f"{sidecar.name} records no artifact digest")
    observed_digest = sha256_file(artifact)
    if observed_digest != recorded["sha256"]:
        raise ProvenanceError(
            f"{artifact.name} has changed since its provenance was recorded "
            f"(sha256 {observed_digest[:12]} against the recorded {recorded['sha256'][:12]}). "
            "Rebuild with scripts/build-trial-artifacts.py")
    stated = document.get("source")
    if not isinstance(stated, dict) or not isinstance(stated.get("fingerprint"), str):
        raise ProvenanceError(f"{sidecar.name} records no source fingerprint")
    if stated.get("scope") != scope.name:
        raise ProvenanceError(
            f"{sidecar.name} records scope {stated.get('scope')!r}, not {scope.name!r}")
    current = read_source_state(checkout, scope)
    if current.fingerprint != stated["fingerprint"]:
        raise ProvenanceError(
            f"{artifact.name} was built from different source than this checkout now holds "
            f"(built from commit {str(stated.get('commit'))[:12]}"
            f"{', dirty' if stated.get('dirty') else ''}, launching from "
            f"{current.commit[:12]}{', dirty' if current.dirty else ''}). This is exactly how the "
            "r6 campaign measured a 34-hour-stale agent-server. Rebuild with "
            "scripts/build-trial-artifacts.py")
    return {
        "artifact": artifact.name, "sha256": observed_digest, "scope": scope.name,
        "commit": current.commit, "dirty": current.dirty, "fingerprint": current.fingerprint,
    }


def _scoped_paths(checkout: Path, scope: SourceScope) -> list[str]:
    listed = _git_listing(checkout, scope.roots)
    kept = sorted({
        path for path in listed
        if not any(path.startswith(prefix) for prefix in scope.excluded)
    })
    if not kept:
        raise ProvenanceError(
            f"no source files found under {list(scope.roots)} in {checkout}: the fingerprint would "
            "be a constant, and would match anything")
    return kept


def _git_listing(checkout: Path, roots: tuple[str, ...]) -> list[str]:
    output = _git(
        checkout,
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *roots],
    )
    return [entry for entry in output.split("\0") if entry]


def _git_commit(checkout: Path) -> str:
    return _git(checkout, ["rev-parse", "HEAD"]).strip()


def _git_dirty(checkout: Path, scope: SourceScope) -> bool:
    """Whether the files this artifact is actually built from carry uncommitted work.

    Recorded for the operator's benefit only. The fingerprint is what the gate compares, and it is
    computed from file content, so a dirty build is verified exactly as strictly as a clean one --
    it simply pins the artifact to that working tree until it changes again.

    The scope's exclusions apply here too. Reporting an artifact dirty because of an edit to a path
    that provably cannot reach it -- a test, a build output -- would make the field mean "something
    somewhere changed", which is not worth reporting and would train an operator to ignore it.
    """
    lines = _git(checkout, ["status", "--porcelain", "-z", "--", *scope.roots]).split("\0")
    return any(
        not any(entry[3:].startswith(prefix) for prefix in scope.excluded)
        for entry in lines if entry.strip()
    )


def _git(checkout: Path, arguments: list[str]) -> str:
    try:
        completed = subprocess.run(
            ["git", *arguments], cwd=checkout,
            check=True, capture_output=True, text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or error
        raise ProvenanceError(f"git {' '.join(arguments[:2])} failed in {checkout}: {detail}"
                              ) from error
    return completed.stdout
