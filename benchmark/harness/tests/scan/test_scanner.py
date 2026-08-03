# input:  named trial artifacts, expected sources, and leak rules
# output: leak detection and closed-inventory assertions
# pos:    Negative coverage tests for the artifact scanner
# >>> If I am updated, update my header and folder CORTEX.md <<<

from collections import Counter
from pathlib import Path

import pytest

from cortex_bench_harness.scan import (
    ArtifactInventory,
    ArtifactReadError,
    ScanPolicy,
    SourceScan,
    UnclassifiedFile,
    scan_trial_artifacts,
)

SOURCES = ("stdout", "stderr", "events", "manifest", "workspace_diff")
FILENAMES = {
    "stdout": "stdout.txt",
    "stderr": "stderr.txt",
    "events": "events.jsonl",
    "manifest": "cortex-bench-harness-manifest.json",
    "workspace_diff": "workspace.diff",
}
CREDENTIAL = "sk-ant-SYNTHETIC-SCAN-TRIAL"
MAPPING = f"dummy-trial-token -> {CREDENTIAL}"
CHECKOUT_PATH = "/srv/checkout/cortex"
HOSTNAME = "synthetic-build-host"
CONTAMINATION = "\n".join([
    CREDENTIAL,
    MAPPING,
    "/home/alice/private/file.txt",
    f"{CHECKOUT_PATH}/benchmark/result.json",
    HOSTNAME,
])


def make_artifacts(tmp_path: Path, contaminated: str) -> ArtifactInventory:
    paths: dict[str, Path] = {}
    for source in SOURCES:
        path = tmp_path / FILENAMES[source]
        path.write_text(CONTAMINATION if source == contaminated else "clean\n")
        paths[source] = path
    return ArtifactInventory(
        sources=paths,
        expected_sources=frozenset(SOURCES),
        trial_roots=(tmp_path,),
    )


def policy() -> ScanPolicy:
    return ScanPolicy(
        secrets={
            "synthetic_credential": CREDENTIAL,
            "dummy_to_real_mapping": MAPPING,
        },
        repository_checkout=CHECKOUT_PATH,
        hostname=HOSTNAME,
    )


def assert_detected(tmp_path: Path, contaminated: str) -> None:
    report = scan_trial_artifacts(make_artifacts(tmp_path, contaminated), policy())
    counts = Counter((finding.source, finding.rule_id) for finding in report.findings)
    assert report.exit_code == 1
    assert report.clean is False
    assert tuple(item.source for item in report.sources) == SOURCES
    assert counts == Counter({
        (contaminated, "secret:synthetic_credential"): 2,
        (contaminated, "secret:dummy_to_real_mapping"): 1,
        (contaminated, "host:home_path"): 1,
        (contaminated, "host:repository_checkout"): 1,
        (contaminated, "host:hostname"): 1,
    })


def test_detects_planted_leaks_in_stdout(tmp_path: Path) -> None:
    assert_detected(tmp_path, "stdout")


def test_detects_planted_leaks_in_stderr(tmp_path: Path) -> None:
    assert_detected(tmp_path, "stderr")


def test_detects_planted_leaks_in_events(tmp_path: Path) -> None:
    assert_detected(tmp_path, "events")


def test_detects_planted_leaks_in_manifest(tmp_path: Path) -> None:
    assert_detected(tmp_path, "manifest")


def test_detects_planted_leaks_in_workspace_diff(tmp_path: Path) -> None:
    assert_detected(tmp_path, "workspace_diff")


def test_scans_generalized_named_source(tmp_path: Path) -> None:
    source = tmp_path / "child-journal.jsonl"
    source.write_text("clean child journal\n")
    inventory = ArtifactInventory(
        {"child_journal": source}, frozenset({"child_journal"}), (tmp_path,),
    )

    report = scan_trial_artifacts(inventory, policy())

    assert report.sources == (SourceScan("child_journal", source.stat().st_size),)
    assert report.clean is True
    assert report.exit_code == 0


