# input:  capability row, bound evidence, committed proof sources
# output: strict promotion-evidence validation or refusal
# pos:    Capability-state provenance validator
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

from .credential_capabilities import CapabilityState, CredentialCapabilityKey

# Removing a field changes compatibility even when all remaining claims retain their meaning.
# Schema /2 is therefore a breaking field-set migration: /1 documents are never accepted as /2.
CAPABILITY_EVIDENCE_SCHEMA_VERSION = "cortex-bench-capability-evidence/2"
MUTATION_MANIFEST_SCHEMA_VERSION = "cortex-bench-mutation-manifest/1"
SYNTHETIC_OBSERVATION_SCHEMA_VERSION = "cortex-bench-synthetic-capability-observation/1"
DEEPSEEK_OFFLINE_CONTRACT = {
    "implementation_commit": "29159ec452b5eefafff4e3cf1cece93748c0df9f",
    "pi_version": "0.82.1",
    "model_metadata_sha256": "0dcc807a4e5827b488c6ceac87884ff6e735e01cf4f2ddfec9dd812e6fde041b",
    "mutation_manifest_sha256": "f4e1b94852d7b4cbd7a2a4863c11850e6eeea779bb89410c405b60af501b27c3",
}
CLAUDE_OFFLINE_CONTRACT = {
    "claude_code_version": "2.1.232",
}
CODEX_OFFLINE_CONTRACT = {
    "implementation_commit": "d8a15809c097f0267aba48715cd59cbd976b5c89",
    "codex_cli_version": "0.117.0",
    "p0_wire_capture_sha256":
        "6e7afca2e767ac7c4c12a8a2fa735cdaf00461d09178369fc8b7dd63df6c7eda",
    "vendor_lifecycle_test_sha256":
        "d33fa9b686cb9776b72221337ae9cb26aa00a17939152d67ece5a1305ee47880",
    "model_freeze_test_sha256":
        "bda9873f7f64a291fde565ee20d8094e5f85c212e56869cf552880ad1adf74c7",
}
CLAUDE_P0_CAPTURE_SHA256 = "fcc17df7ff3e2d7e618856e11479a315b72c7dcdfa85984e45c6f2564eccda45"
CLAUDE_P0_BETA_HEADER = (
    "claude-code-20250219,interleaved-thinking-2025-05-14,"
    "thinking-token-count-2026-05-13,context-management-2025-06-27,"
    "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,"
    "effort-2025-11-24"
)


@dataclass(frozen=True)
class CapabilityEvidenceMetadata:
    adapter_id: str
    metadata_fields: frozenset[str]
    offline_fields: frozenset[str]
    text_fields: frozenset[str]
    hex_fields: Mapping[str, int]
    offline_contract: Mapping[str, object]
    supporting_artifacts: Mapping[str, str]
    offline_proof: str


