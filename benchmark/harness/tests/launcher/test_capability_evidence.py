# input:  versioned capability evidence files and registry rows
# output: strict schema, binding, hash, and live-predicate proofs
# pos:    Capability promotion evidence validation tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.capability_evidence import (
    CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    DEEPSEEK_OFFLINE_CONTRACT,
    MUTATION_MANIFEST_SCHEMA_VERSION,
    validate_capability_evidence,
    validate_offline_supporting_artifacts,
)
from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey

KEY = CredentialCapabilityKey("pi", "deepseek", "openai-completions", "api-key")
# The three numbers the run declares per trial. Evidence attests the mechanism that enforces a
# declared envelope, never one run's choice of values, so none of these may appear in it.
NUMERIC_ENVELOPE_FIELDS = ("max_output_tokens", "request_limit_bytes", "response_limit_bytes")
MECHANISM_FIELDS = (
    "adapter_id", "capability_key", "implementation_commit", "pi_version",
    "model_metadata_sha256",
)
UNVERIFIABLE_TREE_IDENTITY_FIELDS = ("pi_tree_sha256",)
HARNESS_DIR = Path(__file__).resolve().parents[2]
EVIDENCE_DIR = HARNESS_DIR / "src/cortex_bench_harness/launcher/evidence"
MIGRATION_SCRIPT = HARNESS_DIR / "scripts/migrate-capability-evidence.py"


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
        "model_metadata_sha256": DEEPSEEK_OFFLINE_CONTRACT["model_metadata_sha256"],
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


def test_validates_the_shipped_deepseek_live_evidence() -> None:
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
    assert evidence["implementation_commit"] == "9c6ebf542d06326cbf8aec20c65ac3eb058c081f"
    assert evidence["request_count"] == 1
    assert evidence["conservative_cost_usd"] == "0.00058086"


@pytest.mark.parametrize("state", ["offline-contract-passed", "live-handshake-passed"])
def test_rejects_old_schema_with_old_or_new_field_shape(
    tmp_path: Path, state: str,
) -> None:
    old_shape = document(state)
    old_shape.update(schema_version="cortex-bench-capability-evidence/1", pi_tree_sha256="0" * 64)
    new_shape = document(state)
    new_shape["schema_version"] = "cortex-bench-capability-evidence/1"
    for name, record, message in (
        ("old-shape", old_shape, "fields"),
        ("new-shape", new_shape, "identity"),
    ):
        file = tmp_path / f"{state}-{name}.json"
        digest = write(file, record)
        with pytest.raises(ValueError, match=message):
            validate_capability_evidence(
                file, digest, capability_id="pi-deepseek-api-key", key=KEY,
                state=state, adapter_id="deepseek-chat-completions/api-key",
            )


