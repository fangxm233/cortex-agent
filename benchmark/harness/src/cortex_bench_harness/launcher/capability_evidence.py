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
HEX_LENGTHS = {"implementation_commit": 40, "pi_tree_sha256": 64,
               "model_metadata_sha256": 64}
COMMON_FIELDS = frozenset({
    "schema_version", "capability_id", "state", "capability_key", "adapter_id",
    "implementation_commit", "pi_version", "pi_tree_sha256", "model_metadata_sha256",
    "request_limit_bytes", "response_limit_bytes", "max_output_tokens",
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
    _positive_ints(document, "request_limit_bytes", "response_limit_bytes", "max_output_tokens")
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
