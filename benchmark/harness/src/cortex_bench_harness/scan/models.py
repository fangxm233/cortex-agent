# input:  five artifact paths and configured leak literals
# output: immutable scan policy, findings, and report values
# pos:    Artifact scanner value contracts
# >>> If I am updated, update my header and folder CORTEX.md <<<

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping

SOURCE_NAMES = ("stdout", "stderr", "events", "manifest", "workspace_diff")


@dataclass(frozen=True)
class ArtifactSet:
    stdout: Path
    stderr: Path
    events: Path
    manifest: Path
    workspace_diff: Path

    def items(self) -> tuple[tuple[str, Path], ...]:
        return tuple((name, getattr(self, name)) for name in SOURCE_NAMES)


@dataclass(frozen=True)
class ScanPolicy:
    secrets: Mapping[str, str]
    repository_checkout: str
    hostname: str

    def __post_init__(self) -> None:
        _validate_secrets(self.secrets)
        _validate_literal("repository_checkout", self.repository_checkout)
        _validate_literal("hostname", self.hostname)


@dataclass(frozen=True)
class Finding:
    source: str
    rule_id: str
    category: str
    line: int
    column: int


@dataclass(frozen=True)
class SourceScan:
    source: str
    bytes_scanned: int


@dataclass(frozen=True)
class ScanReport:
    sources: tuple[SourceScan, ...]
    findings: tuple[Finding, ...]

    @property
    def clean(self) -> bool:
        return not self.findings

    @property
    def exit_code(self) -> int:
        return 0 if self.clean else 1

    def as_dict(self) -> dict[str, object]:
        return {
            "ok": self.clean,
            "clean": self.clean,
            "sources": [asdict(source) for source in self.sources],
            "matches": [asdict(finding) for finding in self.findings],
        }


class ArtifactReadError(RuntimeError):
    def __init__(self, source: str) -> None:
        super().__init__(f"unable to read required artifact source: {source}")
        self.source = source


def _validate_secrets(secrets: Mapping[str, str]) -> None:
    if not secrets:
        raise ValueError("secrets must contain at least one named literal")
    for name, value in secrets.items():
        if not isinstance(name, str) or not name:
            raise ValueError("secret rule names must be non-empty strings")
        _validate_literal(f"secret:{name}", value)


def _validate_literal(name: str, value: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    if "\n" in value or "\r" in value:
        raise ValueError(f"{name} must be a single-line literal")