CAPABILITY_EVIDENCE_METADATA: Mapping[str, CapabilityEvidenceMetadata] = MappingProxyType({
    "pi-deepseek-api-key": CapabilityEvidenceMetadata(
        adapter_id="deepseek-chat-completions/api-key",
        metadata_fields=frozenset({"pi_version", "model_metadata_sha256"}),
        offline_fields=frozenset({
            "mutation_manifest_sha256", "mutations_total", "mutations_killed",
        }),
        text_fields=frozenset({"pi_version"}),
        hex_fields=MappingProxyType({"model_metadata_sha256": 64}),
        offline_contract=MappingProxyType(DEEPSEEK_OFFLINE_CONTRACT),
        supporting_artifacts=MappingProxyType({
            "model_metadata_sha256": "pi-deepseek-api-key.model-metadata.json",
            "mutation_manifest_sha256": "pi-deepseek-api-key.mutation-manifest.json",
        }),
        offline_proof="mutation-manifest",
    ),
    "claude-subscription": CapabilityEvidenceMetadata(
        adapter_id="anthropic-messages/subscription-oauth",
        metadata_fields=frozenset({"claude_code_version"}),
        offline_fields=frozenset({"synthetic_observation_sha256"}),
        text_fields=frozenset({"claude_code_version"}),
        hex_fields=MappingProxyType({}),
        offline_contract=MappingProxyType(CLAUDE_OFFLINE_CONTRACT),
        supporting_artifacts=MappingProxyType({
            "synthetic_observation_sha256": "claude-subscription.synthetic-observation.json",
        }),
        offline_proof="synthetic-observation",
    ),
    "codex-subscription": CapabilityEvidenceMetadata(
        adapter_id="openai-codex-responses/oauth",
        metadata_fields=frozenset({"codex_cli_version"}),
        offline_fields=frozenset({
            "p0_wire_capture_sha256", "vendor_lifecycle_test_sha256",
            "model_freeze_test_sha256",
        }),
        text_fields=frozenset({"codex_cli_version"}),
        hex_fields=MappingProxyType({
            "p0_wire_capture_sha256": 64,
            "vendor_lifecycle_test_sha256": 64,
            "model_freeze_test_sha256": 64,
        }),
        offline_contract=MappingProxyType(CODEX_OFFLINE_CONTRACT),
        supporting_artifacts=MappingProxyType({}),
        offline_proof="committed-source-suite",
    ),
})
# Evidence attests only independently auditable claims. The historical `pi_tree_sha256` had no
# committed canonical producer, so version checks remain while that unverifiable digest is refused.
# Run envelope numbers are recorded in each campaign arm and proxy manifest instead.
IDENTITY_FIELDS = frozenset({
    "schema_version", "capability_id", "state", "capability_key", "adapter_id",
    "implementation_commit",
})
MUTATION_FIELDS = frozenset({
    "id", "name", "file", "test_file", "test_selector", "mutation_sha256",
    "killed", "return_code",
})
LIVE_FIELDS = frozenset({
    "run_config_sha256", "request_sha256", "request_count", "input_tokens",
    "output_tokens", "conservative_cost_usd", "scan_clean", "revocation_proven",
    "upstream_identity",
})


def validate_capability_evidence(
    path: Path, expected_sha256: str, *, capability_id: str,
    key: CredentialCapabilityKey, state: CapabilityState, adapter_id: str,
) -> dict[str, object]:
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise ValueError("capability evidence sha256 mismatch")
    document = _document(payload)
    metadata = _capability_metadata(capability_id)
    expected_fields = (
        IDENTITY_FIELDS | metadata.metadata_fields | _state_fields(state, metadata)
    )
    if set(document) != expected_fields:
        raise ValueError("capability evidence fields differ from strict schema")
    if adapter_id != metadata.adapter_id:
        raise ValueError("capability evidence adapter differs from capability metadata")
    _validate_common(document, capability_id, key, state, adapter_id, metadata)
    _validate_state(document, state, metadata)
    return document


def validate_offline_supporting_artifacts(
    directory: Path, document: Mapping[str, Any],
) -> None:
    capability_id = document.get("capability_id")
    if not isinstance(capability_id, str):
        raise ValueError("capability evidence capability_id must be text")
    metadata = _capability_metadata(capability_id)
    artifacts = {
        field: directory / filename
        for field, filename in metadata.supporting_artifacts.items()
    }
    for field, path in artifacts.items():
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != document[field]:
            raise ValueError(f"capability evidence {field} supporting artifact mismatch")
    if metadata.offline_proof == "mutation-manifest":
        _validate_mutation_manifest(
            _document(artifacts["mutation_manifest_sha256"].read_bytes()), document)
        return
    if metadata.offline_proof == "synthetic-observation":
        _validate_synthetic_observation(
            _document(artifacts["synthetic_observation_sha256"].read_bytes()), document)
        return
    if metadata.offline_proof != "committed-source-suite":
        raise ValueError(f"unknown offline proof kind {metadata.offline_proof!r}")


