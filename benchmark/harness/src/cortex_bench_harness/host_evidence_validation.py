# input:  host-owned manifest, admission, adapter evidence
# output: trial/root/arm identity validity
# pos:    Validates host evidence before outer admission
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from collections.abc import Mapping
from pathlib import Path

from .launcher.trial_admission import ADMISSION_EVIDENCE_FILENAME, ADMISSION_SCHEMA_VERSION
from .launcher.trial_proxy import (
    ADAPTER_SELECTION_FILENAME,
    ADAPTER_SELECTION_SCHEMA_VERSION,
)
from .manifest import MANIFEST_FILENAME, SCHEMA_VERSION


def validate_host_owned_identity(
    artifact_dir: Path, trial_id: str, root_run_id: str, arm_name: object,
) -> None:
    manifest = _read_mapping(artifact_dir / MANIFEST_FILENAME)
    admission = _read_mapping(artifact_dir / ADMISSION_EVIDENCE_FILENAME)
    adapter = _read_mapping(artifact_dir / "proxy" / ADAPTER_SELECTION_FILENAME)
    checks = (
        manifest.get("schema_version") == SCHEMA_VERSION,
        manifest.get("trial_id") == trial_id,
        manifest.get("root_run_id") == root_run_id,
        manifest.get("arm") == arm_name,
        admission.get("schema_version") == ADMISSION_SCHEMA_VERSION,
        admission.get("trial_id") == trial_id,
        admission.get("root_run_id") == root_run_id,
        adapter.get("schema_version") == ADAPTER_SELECTION_SCHEMA_VERSION,
        adapter.get("trial_id") == trial_id,
    )
    if not all(checks):
        raise ValueError("host-owned evidence identity mismatch")


def _read_mapping(path: Path) -> Mapping[str, object]:
    value = json.loads(path.read_bytes())
    if not isinstance(value, Mapping):
        raise ValueError("host-owned evidence must be an object")
    return value
