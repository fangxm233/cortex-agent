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
        # alice has a home on this synthetic host, which is what makes `/home/alice` a host
        # disclosure rather than a string of that shape.
        host_home_names=("alice",),
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


def test_distinguishes_nested_container_home_dotfile_from_host_home(tmp_path: Path) -> None:
    launcher = tmp_path / "env"
    launcher.write_text('export PATH="/logs/agent/trial-home/home/.local/bin:$PATH"\n')
    leaked = tmp_path / "leaked.txt"
    leaked.write_text("/home/alice/private/file.txt\n")
    inventory = ArtifactInventory(
        {"launcher": launcher, "leaked": leaked}, frozenset({"launcher", "leaked"}),
        (tmp_path,),
    )

    report = scan_trial_artifacts(inventory, policy())

    assert [(finding.source, finding.rule_id) for finding in report.findings] == [
        ("leaked", "host:home_path"),
    ]


def test_ignores_a_home_path_that_names_no_account_on_this_host(tmp_path: Path) -> None:
    """A third-party package quoting its author's home is not a disclosure of ours.

    `pyknotid` hardcodes `/home/asandy/knotcatalogue/...` in its own source, so every trial that
    installs it carries that string into the workspace diff. Matching the shape refused fifteen
    trials that had solved their task on 2026-08-27. The account that really exists here still
    fires, on the same line, so the rule loses no reach.
    """
    source = tmp_path / "workspace.diff"
    source.write_text(
        "+    catalogue = open('/home/asandy/knotcatalogue/raw_data/knotinfo.csv', 'r')\n"
        "+    fallback = '/home/alice/private/file.txt'\n",
    )
    inventory = ArtifactInventory({"diff": source}, frozenset({"diff"}), (tmp_path,))

    report = scan_trial_artifacts(inventory, policy())

    assert [(finding.rule_id, finding.line) for finding in report.findings] == [
        ("host:home_path", 2),
    ]


def test_exact_dot_prefixed_host_home_literal_remains_protected(tmp_path: Path) -> None:
    source = tmp_path / "leaked.txt"
    source.write_text("/home/.operator/private/file.txt\n")
    scan_policy = ScanPolicy(
        secrets={"synthetic_credential": CREDENTIAL},
        repository_checkout=CHECKOUT_PATH, hostname=HOSTNAME,
        home_path="/home/.operator",
    )

    report = scan_trial_artifacts(
        ArtifactInventory({"leaked": source}, frozenset({"leaked"}), (tmp_path,)),
        scan_policy,
    )

    assert [(finding.source, finding.rule_id) for finding in report.findings] == [
        ("leaked", "host:home_path_literal"),
    ]


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


def test_classifies_in_root_alias_of_a_scanned_source(tmp_path: Path) -> None:
    """An alias of a source whose bytes were scanned hides nothing.

    The production daemon replaces the PI agent directory's auth.json with a link to the same
    file under the container HOME on every spawn, so every multi-agent arm collects one such
    alias. Reporting it unclassified makes `clean=false` the normal readout, which is where a
    genuinely out-of-root alias would later hide.
    """
    artifacts = make_artifacts(tmp_path, "none")
    (tmp_path / "alias.txt").symlink_to(artifacts.sources["stdout"])
    (tmp_path / "alias-of-alias.txt").symlink_to(tmp_path / "alias.txt")

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == ()
    assert report.missing_sources == ()
    assert report.clean is True
    assert report.exit_code == 0


def test_classifies_container_absolute_alias_of_same_root_scanned_source(
    tmp_path: Path,
) -> None:
    root = tmp_path / "agent"
    target = root / "production-home/container-home/.pi/agent/auth.json"
    target.parent.mkdir(parents=True)
    target.write_text("clean\n")
    alias = root / "production-home/data/pi/auth.json"
    alias.parent.mkdir(parents=True)
    alias.symlink_to("/logs/agent/production-home/container-home/.pi/agent/auth.json")
    inventory = ArtifactInventory(
        {"auth": target}, frozenset({"auth"}), (root,),
        container_roots={root: Path("/logs/agent")},
    )

    report = scan_trial_artifacts(inventory, policy())

    assert report.unclassified_files == ()
    assert report.clean is True


