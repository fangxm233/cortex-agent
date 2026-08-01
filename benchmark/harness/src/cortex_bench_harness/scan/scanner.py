# input:  artifact set, scan policy, and binary text streams
# output: complete credential and host-identity scan report
# pos:    Five-source trial artifact scanner
# >>> If I am updated, update my header and folder CORTEX.md <<<

import re
from collections.abc import Iterator
from pathlib import Path

from ..manifest import MANIFEST_FILENAME
from .models import (
    ArtifactReadError,
    ArtifactSet,
    Finding,
    ScanPolicy,
    ScanReport,
    SourceScan,
)

HOME_PATH = re.compile(rb"/home/[^/\x00\s]+")
Rule = tuple[str, str, bytes]


def scan_trial_artifacts(artifacts: ArtifactSet, policy: ScanPolicy) -> ScanReport:
    _validate_artifacts(artifacts)
    rules = _literal_rules(policy)
    findings: list[Finding] = []
    sources: list[SourceScan] = []
    for source, path in artifacts.items():
        source_findings, bytes_scanned = _scan_source(source, path, rules)
        findings.extend(source_findings)
        sources.append(SourceScan(source, bytes_scanned))
    return ScanReport(tuple(sources), tuple(findings))


def _validate_artifacts(artifacts: ArtifactSet) -> None:
    if artifacts.manifest.name != MANIFEST_FILENAME:
        raise ValueError(f"manifest source must be named {MANIFEST_FILENAME}")


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
