# input:  host credential capability registry
# output: exact row-state and non-secret projection assertions
# pos:    Contract tests for launcher credential capabilities
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import re
from pathlib import Path

from cortex_bench_harness.launcher.credential_capabilities import (
    CAPABILITY_REGISTRY,
    CAPABILITY_STATES,
    project_credential_capabilities,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
GOLDEN_RUN_CONFIG = REPO_ROOT / "agent-server/tests/benchmark-resolved-run-config.golden.json"
EXPECTED_PROJECTION = [
    {
        "id": "claude-api-key",
        "state": "offline-contract-passed",
        "key": {
            "runner_or_backend": "claude",
            "provider": "anthropic",
            "protocol": "anthropic-messages",
            "credential_kind": "api-key-bearer",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "claude-subscription",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "claude",
            "provider": "anthropic",
            "protocol": "anthropic-messages",
            "credential_kind": "subscription-oauth",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "codex-subscription",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "codex-cli",
            "provider": "openai",
            "protocol": "??",
            "credential_kind": "subscription",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "pi-api-key",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "pi",
            "provider": "??",
            "protocol": "??",
            "credential_kind": "api-key",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
    {
        "id": "pi-openai-codex-oauth",
        "state": "unsupported",
        "key": {
            "runner_or_backend": "pi",
            "provider": "openai-codex",
            "protocol": "??",
            "credential_kind": "oauth",
            "proxy_adapter_version": "cortex-bench-trial-proxy/1",
        },
    },
]
SECRET_VALUE = re.compile(
    r"(?:sk-(?:ant|proj)-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|"
    r"Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)


def test_registry_has_the_five_stateful_capability_rows() -> None:
    assert CAPABILITY_STATES == {
        "unsupported", "offline-contract-passed", "live-handshake-passed",
    }
    assert len(CAPABILITY_REGISTRY) == 5
    assert project_credential_capabilities() == EXPECTED_PROJECTION


def test_compiled_projection_contains_no_credential_shaped_value() -> None:
    projection = project_credential_capabilities()
    compiled = json.loads(GOLDEN_RUN_CONFIG.read_text())
    encoded = json.dumps({"capabilities": projection, "run_config": compiled}, sort_keys=True)

    assert SECRET_VALUE.search(encoded) is None
    assert all(
        set(row) == {"id", "state", "key"}
        and set(row["key"]) == {
            "runner_or_backend", "provider", "protocol", "credential_kind",
            "proxy_adapter_version",
        }
        for row in projection
    )
