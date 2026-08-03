# input:  named artifact inventory, scan policy, and binary streams
# output: closed-inventory credential and host-identity scan report
# pos:    Trial artifact inventory scanner
# >>> If I am updated, update my header and folder CORTEX.md <<<

import os
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
    _validate_inventory(inventory, policy)
    missing_sources = _missing_sources(inventory)
    unclassified_files = _unclassified_files(inventory, policy, missing_sources)
    findings, sources = _scan_present_sources(inventory, missing_sources, policy)
    return ScanReport(
        sources, findings, missing_sources, unclassified_files,
    )


def _validate_inventory(inventory: ArtifactInventory, policy: ScanPolicy) -> None:
    _validate_inventory_shape(inventory)
    _validate_source_roots(inventory)
    _validate_source_names(inventory, policy)
    manifest = inventory.sources.get("manifest")
    if manifest is not None and manifest.name != MANIFEST_FILENAME:
        raise ValueError(f"manifest source must be named {MANIFEST_FILENAME}")


def _validate_inventory_shape(inventory: ArtifactInventory) -> None:
    if not inventory.expected_sources:
        raise ValueError("artifact inventory requires an expected source")
    if not inventory.trial_roots:
        raise ValueError("artifact inventory requires a trial root")


def _validate_source_roots(inventory: ArtifactInventory) -> None:
    roots = tuple(_normalized_path(root) for root in inventory.trial_roots)
    outside_root = any(
        not any(_normalized_path(path).is_relative_to(root) for root in roots)
        for path in inventory.sources.values()
    )
    if outside_root:
        raise ValueError("artifact sources must be contained by trial roots")


def _normalized_path(path: Path) -> Path:
    return Path(os.path.abspath(path))


def _validate_source_names(inventory: ArtifactInventory, policy: ScanPolicy) -> None:
    names = set(inventory.sources) | inventory.expected_sources
    literals = (*policy.secrets.values(), policy.repository_checkout, policy.hostname)
    if any(_contains_sensitive(name, literals) for name in names):
        raise ValueError("artifact source names must not contain sensitive literals")


def _contains_sensitive(value: str, literals: tuple[str, ...]) -> bool:
    return (
        any(literal in value for literal in literals)
        or HOME_PATH.search(value.encode()) is not None
    )


def _missing_sources(inventory: ArtifactInventory) -> tuple[str, ...]:
    return tuple(sorted(
        source for source in inventory.expected_sources
        if source not in inventory.sources or not inventory.sources[source].is_file()
    ))


def _unclassified_files(
    inventory: ArtifactInventory,
    policy: ScanPolicy,
    missing_sources: tuple[str, ...],
) -> tuple[UnclassifiedFile, ...]:
    classified = {
        _normalized_path(path) for source, path in inventory.sources.items()
        if source in inventory.expected_sources and path.is_file()
    }
    redactions = (
        *policy.secrets.values(), policy.repository_checkout, policy.hostname,
    )
    discovered: set[Path] = set()
    unclassified: list[UnclassifiedFile] = []
    for root_index, root in enumerate(inventory.trial_roots):
        missing_source = _missing_source_for_root(inventory, missing_sources, root)
        _append_unclassified(
            root, root_index, classified, discovered, unclassified, redactions,
            missing_source,
        )
    return tuple(unclassified)


def _missing_source_for_root(
    inventory: ArtifactInventory,
    missing_sources: tuple[str, ...],
    root: Path,
) -> str | None:
    absolute_root = _normalized_path(root)
    return next((
        source for source in missing_sources
        if source in inventory.sources
        and _normalized_path(inventory.sources[source]).is_relative_to(absolute_root)
    ), None)


def _append_unclassified(
    root: Path,
    root_index: int,
    classified: set[Path],
    discovered: set[Path],
    unclassified: list[UnclassifiedFile],
    redactions: tuple[str, ...],
    missing_source: str | None,
) -> None:
    for path in _root_candidates(root, root_index, missing_source):
        absolute = _normalized_path(path)
        if absolute in classified or absolute in discovered:
            continue
        discovered.add(absolute)
        relative_path = path.relative_to(root).as_posix()
        reported_path = (
            None if _contains_sensitive(relative_path, redactions) else relative_path
        )
        unclassified.append(UnclassifiedFile(root_index, reported_path))


def _root_candidates(
    root: Path, root_index: int, missing_source: str | None,
) -> tuple[Path, ...]:
    error_source = missing_source or f"trial_root:{root_index}"
    if not root.is_dir():
        raise ArtifactReadError(error_source)
    candidates: list[Path] = []
    try:
        for directory, dirnames, filenames in root.walk(on_error=_raise_walk_error):
            dirnames.sort()
            candidates.extend(directory / name for name in filenames)
    except OSError as error:
        raise ArtifactReadError(error_source) from error
    return tuple(sorted(candidates))


def _raise_walk_error(error: OSError) -> None:
    raise error


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
