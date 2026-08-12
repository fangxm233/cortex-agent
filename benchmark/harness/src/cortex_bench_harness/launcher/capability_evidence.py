# input:  capability row, expected digest, versioned JSON evidence
# output: strict promotion-evidence validation or refusal
# pos:    Capability-state provenance validator
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Mapping

from .credential_capabilities import CapabilityState, CredentialCapabilityKey

CAPABILITY_EVIDENCE_SCHEMA_VERSION = "cortex-bench-capability-evidence/1"
MUTATION_MANIFEST_SCHEMA_VERSION = "cortex-bench-mutation-manifest/1"
HEX_LENGTHS = {"implementation_commit": 40, "pi_tree_sha256": 64,
               "model_metadata_sha256": 64}
DEEPSEEK_OFFLINE_CONTRACT = {
    "implementation_commit": "29159ec452b5eefafff4e3cf1cece93748c0df9f",
    "pi_version": "0.82.1",
    "pi_tree_sha256": "2fd2a1a0bbbe8f86a4e54be91fa2fc7dd49fdbdabb3c77c649b2c42b6bf07e1b",
    "model_metadata_sha256": "0dcc807a4e5827b488c6ceac87884ff6e735e01cf4f2ddfec9dd812e6fde041b",
    "mutation_manifest_sha256": "f4e1b94852d7b4cbd7a2a4863c11850e6eeea779bb89410c405b60af501b27c3",
}
# Evidence attests the mechanism, never one run's numbers: `max_output_tokens`,
# `request_limit_bytes` and `response_limit_bytes` are declared per run and recorded in the run's
# own arm-resolution and proxy manifest block, so a numeric change no longer demotes the capability
# while a mechanism change still does.
COMMON_FIELDS = frozenset({
    "schema_version", "capability_id", "state", "capability_key", "adapter_id",
    "implementation_commit", "pi_version", "pi_tree_sha256", "model_metadata_sha256",
})
MUTATION_FIELDS = frozenset({
    "id", "name", "file", "test_file", "test_selector", "mutation_sha256",
    "killed", "return_code",
})
OFFLINE_FIELDS = frozenset({
    "mutation_manifest_sha256", "mutations_total", "mutations_killed",
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
    expected_fields = COMMON_FIELDS | _state_fields(state)
    if set(document) != expected_fields:
        raise ValueError("capability evidence fields differ from strict schema")
    _validate_common(document, capability_id, key, state, adapter_id)
    _validate_state(document, state)
    return document


def validate_offline_supporting_artifacts(
    directory: Path, document: Mapping[str, Any],
) -> None:
    artifacts = {
        "model_metadata_sha256": directory / "pi-deepseek-api-key.model-metadata.json",
        "mutation_manifest_sha256": directory / "pi-deepseek-api-key.mutation-manifest.json",
    }
    for field, path in artifacts.items():
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != document[field]:
            raise ValueError(f"capability evidence {field} supporting artifact mismatch")
    _validate_mutation_manifest(
        _document(artifacts["mutation_manifest_sha256"].read_bytes()), document)


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


def _state_fields(state: CapabilityState) -> frozenset[str]:
    if state == "offline-contract-passed":
        return OFFLINE_FIELDS
    if state == "live-handshake-passed":
        return LIVE_FIELDS
    raise ValueError("unsupported rows carry no promotion evidence")


def _validate_common(
    document: Mapping[str, Any], capability_id: str, key: CredentialCapabilityKey,
    state: CapabilityState, adapter_id: str,
) -> None:
    exact = {
        "schema_version": CAPABILITY_EVIDENCE_SCHEMA_VERSION,
        "capability_id": capability_id, "state": state,
        "capability_key": asdict(key), "adapter_id": adapter_id,
    }
    if any(document.get(field) != value for field, value in exact.items()):
        raise ValueError("capability evidence identity differs from registry")
    for field, length in HEX_LENGTHS.items():
        _hex(document.get(field), field, length)
    if not isinstance(document.get("pi_version"), str) or not document["pi_version"]:
        raise ValueError("capability evidence pi_version must be non-empty")


def _validate_state(document: Mapping[str, Any], state: CapabilityState) -> None:
    if state == "offline-contract-passed":
        _hex(document.get("mutation_manifest_sha256"), "mutation_manifest_sha256", 64)
        _positive_ints(document, "mutations_total", "mutations_killed")
        if document["mutations_total"] != document["mutations_killed"]:
            raise ValueError("capability evidence mutations were not all killed")
        _validate_deepseek_offline_contract(document)
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


def _validate_deepseek_offline_contract(document: Mapping[str, Any]) -> None:
    for field, expected in DEEPSEEK_OFFLINE_CONTRACT.items():
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
