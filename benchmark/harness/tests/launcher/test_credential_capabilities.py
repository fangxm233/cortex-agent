# input:  host credential capability registry
# output: exact row-state and non-secret projection assertions
# pos:    Contract tests for launcher credential capabilities
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import re
from dataclasses import replace
from pathlib import Path

import pytest

from cortex_bench_harness.launcher import credential_capabilities
from cortex_bench_harness.launcher.credential_capabilities import (
    CAPABILITY_REGISTRY,
    CAPABILITY_STATES,
    project_credential_capabilities,
)

EXPECTED_PROJECTION = [
    {
        "id": "claude-api-key",
        "state": "offline-contract-passed",
        "key": {
            "runner_or_backend": "claude",
            "provider": "anthropic",
            "protocol": "anthropic-messages",
            "credential_kind": "api-key-bearer",
            "proxy_adapter_version": "cortex-bench-trial-proxy/2",
        },
    },
    {
        "id": "claude-subscription",
        "state": "live-handshake-passed",
        "key": {
            "runner_or_backend": "claude-code",
            "provider": "anthropic",
            "protocol": "anthropic-messages",
            "credential_kind": "subscription-oauth",
            "proxy_adapter_version": "cortex-bench-trial-proxy/2",
        },
        "evidence_sha256":
            "68c7c62cdd57e3ebc5fdeb395e57eab76fe228ad4c33f7c1633ad5c8c7794987",
    },
    {
        "id": "codex-subscription",
        "state": "live-handshake-passed",
        "key": {
            "runner_or_backend": "codex-cli",
            "provider": "openai-codex",
            "protocol": "openai-codex-responses",
            "credential_kind": "oauth",
            "proxy_adapter_version": "cortex-bench-trial-proxy/2",
        },
        "evidence_sha256":
            "e0184b5fd292a30f6ad102a01739bf6c885a31b907c89305d8f48441ae2f8aa4",
    },
    {
        "id": "pi-api-key",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "pi",
            "provider": "??",
            "protocol": "??",
            "credential_kind": "api-key",
            "proxy_adapter_version": "cortex-bench-trial-proxy/2",
        },
    },
    {
        "id": "pi-deepseek-api-key",
        "state": "live-handshake-passed",
        "key": {
            "runner_or_backend": "pi",
            "provider": "deepseek",
            "protocol": "openai-completions",
            "credential_kind": "api-key",
            "proxy_adapter_version": "cortex-bench-trial-proxy/2",
        },
        "evidence_sha256":
            "f11e82fd0efecfda60490de953f3af39833cda1adce0e2b87e0f078bafa289d5",
    },
    {
        "id": "pi-openai-codex-oauth",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "pi",
            "provider": "openai-codex",
            "protocol": "??",
            "credential_kind": "oauth",
            "proxy_adapter_version": "cortex-bench-trial-proxy/2",
        },
    },
]
SECRET_VALUE = re.compile(
    r"(?:sk-(?:ant|proj)-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|"
    r"Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)


def test_registry_has_the_six_stateful_capability_rows() -> None:
    assert CAPABILITY_STATES == {
        "unsupported", "offline-contract-passed", "live-handshake-passed",
    }
    assert len(CAPABILITY_REGISTRY) == 6
    assert project_credential_capabilities() == EXPECTED_PROJECTION


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
