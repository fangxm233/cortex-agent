# input:  named artifact inventory, scan policy, and binary streams
# output: closed-inventory credential and host-identity scan report
# pos:    Trial artifact inventory scanner
# >>> If I am updated, update my header and folder CORTEX.md <<<

import re
from collections.abc import Iterator
from pathlib import Path

from ..manifest import MANIFEST_FILENAME
from .models import (
    ArtifactInventory,
    ArtifactReadError,
    Finding,
    ScanPolicy,
    ScanReport,
    SourceScan,
    UnclassifiedFile,
)

HOME_PATH = re.compile(rb"/home/[^/\x00\s]+")
Rule = tuple[str, str, bytes]


def scan_trial_artifacts(
    inventory: ArtifactInventory, policy: ScanPolicy,
) -> ScanReport:
    _validate_inventory(inventory)
    missing_sources = _missing_sources(inventory)
    unclassified_files = _unclassified_files(inventory)
    findings, sources = _scan_present_sources(inventory, missing_sources, policy)
    return ScanReport(
        sources, findings, missing_sources, unclassified_files,
    )


def _validate_inventory(inventory: ArtifactInventory) -> None:
    manifest = inventory.sources.get("manifest")
    if manifest is not None and manifest.name != MANIFEST_FILENAME:
        raise ValueError(f"manifest source must be named {MANIFEST_FILENAME}")


def _missing_sources(inventory: ArtifactInventory) -> tuple[str, ...]:
    return tuple(sorted(
        source for source in inventory.expected_sources
        if source not in inventory.sources or not inventory.sources[source].is_file()
    ))


def _unclassified_files(
    inventory: ArtifactInventory,
) -> tuple[UnclassifiedFile, ...]:
    classified = {
        path.absolute() for source, path in inventory.sources.items()
        if source in inventory.expected_sources and path.is_file()
    }
    discovered: set[Path] = set()
    unclassified: list[UnclassifiedFile] = []
    for root_index, root in enumerate(inventory.trial_roots):
        _append_unclassified(root, root_index, classified, discovered, unclassified)
    return tuple(unclassified)


def _append_unclassified(
    root: Path,
    root_index: int,
    classified: set[Path],
    discovered: set[Path],
    unclassified: list[UnclassifiedFile],
) -> None:
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        absolute = path.absolute()
        if absolute in classified or absolute in discovered:
            continue
        discovered.add(absolute)
        unclassified.append(UnclassifiedFile(root_index, path.relative_to(root).as_posix()))


def _scan_present_sources(
    inventory: ArtifactInventory,
    missing_sources: tuple[str, ...],
    policy: ScanPolicy,
) -> tuple[tuple[Finding, ...], tuple[SourceScan, ...]]:
    rules = _literal_rules(policy)
    findings: list[Finding] = []
    sources: list[SourceScan] = []
    for source, path in inventory.sources.items():
        if source not in inventory.expected_sources or source in missing_sources:
            continue
        source_findings, bytes_scanned = _scan_source(source, path, rules)
        findings.extend(source_findings)
        sources.append(SourceScan(source, bytes_scanned))
    return tuple(findings), tuple(sources)


def _literal_rules(policy: ScanPolicy) -> tuple[Rule, ...]:
    secrets = tuple(
        (f"secret:{name}", "secret", value.encode())
        for name, value in policy.secrets.items()
    )
    hosts = (
        ("host:repository_checkout", "host", policy.repository_checkout.encode()),
        ("host:hostname", "host", policy.hostname.encode()),
    )
    return secrets + hosts


def _scan_source(source: str, path: Path, rules: tuple[Rule, ...]) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    bytes_scanned = 0
    try:
        with path.open("rb") as artifact:
            for line_number, line in enumerate(artifact, start=1):
                bytes_scanned += len(line)
                findings.extend(_scan_line(source, line_number, line, rules))
    except OSError as error:
        raise ArtifactReadError(source) from error
    return findings, bytes_scanned


def _scan_line(source: str, line_number: int, line: bytes, rules: tuple[Rule, ...]) -> list[Finding]:
    findings: list[Finding] = []
    for rule_id, category, literal in rules:
        findings.extend(
            Finding(source, rule_id, category, line_number, offset + 1)
            for offset in _literal_offsets(line, literal)
        )
    findings.extend(
        Finding(source, "host:home_path", "host", line_number, match.start() + 1)
        for match in HOME_PATH.finditer(line)
    )
    return findings


def _literal_offsets(line: bytes, literal: bytes) -> Iterator[int]:
    offset = 0
    while True:
        match = line.find(literal, offset)
        if match < 0:
            return
        yield match
        offset = match + 1