def test_committed_migration_reproduces_evidence_and_bound_digests() -> None:
    from cortex_bench_harness.launcher import credential_capabilities as registry

    result = subprocess.run(
        [sys.executable, str(MIGRATION_SCRIPT), "--check"],
        cwd=HARNESS_DIR, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    row = next(row for row in registry.CAPABILITY_REGISTRY.values()
               if row.id == "pi-deepseek-api-key")
    assert report == {
        "ok": True,
        "mode": "check",
        "schema_version": CAPABILITY_EVIDENCE_SCHEMA_VERSION,
        "offline_evidence_sha256": hashlib.sha256(
            (EVIDENCE_DIR / "pi-deepseek-api-key.offline-contract-passed.json").read_bytes()
        ).hexdigest(),
        "registry_evidence_sha256": row.evidence_sha256,
        "supporting_sha256": {
            "model_metadata_sha256": DEEPSEEK_OFFLINE_CONTRACT["model_metadata_sha256"],
            "mutation_manifest_sha256": DEEPSEEK_OFFLINE_CONTRACT[
                "mutation_manifest_sha256"
            ],
        },
    }


def test_migration_refuses_malformed_pinned_records(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location("capability_evidence_migration", MIGRATION_SCRIPT)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    malformed = json.loads(migration.MIGRATION_PATH.read_bytes())
    malformed["records"] = None
    migration.MIGRATION_PATH = tmp_path / "malformed.json"
    migration.MIGRATION_PATH.write_text(json.dumps(malformed), encoding="utf-8")
    with pytest.raises(ValueError, match="records"):
        migration.migrate(write=False)


def test_deepseek_offline_evidence_requires_exact_runtime_contract(tmp_path: Path) -> None:
    mutations = [
        ("pi_version", "0.82.2"),
        ("model_metadata_sha256", "0" * 64),
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


def test_shipped_offline_evidence_resolves_immutable_supporting_artifacts() -> None:
    import cortex_bench_harness.launcher.credential_capabilities as registry

    key = next(key for key, row in registry.CAPABILITY_REGISTRY.items()
               if row.id == "pi-deepseek-api-key")
    path = registry._evidence_path("pi-deepseek-api-key", "offline-contract-passed")
    evidence = validate_capability_evidence(
        path, hashlib.sha256(path.read_bytes()).hexdigest(),
        capability_id="pi-deepseek-api-key", key=key,
        state="offline-contract-passed", adapter_id="deepseek-chat-completions/api-key",
    )
    validate_offline_supporting_artifacts(path.parent, evidence)


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


# --- mechanism-only evidence ---------------------------------------------------------------------


@pytest.mark.parametrize("state", ["offline-contract-passed", "live-handshake-passed"])
def test_shipped_evidence_attests_mechanism_and_carries_no_declared_envelope(state: str) -> None:
    shipped = json.loads((EVIDENCE_DIR / f"pi-deepseek-api-key.{state}.json").read_bytes())
    assert [field for field in NUMERIC_ENVELOPE_FIELDS if field in shipped] == []
    assert [field for field in UNVERIFIABLE_TREE_IDENTITY_FIELDS if field in shipped] == []
    assert all(shipped[field] for field in MECHANISM_FIELDS)
    assert shipped["capability_key"]["proxy_adapter_version"] == "cortex-bench-trial-proxy/2"


@pytest.mark.parametrize("state", ["offline-contract-passed", "live-handshake-passed"])
@pytest.mark.parametrize("field", UNVERIFIABLE_TREE_IDENTITY_FIELDS)
def test_evidence_carrying_an_unverifiable_tree_identity_is_refused(
    tmp_path: Path, state: str, field: str,
) -> None:
    record = document(state)
    record[field] = "0" * 64
    file = tmp_path / f"{state}-{field}.json"
    digest = write(file, record)
    with pytest.raises(ValueError, match="fields"):
        validate_capability_evidence(
            file, digest, capability_id="pi-deepseek-api-key", key=KEY,
            state=state, adapter_id="deepseek-chat-completions/api-key",
        )


@pytest.mark.parametrize("state", ["offline-contract-passed", "live-handshake-passed"])
@pytest.mark.parametrize("field", NUMERIC_ENVELOPE_FIELDS)
def test_evidence_carrying_a_declared_envelope_number_is_refused(
    tmp_path: Path, state: str, field: str,
) -> None:
    record = document(state)
    record[field] = 256
    file = tmp_path / f"{state}-{field}.json"
    digest = write(file, record)
    with pytest.raises(ValueError, match="fields"):
        validate_capability_evidence(
            file, digest, capability_id="pi-deepseek-api-key", key=KEY,
            state=state, adapter_id="deepseek-chat-completions/api-key",
        )


# --- mutation manifest ---------------------------------------------------------------------------


def manifest(**overrides: object) -> dict[str, object]:
    return {
        "schema_version": MUTATION_MANIFEST_SCHEMA_VERSION,
        "implementation_commit": DEEPSEEK_OFFLINE_CONTRACT["implementation_commit"],
        "mutations": [
            {
                "id": 1, "name": "route_path", "file": "proxy/adapters/deepseek.py",
                "test_file": "tests/proxy/test_deepseek_adapter.py",
                "test_selector": "admits_only_exact", "mutation_sha256": "a" * 64,
                "killed": True, "return_code": 1,
            },
            {
                "id": 2, "name": "cap_value", "file": "proxy/adapters/deepseek.py",
                "test_file": "tests/proxy/test_deepseek_adapter.py",
                "test_selector": "rejects_model_stream", "mutation_sha256": "b" * 64,
                "killed": True, "return_code": 1,
            },
        ],
        **overrides,
    }


def supporting(directory: Path, manifest_document: dict[str, object], **overrides: object):
    """Write a manifest beside the shipped model metadata and return the evidence naming it."""
    payload = json.dumps(manifest_document, sort_keys=True, separators=(",", ":")).encode()
    (directory / "pi-deepseek-api-key.mutation-manifest.json").write_bytes(payload)
    (directory / "pi-deepseek-api-key.model-metadata.json").write_bytes(
        (EVIDENCE_DIR / "pi-deepseek-api-key.model-metadata.json").read_bytes())
    evidence = document()
    evidence["mutation_manifest_sha256"] = hashlib.sha256(payload).hexdigest()
    evidence["mutations_total"] = evidence["mutations_killed"] = 2
    evidence.update(overrides)
    return evidence


def test_shipped_mutation_manifest_kills_every_listed_mutation() -> None:
    shipped = json.loads(
        (EVIDENCE_DIR / "pi-deepseek-api-key.mutation-manifest.json").read_bytes())
    evidence = json.loads(
        (EVIDENCE_DIR / "pi-deepseek-api-key.offline-contract-passed.json").read_bytes())
    mutations = shipped["mutations"]
    assert [mutation["id"] for mutation in mutations] == list(range(1, len(mutations) + 1))
    assert all(mutation["killed"] is True for mutation in mutations)
    assert all(mutation["return_code"] != 0 for mutation in mutations)
    assert len(mutations) == evidence["mutations_total"] == evidence["mutations_killed"]
    assert shipped["implementation_commit"] == evidence["implementation_commit"]


def test_accepts_an_internally_valid_supporting_manifest(tmp_path: Path) -> None:
    validate_offline_supporting_artifacts(tmp_path, supporting(tmp_path, manifest()))


def test_refuses_a_manifest_whose_counts_kills_or_binding_do_not_hold(tmp_path: Path) -> None:
    surviving = manifest()
    surviving["mutations"][1]["killed"] = False  # type: ignore[index]
    unproven = manifest()
    unproven["mutations"][1]["return_code"] = 0  # type: ignore[index]
    duplicated = manifest()
    duplicated["mutations"][1]["id"] = 1  # type: ignore[index]
    unhashed = manifest()
    unhashed["mutations"][1]["mutation_sha256"] = "not-a-digest"  # type: ignore[index]
    widened = manifest()
    widened["mutations"][1]["extra"] = "drift"  # type: ignore[index]
    cases = (
        (manifest(schema_version="cortex-bench-mutation-manifest/0"), {}, "schema"),
        (manifest(implementation_commit="0" * 40), {}, "implementation_commit"),
        (surviving, {}, "was not killed"),
        (unproven, {}, "return_code"),
        (duplicated, {}, "ids must be"),
        (unhashed, {}, "mutation_sha256"),
        (widened, {}, "fields"),
        (manifest(), {"mutations_total": 3, "mutations_killed": 3}, "mutations_total"),
    )
    for index, (manifest_document, overrides, message) in enumerate(cases):
        directory = tmp_path / str(index)
        directory.mkdir()
        evidence = supporting(directory, manifest_document, **overrides)
        with pytest.raises(ValueError, match=message):
            validate_offline_supporting_artifacts(directory, evidence)
