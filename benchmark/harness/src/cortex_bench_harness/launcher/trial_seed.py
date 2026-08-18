# input:  one launcher trial seed mapping
# output: immutable validated trial seed facts
# pos:    Trial seed parsing boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class TrialSeed:
    arm: Mapping[str, object]
    arm_path: str
    trial_id: str
    root_run_id: str
    task: Mapping[str, object]
    profile_name: str
    paid_run: bool
    credential: Mapping[str, object]
    model_alias_policy: object
    expected_asset_hashes: Mapping[str, str] | None = None
    pi_benchmark_capability_proven: bool | None = None


SEED_REQUIRED_FIELDS = frozenset({
    "arm", "arm_path", "trial_id", "root_run_id", "task", "profile_name", "paid_run",
    "credential", "model_alias_policy",
})
SEED_OPTIONAL_FIELDS = frozenset({
    "expected_asset_hashes", "pi_benchmark_capability_proven",
})


def _seed_text(values: Mapping[str, object], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"TrialSeed field '{key}' must be a non-empty string")
    return value


def _seed_mapping(values: Mapping[str, object], key: str) -> Mapping[str, object]:
    value = values.get(key)
    if not isinstance(value, Mapping):
        raise ValueError(f"TrialSeed field '{key}' must be a mapping")
    return value


def _plain_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {str(key): _plain_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json(item) for item in value]
    return value


def _json_copy(value: object) -> object:
    return json.loads(json.dumps(_plain_json(value)))


def parse_trial_seed(source: Mapping[str, object]) -> TrialSeed:
    rejected = sorted(set(source) - SEED_REQUIRED_FIELDS - SEED_OPTIONAL_FIELDS)
    if rejected:
        raise ValueError(f"TrialSeed rejects launcher-owned fields {rejected}")
    missing = sorted(SEED_REQUIRED_FIELDS - set(source))
    if missing:
        raise ValueError(f"TrialSeed requires fields {missing}")
    values = _json_copy(source)
    if not isinstance(values, Mapping):
        raise ValueError("TrialSeed must be a mapping")
    paid_run = values["paid_run"]
    if not isinstance(paid_run, bool):
        raise ValueError("TrialSeed field 'paid_run' must be a boolean")
    hashes = values.get("expected_asset_hashes")
    if hashes is not None and not isinstance(hashes, Mapping):
        raise ValueError("TrialSeed field 'expected_asset_hashes' must be a mapping")
    proven = values.get("pi_benchmark_capability_proven")
    if proven is not None and not isinstance(proven, bool):
        raise ValueError("TrialSeed field 'pi_benchmark_capability_proven' must be a boolean")
    return TrialSeed(
        arm=_seed_mapping(values, "arm"),
        arm_path=_seed_text(values, "arm_path"),
        trial_id=_seed_text(values, "trial_id"),
        root_run_id=_seed_text(values, "root_run_id"),
        task=_seed_mapping(values, "task"),
        profile_name=_seed_text(values, "profile_name"),
        paid_run=paid_run,
        credential=_seed_mapping(values, "credential"),
        model_alias_policy=values["model_alias_policy"],
        expected_asset_hashes=hashes,
        pi_benchmark_capability_proven=proven,
    )
