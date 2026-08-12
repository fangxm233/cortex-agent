# input:  versioned capability evidence files and registry rows
# output: strict schema, binding, hash, and live-predicate proofs
# pos:    Capability promotion evidence validation tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.capability_evidence import (
    CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    DEEPSEEK_OFFLINE_CONTRACT,
    validate_capability_evidence,
)
from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey

KEY = CredentialCapabilityKey("pi", "deepseek", "openai-completions", "api-key")


def document(state: str = "offline-contract-passed") -> dict[str, object]:
    common = {
        "schema_version": CAPABILITY_EVIDENCE_SCHEMA_VERSION,
        "capability_id": "pi-deepseek-api-key", "state": state,
        "capability_key": {
            "runner_or_backend": "pi", "provider": "deepseek",
            "protocol": "openai-completions", "credential_kind": "api-key",
            "proxy_adapter_version": "cortex-bench-trial-proxy/2",
        },
        "adapter_id": "deepseek-chat-completions/api-key",
        "implementation_commit": DEEPSEEK_OFFLINE_CONTRACT["implementation_commit"],
        "pi_version": DEEPSEEK_OFFLINE_CONTRACT["pi_version"],
        "pi_tree_sha256": DEEPSEEK_OFFLINE_CONTRACT["pi_tree_sha256"],
        "model_metadata_sha256": DEEPSEEK_OFFLINE_CONTRACT["model_metadata_sha256"],
        "request_limit_bytes": DEEPSEEK_OFFLINE_CONTRACT["request_limit_bytes"],
        "response_limit_bytes": DEEPSEEK_OFFLINE_CONTRACT["response_limit_bytes"],
        "max_output_tokens": DEEPSEEK_OFFLINE_CONTRACT["max_output_tokens"],
    }
    if state == "offline-contract-passed":
        common.update(
            mutation_manifest_sha256=DEEPSEEK_OFFLINE_CONTRACT["mutation_manifest_sha256"],
            mutations_total=20, mutations_killed=20,
        )
    else:
        common.update(
            run_config_sha256="d" * 64, request_sha256="e" * 64,
            request_count=1, input_tokens=9, output_tokens=2,
            conservative_cost_usd="0.00000182", scan_clean=True,
            revocation_proven=True, upstream_identity="127.0.0.1:9880/m/deepseek/deepseek",
        )
    return common


def write(path: Path, value: dict[str, object]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def test_validates_strict_offline_evidence_and_hash(tmp_path: Path) -> None:
    file = tmp_path / "offline.json"
    digest = write(file, document())
    assert validate_capability_evidence(
        file, digest, capability_id="pi-deepseek-api-key", key=KEY,
        state="offline-contract-passed", adapter_id="deepseek-chat-completions/api-key",
    )["mutations_killed"] == 20


def test_validates_the_shipped_deepseek_offline_evidence() -> None:
    import cortex_bench_harness.launcher.credential_capabilities as registry

    key = next(key for key, row in registry.CAPABILITY_REGISTRY.items()
               if row.id == "pi-deepseek-api-key")
    row = registry.CAPABILITY_REGISTRY[key]
    assert row.evidence_sha256 is not None
    evidence = validate_capability_evidence(
        registry._evidence_path(row.id, row.state), row.evidence_sha256,
        capability_id=row.id, key=key, state=row.state,
        adapter_id="deepseek-chat-completions/api-key",
    )
    assert evidence["mutations_total"] == evidence["mutations_killed"] == 29


def test_deepseek_offline_evidence_requires_exact_runtime_contract(tmp_path: Path) -> None:
    mutations = [
        ("pi_version", "0.82.2"),
        ("request_limit_bytes", 65535),
        ("response_limit_bytes", 1048575),
        ("max_output_tokens", 257),
        ("model_metadata_sha256", "0" * 64),
        ("pi_tree_sha256", "0" * 64),
        ("mutation_manifest_sha256", "0" * 64),
        ("implementation_commit", "0" * 40),
    ]
    for field, value in mutations:
        record = document()
        record[field] = value
        file = tmp_path / f"{field}.json"
        digest = write(file, record)
        with pytest.raises(ValueError, match=field):
            validate_capability_evidence(
                file, digest, capability_id="pi-deepseek-api-key", key=KEY,
                state="offline-contract-passed", adapter_id="deepseek-chat-completions/api-key",
            )


def test_rejects_unknown_fields_key_drift_and_hash_drift(tmp_path: Path) -> None:
    value = document()
    value["unknown"] = "drift"
    file = tmp_path / "bad.json"
    digest = write(file, value)
    with pytest.raises(ValueError, match="fields"):
        validate_capability_evidence(
            file, digest, capability_id="pi-deepseek-api-key", key=KEY,
            state="offline-contract-passed", adapter_id="deepseek-chat-completions/api-key",
        )
    with pytest.raises(ValueError, match="sha256"):
        validate_capability_evidence(
            file, "0" * 64, capability_id="pi-deepseek-api-key", key=KEY,
            state="offline-contract-passed", adapter_id="deepseek-chat-completions/api-key",
        )


def test_live_evidence_requires_one_request_clean_scan_and_revocation(tmp_path: Path) -> None:
    for field, value in (("request_count", 2), ("scan_clean", False),
                         ("revocation_proven", False)):
        record = document("live-handshake-passed")
        record[field] = value
        file = tmp_path / f"{field}.json"
        digest = write(file, record)
        with pytest.raises(ValueError, match=field):
            validate_capability_evidence(
                file, digest, capability_id="pi-deepseek-api-key", key=KEY,
                state="live-handshake-passed", adapter_id="deepseek-chat-completions/api-key",
            )