def _validate_synthetic_observation(
    observation: Mapping[str, Any], evidence: Mapping[str, Any],
) -> None:
    expected = {
        "schema_version": SYNTHETIC_OBSERVATION_SCHEMA_VERSION,
        "source_capture_sha256": CLAUDE_P0_CAPTURE_SHA256,
        "claude_code_version": evidence["claude_code_version"],
        "request": {
            "method": "POST", "target": "/v1/messages?beta=true",
            "model": "claude-sonnet-5",
            "retained_headers": {
                "anthropic-beta": CLAUDE_P0_BETA_HEADER,
                "anthropic-version": "2023-06-01",
            },
        },
        "proxy_observation": {
            "adapter_received_no_container_auth": True,
            "proxy_admitted_trial_dummy": True,
            "upstream_received_host_bearer": True,
            "upstream_received_trial_dummy": False,
        },
    }
    if observation != expected:
        raise ValueError("Claude synthetic observation differs from the frozen P0 contract")


def _validate_mutation_manifest(
    manifest: Mapping[str, Any], document: Mapping[str, Any],
) -> None:
    """The manifest the evidence names must itself be a complete kill record.

    The evidence's `mutations_total`/`mutations_killed` pair is only a summary; without this the
    pair could claim a kill count the listed mutations never demonstrate.
    """
    if manifest.get("schema_version") != MUTATION_MANIFEST_SCHEMA_VERSION:
        raise ValueError(
            f"mutation manifest schema_version must be {MUTATION_MANIFEST_SCHEMA_VERSION}")
    if manifest.get("implementation_commit") != document["implementation_commit"]:
        raise ValueError(
            "mutation manifest implementation_commit differs from the evidence it supports")
    mutations = manifest.get("mutations")
    if not isinstance(mutations, list) or not mutations:
        raise ValueError("mutation manifest must list its mutations")
    if len(mutations) != document["mutations_total"]:
        raise ValueError(
            f"mutation manifest lists {len(mutations)} mutations; evidence declares "
            f"mutations_total {document['mutations_total']}")
    for index, mutation in enumerate(mutations, start=1):
        _validate_mutation(mutation, index)
    killed = [mutation for mutation in mutations if mutation["killed"] is True]
    if len(killed) != document["mutations_killed"]:
        raise ValueError(
            f"mutation manifest kills {len(killed)} mutations; evidence declares "
            f"mutations_killed {document['mutations_killed']}")


def _validate_mutation(mutation: Any, expected_id: int) -> None:
    if not isinstance(mutation, dict) or set(mutation) != MUTATION_FIELDS:
        raise ValueError(f"mutation {expected_id} fields differ from the strict schema")
    if mutation["id"] != expected_id:
        raise ValueError(
            f"mutation ids must be 1..n in order; found id {mutation['id']!r} at position "
            f"{expected_id}")
    for field in ("name", "file", "test_file", "test_selector"):
        if not isinstance(mutation[field], str) or not mutation[field]:
            raise ValueError(f"mutation {expected_id} {field} must be non-empty text")
    _hex(mutation["mutation_sha256"], f"mutation {expected_id} mutation_sha256", 64)
    if mutation["killed"] is not True:
        raise ValueError(f"mutation {expected_id} was not killed")
    return_code = mutation["return_code"]
    if not isinstance(return_code, int) or isinstance(return_code, bool) or return_code == 0:
        raise ValueError(
            f"mutation {expected_id} return_code must be the non-zero exit of its killing test")


def _document(payload: bytes) -> dict[str, object]:
    try:
        value = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("capability evidence is not JSON") from error
    if not isinstance(value, dict):
        raise ValueError("capability evidence must be an object")
    return value


def _capability_metadata(capability_id: str) -> CapabilityEvidenceMetadata:
    metadata = CAPABILITY_EVIDENCE_METADATA.get(capability_id)
    if metadata is None:
        raise ValueError(f"no evidence metadata is declared for capability {capability_id!r}")
    return metadata