def test_rejects_noncanonical_harness_manifest_filename(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    wrong_manifest = tmp_path / "manifest.txt"
    wrong_manifest.write_text("clean\n")
    sources = dict(artifacts.sources)
    sources["manifest"] = wrong_manifest
    with pytest.raises(ValueError, match="cortex-bench-harness-manifest.json"):
        scan_trial_artifacts(
            ArtifactInventory(sources, artifacts.expected_sources, artifacts.trial_roots),
            policy(),
        )


def test_rejects_empty_expected_source_set(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="expected source"):
        scan_trial_artifacts(ArtifactInventory({}, frozenset(), (tmp_path,)), policy())


def test_rejects_empty_trial_root_set(tmp_path: Path) -> None:
    source = tmp_path / "stdout.txt"
    source.write_text("clean\n")
    with pytest.raises(ValueError, match="trial root"):
        scan_trial_artifacts(
            ArtifactInventory({"stdout": source}, frozenset({"stdout"}), ()),
            policy(),
        )


def test_rejects_artifact_source_outside_trial_roots(tmp_path: Path) -> None:
    root = tmp_path / "trial"
    root.mkdir()
    source = tmp_path / "outside.txt"
    source.write_text("clean\n")
    with pytest.raises(ValueError, match="contained by trial roots"):
        scan_trial_artifacts(
            ArtifactInventory({"stdout": source}, frozenset({"stdout"}), (root,)),
            policy(),
        )


def test_rejects_artifact_source_that_escapes_root_with_parent_segment(
    tmp_path: Path,
) -> None:
    root = tmp_path / "trial"
    root.mkdir()
    source = tmp_path / "outside.txt"
    source.write_text("clean\n")
    escaped_source = root / ".." / source.name

    with pytest.raises(ValueError, match="contained by trial roots"):
        scan_trial_artifacts(
            ArtifactInventory(
                {"stdout": escaped_source}, frozenset({"stdout"}), (root,),
            ),
            policy(),
        )


@pytest.mark.parametrize("source_name", [f"log-{CREDENTIAL}", "logs/home/alice/private"])
def test_rejects_sensitive_source_name(tmp_path: Path, source_name: str) -> None:
    source = tmp_path / "source.txt"
    source.write_text("clean\n")
    inventory = ArtifactInventory(
        {source_name: source}, frozenset({source_name}), (tmp_path,),
    )

    with pytest.raises(ValueError) as raised:
        scan_trial_artifacts(inventory, policy())

    assert CREDENTIAL not in str(raised.value)
    assert "/home/alice" not in str(raised.value)


def test_reports_unclassified_file_under_trial_root(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    (tmp_path / "undeclared.log").write_text("clean\n")

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, "undeclared.log"),)
    assert report.missing_sources == ()
    assert report.clean is False
    assert report.exit_code == 1


def test_reports_unclassified_symlink_to_declared_file(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    (tmp_path / "undeclared-link.txt").symlink_to(artifacts.sources["stdout"])

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, "undeclared-link.txt"),)
    assert report.clean is False
    assert report.exit_code == 1


def test_rejects_declared_source_symlink(tmp_path: Path) -> None:
    root = tmp_path / "trial"
    root.mkdir()
    target = tmp_path / "outside.txt"
    target.write_text("clean\n")
    source = root / "stdout.txt"
    source.symlink_to(target)
    inventory = ArtifactInventory(
        {"stdout": source}, frozenset({"stdout"}), (root,),
    )

    report = scan_trial_artifacts(inventory, policy())

    assert report.missing_sources == ("stdout",)
    assert report.unclassified_files == (UnclassifiedFile(0, "stdout.txt"),)
    assert report.clean is False
    assert report.exit_code == 1


def test_reports_unclassified_non_file_symlinks(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    target = tmp_path / "target-directory"
    target.mkdir()
    (tmp_path / "undeclared-directory-link").symlink_to(target, target_is_directory=True)
    (tmp_path / "undeclared-missing-link").symlink_to(tmp_path / "missing")

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (
        UnclassifiedFile(0, "undeclared-directory-link"),
        UnclassifiedFile(0, "undeclared-missing-link"),
    )
    assert report.clean is False
    assert report.exit_code == 1


def test_redacts_secret_from_unclassified_relative_path(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    (tmp_path / f"undeclared-{CREDENTIAL}.log").write_text("clean\n")

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, None),)
    assert CREDENTIAL not in str(report.as_dict())


def test_redaction_marker_cannot_echo_sensitive_literal(tmp_path: Path) -> None:
    sensitive_literal = "<redacted>"
    artifacts = make_artifacts(tmp_path, "none")
    (tmp_path / f"undeclared-{sensitive_literal}.log").write_text("clean\n")
    scan_policy = ScanPolicy(
        secrets={"marker_collision": sensitive_literal},
        repository_checkout=CHECKOUT_PATH,
        hostname=HOSTNAME,
    )

    report = scan_trial_artifacts(artifacts, scan_policy)

    assert sensitive_literal not in str(report.as_dict())


def test_redacts_home_path_from_unclassified_relative_path(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    directory = tmp_path / "prefix" / "home" / "alice"
    directory.mkdir(parents=True)
    (directory / "private.log").write_text("clean\n")

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, None),)
    assert "/home/alice" not in str(report.as_dict())


def test_reports_declared_source_missing_from_disk(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    artifacts.sources["events"].unlink()

    report = scan_trial_artifacts(artifacts, policy())

    assert report.missing_sources == ("events",)
    assert report.unclassified_files == ()
    assert report.clean is False
    assert report.exit_code == 1


def test_rejects_unavailable_trial_root(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    inventory = ArtifactInventory(
        artifacts.sources,
        artifacts.expected_sources,
        (*artifacts.trial_roots, tmp_path / "missing-root"),
    )

    with pytest.raises(ArtifactReadError) as raised:
        scan_trial_artifacts(inventory, policy())

    assert raised.value.source == "trial_root:1"
