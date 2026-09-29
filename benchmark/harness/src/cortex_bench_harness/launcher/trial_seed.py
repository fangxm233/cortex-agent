import json
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class TrialSeed:
    arm: Mapping[str, object]
    trial_id: str
    root_run_id: str
    task: Mapping[str, object]
    profile_name: str
    paid_run: bool
    credential: Mapping[str, object]
    model_alias_policy: object


SEED_REQUIRED_FIELDS = frozenset({
    "arm", "trial_id", "root_run_id", "task", "profile_name", "paid_run",
    "credential", "model_alias_policy",
})
# Nothing reads `arm_path` any more. It is accepted and dropped, so a seed that still names it
# keeps parsing.
SEED_RETIRED_FIELDS = frozenset({"arm_path"})


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
    rejected = sorted(set(source) - SEED_REQUIRED_FIELDS - SEED_RETIRED_FIELDS)
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
    return TrialSeed(
        arm=_seed_mapping(values, "arm"),
        trial_id=_seed_text(values, "trial_id"),
        root_run_id=_seed_text(values, "root_run_id"),
        task=_seed_mapping(values, "task"),
        profile_name=_seed_text(values, "profile_name"),
        paid_run=paid_run,
        credential=_seed_mapping(values, "credential"),
        model_alias_policy=values["model_alias_policy"],
    )