def _state_fields(
    state: CapabilityState, metadata: CapabilityEvidenceMetadata,
) -> frozenset[str]:
    if state == "offline-contract-passed":
        return metadata.offline_fields
    if state == "live-handshake-passed":
        return LIVE_FIELDS
    raise ValueError("unsupported rows carry no promotion evidence")


def _validate_common(
    document: Mapping[str, Any], capability_id: str, key: CredentialCapabilityKey,
    state: CapabilityState, adapter_id: str, metadata: CapabilityEvidenceMetadata,
) -> None:
    exact = {
        "schema_version": CAPABILITY_EVIDENCE_SCHEMA_VERSION,
        "capability_id": capability_id, "state": state,
        "capability_key": asdict(key), "adapter_id": adapter_id,
    }
    if any(document.get(field) != value for field, value in exact.items()):
        raise ValueError("capability evidence identity differs from registry")
    _hex(document.get("implementation_commit"), "implementation_commit", 40)
    for field, length in metadata.hex_fields.items():
        # Some hashes prove only the offline state. The strict state schema above requires them
        # there and excludes them from live evidence, so common validation must not re-require
        # an inapplicable offline field after a successful handshake.
        if field in document:
            _hex(document[field], field, length)
    for field in metadata.text_fields:
        if not isinstance(document.get(field), str) or not document[field]:
            raise ValueError(f"capability evidence {field} must be non-empty")


def _validate_state(
    document: Mapping[str, Any], state: CapabilityState,
    metadata: CapabilityEvidenceMetadata,
) -> None:
    if state == "offline-contract-passed":
        _validate_offline_contract(document, metadata)
        if metadata.offline_proof == "synthetic-observation":
            _hex(document.get("synthetic_observation_sha256"),
                 "synthetic_observation_sha256", 64)
            return
        if metadata.offline_proof == "committed-source-suite":
            return
        if metadata.offline_proof != "mutation-manifest":
            raise ValueError(f"unknown offline proof kind {metadata.offline_proof!r}")
        _hex(document.get("mutation_manifest_sha256"), "mutation_manifest_sha256", 64)
        _positive_ints(document, "mutations_total", "mutations_killed")
        if document["mutations_total"] != document["mutations_killed"]:
            raise ValueError("capability evidence mutations were not all killed")
        return
    _hex(document.get("run_config_sha256"), "run_config_sha256", 64)
    _hex(document.get("request_sha256"), "request_sha256", 64)
    _positive_ints(document, "request_count")
    _nonnegative_ints(document, "input_tokens", "output_tokens")
    for field in ("scan_clean", "revocation_proven"):
        if document.get(field) is not True:
            raise ValueError(f"capability evidence {field} must be true")
    if document["request_count"] != 1:
        raise ValueError("capability evidence request_count must be one")
    if not isinstance(document.get("upstream_identity"), str):
        raise ValueError("capability evidence upstream_identity must be text")


def _validate_offline_contract(
    document: Mapping[str, Any], metadata: CapabilityEvidenceMetadata,
) -> None:
    for field, expected in metadata.offline_contract.items():
        if document.get(field) != expected:
            raise ValueError(f"capability evidence {field} differs from frozen contract")


def _positive_ints(document: Mapping[str, Any], *fields: str) -> None:
    for field in fields:
        value = document.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"capability evidence {field} must be positive")


def _nonnegative_ints(document: Mapping[str, Any], *fields: str) -> None:
    for field in fields:
        value = document.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError(f"capability evidence {field} must be nonnegative")


def _hex(value: object, field: str, length: int) -> None:
    if not isinstance(value, str) or len(value) != length:
        raise ValueError(f"capability evidence {field} is not a {length}-digit hex value")
    try:
        int(value, 16)
    except ValueError as error:
        raise ValueError(f"capability evidence {field} is not hexadecimal") from error
