# input:  five trial artifacts and configured leak rules
# output: per-source credential and host-path detection assertions
# pos:    Negative coverage tests for the artifact scanner
# >>> If I am updated, update my header and folder CORTEX.md <<<

from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest

from cortex_bench_harness.scan import ArtifactSet, ScanPolicy, scan_trial_artifacts

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


def make_artifacts(tmp_path: Path, contaminated: str) -> ArtifactSet:
    paths: dict[str, Path] = {}
    for source in SOURCES:
        path = tmp_path / FILENAMES[source]
        path.write_text(CONTAMINATION if source == contaminated else "clean\n")
        paths[source] = path
    return ArtifactSet(**paths)


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


def test_rejects_noncanonical_harness_manifest_filename(tmp_path: Path) -> None:
    artifacts = make_artifacts(tmp_path, "none")
    wrong_manifest = tmp_path / "manifest.txt"
    wrong_manifest.write_text("clean\n")
    with pytest.raises(ValueError, match="cortex-bench-harness-manifest.json"):
        scan_trial_artifacts(replace(artifacts, manifest=wrong_manifest), policy())
