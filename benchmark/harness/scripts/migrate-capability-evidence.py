#!/usr/bin/env python3
# input:  pinned v1 evidence documents and supporting artifacts
# output: canonical v2 evidence bytes and reproducibility digests
# pos:    Capability evidence field-set migration command
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

HARNESS = Path(__file__).resolve().parents[1]
EVIDENCE = HARNESS / "src/cortex_bench_harness/launcher/evidence"
MIGRATION_PATH = Path(__file__).with_name("capability-evidence-v1-to-v2.json")
MIGRATION_SCHEMA = "cortex-bench-capability-evidence-field-migration/1"
RECORD_STATES = ("offline-contract-passed", "live-handshake-passed")
SUPPORTING_PATHS = {
    "model_metadata_sha256": EVIDENCE / "pi-deepseek-api-key.model-metadata.json",
    "mutation_manifest_sha256": EVIDENCE / "pi-deepseek-api-key.mutation-manifest.json",
}


def canonical(document: object) -> bytes:
    return json.dumps(document, sort_keys=True, separators=(",", ":")).encode()


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def load_migration() -> dict[str, Any]:
    value = json.loads(MIGRATION_PATH.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("migration input must be a JSON object")
    expected = {
        "schema_version", "source_schema_version", "target_schema_version",
        "removed_fields", "supporting_sha256", "records",
    }
    if set(value) != expected or value["schema_version"] != MIGRATION_SCHEMA:
        raise ValueError("migration input fields or schema_version differ from the strict schema")
    if value["removed_fields"] != ["pi_tree_sha256"]:
        raise ValueError("migration removed_fields must be exactly ['pi_tree_sha256']")
    return value


def verify_supporting(migration: dict[str, Any]) -> dict[str, str]:
    expected = migration["supporting_sha256"]
    if not isinstance(expected, dict) or set(expected) != set(SUPPORTING_PATHS):
        raise ValueError("migration supporting_sha256 fields differ from the strict schema")
    actual = {field: digest(path.read_bytes()) for field, path in SUPPORTING_PATHS.items()}
    if actual != expected:
        raise ValueError("migration supporting artifact digest mismatch")
    return actual


def migrate_record(
    migration: dict[str, Any], state: str,
) -> tuple[Path, bytes, str]:
    record = migration["records"].get(state)
    if not isinstance(record, dict) or set(record) != {"source_sha256", "document"}:
        raise ValueError(f"migration {state} record differs from the strict schema")
    document = record["document"]
    if not isinstance(document, dict) or document.get("state") != state:
        raise ValueError(f"migration {state} document identity mismatch")
    if digest(canonical(document)) != record["source_sha256"]:
        raise ValueError(f"migration {state} source_sha256 mismatch")
    if document.get("schema_version") != migration["source_schema_version"]:
        raise ValueError(f"migration {state} source schema_version mismatch")
    migrated = dict(document)
    for field in migration["removed_fields"]:
        if field not in migrated:
            raise ValueError(f"migration {state} source omitted removed field {field}")
        migrated.pop(field)
    migrated["schema_version"] = migration["target_schema_version"]
    path = EVIDENCE / f"pi-deepseek-api-key.{state}.json"
    payload = canonical(migrated)
    return path, payload, digest(payload)


def migrate(write: bool) -> dict[str, object]:
    migration = load_migration()
    records = migration["records"]
    if not isinstance(records, dict) or set(records) != set(RECORD_STATES):
        raise ValueError("migration records must contain exactly the offline and live states")
    supporting = verify_supporting(migration)
    outputs = [migrate_record(migration, state) for state in RECORD_STATES]
    for path, payload, _ in outputs:
        if write:
            path.write_bytes(payload)
        elif path.read_bytes() != payload:
            raise ValueError(f"canonical evidence differs from migration output: {path.name}")
    digests = {path.name: sha256 for path, _, sha256 in outputs}
    return {
        "ok": True,
        "mode": "write" if write else "check",
        "schema_version": migration["target_schema_version"],
        "offline_evidence_sha256": digests[
            "pi-deepseek-api-key.offline-contract-passed.json"
        ],
        "registry_evidence_sha256": digests[
            "pi-deepseek-api-key.live-handshake-passed.json"
        ],
        "supporting_sha256": supporting,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate pinned capability evidence from schema v1 to v2.",
        epilog=(
            "Examples:\n"
            "  python scripts/migrate-capability-evidence.py --check\n"
            "  python scripts/migrate-capability-evidence.py --write"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="verify committed canonical outputs")
    mode.add_argument("--write", action="store_true", help="rewrite canonical evidence outputs")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        report = migrate(arguments.write)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
