import json
import re
from dataclasses import replace
from pathlib import Path

import pytest

from cortex_bench_harness.launcher import credential_capabilities
from cortex_bench_harness.launcher.credential_capabilities import (
    CAPABILITY_REGISTRY,
    project_credential_capabilities,
)

SECRET_VALUE = re.compile(
    r"(?:sk-(?:ant|proj)-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|"
    r"Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)


def test_deepseek_promotion_requires_bound_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = dict(CAPABILITY_REGISTRY)
    key = next(key for key, row in rows.items() if row.id == "pi-deepseek-api-key")
    rows[key] = replace(rows[key], state="offline-contract-passed", evidence_sha256=None)
    monkeypatch.setattr(credential_capabilities, "CAPABILITY_REGISTRY", rows)

    with pytest.raises(ValueError, match="evidence"):
        credential_capabilities.project_credential_capabilities()


def test_registry_projection_contains_no_credential_shaped_value() -> None:
    projection = project_credential_capabilities()
    encoded = json.dumps(projection, sort_keys=True)

    assert SECRET_VALUE.search(encoded) is None
    assert all(
        set(row) in ({"id", "state", "key"}, {"id", "state", "key", "evidence_sha256"})
        and set(row["key"]) == {
            "runner_or_backend", "provider", "protocol", "credential_kind",
            "proxy_adapter_version",
        }
        for row in projection
    )


@pytest.mark.parametrize(
    "credentials",
    [Path.home() / ".claude" / ".credentials.json", Path.home() / ".codex" / "auth.json"],
)
def test_projection_never_reads_real_vendor_credentials_files(
    monkeypatch: pytest.MonkeyPatch, credentials: Path,
) -> None:
    original = Path.read_bytes
    reads: list[Path] = []

    def tracked(path: Path) -> bytes:
        assert path != credentials
        reads.append(path)
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", tracked)

    project_credential_capabilities()

    assert reads