def test_reports_container_absolute_alias_to_another_root(tmp_path: Path) -> None:
    agent = tmp_path / "agent"
    verifier = tmp_path / "verifier"
    agent.mkdir()
    target = verifier / "reward.json"
    verifier.mkdir()
    target.write_text("clean\n")
    alias = agent / "reward.json"
    alias.symlink_to("/logs/verifier/reward.json")
    inventory = ArtifactInventory(
        {"reward": target}, frozenset({"reward"}), (agent, verifier),
        container_roots={agent: Path("/logs/agent"), verifier: Path("/logs/verifier")},
    )

    report = scan_trial_artifacts(inventory, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, "reward.json"),)
    assert report.clean is False


def test_rejects_one_container_root_mapped_to_two_trial_roots(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    source = first / "source.txt"
    source.write_text("clean\n")
    inventory = ArtifactInventory(
        {"source": source}, frozenset({"source"}), (first, second),
        container_roots={first: Path("/logs/shared"), second: Path("/logs/shared")},
    )

    with pytest.raises(ValueError, match="must not overlap"):
        scan_trial_artifacts(inventory, policy())


def test_reports_alias_whose_resolved_target_leaves_every_trial_root(tmp_path: Path) -> None:
    root = tmp_path / "trial"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("clean\n")
    artifacts = make_artifacts(root, "none")
    (root / "alias.txt").symlink_to(outside)

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, "alias.txt"),)
    assert report.clean is False


def test_reports_alias_chain_that_escapes_the_trial_root_at_any_hop(tmp_path: Path) -> None:
    root = tmp_path / "trial"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("clean\n")
    (tmp_path / "outside-link.txt").symlink_to(outside)
    artifacts = make_artifacts(root, "none")
    (root / "alias.txt").symlink_to(tmp_path / "outside-link.txt")

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, "alias.txt"),)
    assert report.clean is False


def test_reports_alias_chain_that_leaves_then_returns_to_the_trial_root(
    tmp_path: Path,
) -> None:
    root = tmp_path / "trial"
    root.mkdir()
    artifacts = make_artifacts(root, "none")
    outside = tmp_path / "outside-link.txt"
    outside.symlink_to(artifacts.sources["stdout"])
    (root / "alias.txt").symlink_to(outside)

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (UnclassifiedFile(0, "alias.txt"),)
    assert report.clean is False


def test_reports_alias_to_a_scanned_source_in_another_trial_root(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    first_artifacts = make_artifacts(first, "none")
    second_artifacts = make_artifacts(second, "none")
    alias = first / "cross-root.txt"
    alias.symlink_to(second_artifacts.sources["stdout"])
    inventory = ArtifactInventory(
        sources={
            **first_artifacts.sources,
            "second_stdout": second_artifacts.sources["stdout"],
        },
        expected_sources=first_artifacts.expected_sources | {"second_stdout"},
        trial_roots=(first, second),
    )

    report = scan_trial_artifacts(inventory, policy())

    assert UnclassifiedFile(0, "cross-root.txt") in report.unclassified_files
    assert report.clean is False


def test_reports_alias_of_an_in_root_file_that_was_never_scanned(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    (tmp_path / "undeclared.log").write_text("clean\n")
    (tmp_path / "alias.txt").symlink_to(tmp_path / "undeclared.log")

    report = scan_trial_artifacts(artifacts, policy())

    assert report.unclassified_files == (
        UnclassifiedFile(0, "alias.txt"), UnclassifiedFile(0, "undeclared.log"),
    )
    assert report.clean is False


def test_declared_source_that_aliases_a_scanned_source_is_scanned_not_missing(
    tmp_path: Path,
) -> None:
    """`missing_sources` and `unclassified_files` read one file the same way."""
    artifacts = make_artifacts(tmp_path, "none")
    alias = tmp_path / "extra.txt"
    alias.symlink_to(artifacts.sources["stdout"])
    inventory = ArtifactInventory(
        sources={**artifacts.sources, "extra": alias},
        expected_sources=artifacts.expected_sources | {"extra"},
        trial_roots=artifacts.trial_roots,
    )

    report = scan_trial_artifacts(inventory, policy())

    assert report.missing_sources == ()
    assert SourceScan("extra", len("clean\n")) in report.sources
    assert report.unclassified_files == ()
    assert report.clean is True


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
