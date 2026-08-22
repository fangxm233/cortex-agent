# input:  committed external-suite YAML, task inventory, host placement flags
# output: strict immutable suite specification and host input types
# pos:    Full-suite configuration boundary
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

SPEC_SCHEMA = "cortex-bench-external-suite/1"
INVENTORY_SCHEMA = "cortex-bench-external-task-inventory/1"
HEX = re.compile(r"^[0-9a-f]+$")
IDENTIFIER = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
TASK_IDENTIFIER = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$")
FIXED_CONCURRENCY = 8
FIXED_ATTEMPTS = 1
FIXED_HARBOR_RETRIES = 0


class SuiteSpecError(ValueError):
    """A full-suite document is incomplete, ambiguous, or internally inconsistent."""


@dataclass(frozen=True)
class TaskPin:
    task_id: str
    image_ref: str
    image_id: str


@dataclass(frozen=True)
class SuiteSpec:
    source: Path
    suite: str
    dataset_commit: str
    task_tree_sha256: str
    tasks: tuple[TaskPin, ...]
    concurrency: int
    attempts: int
    harbor_retries: int
    harbor_version: str
    node_version: str
    pi_version: str
    capability: str
    model: str
    upstream_base_url: str
    max_output_tokens: int
    per_task_max_requests: int
    suite_max_requests: int
    per_task_max_cost_usd: str
    deadline_seconds: int
    request_body_limit_bytes: int
    response_body_limit_bytes: int
    trace_progress_seconds: int
    subnet_pool: str
    subnet_prefix: int
    network_mode: str
    outstanding_prerequisites: tuple[str, ...]
    digest: str

    @property
    def task_count(self) -> int:
        return len(self.tasks)


@dataclass(frozen=True)
class HostInputs:
    tasks_dir: Path
    run_dir: Path
    image_inventory: Path
    harbor: Path
    node_root: Path
    pi_root: Path
    gateway: Path
    proxy_listen_host: str
    proxy_advertised_host: str


def load_suite_spec(path: Path | str) -> SuiteSpec:
    source = Path(path).resolve()
    document = _yaml_mapping(source)
    _fields(document, {
        "schema_version", "suite", "dataset", "schedule", "runtime", "provider",
        "proxy", "network", "outstanding_prerequisites",
    }, "suite")
    if document["schema_version"] != SPEC_SCHEMA:
        raise SuiteSpecError(f"schema_version must be {SPEC_SCHEMA!r}")
    inventory_path, inventory = _inventory(source, document["dataset"])
    return _build_spec(source, document, inventory_path, inventory)


def _build_spec(
    source: Path, document: Mapping[str, Any], inventory_path: Path, inventory: tuple[TaskPin, ...],
) -> SuiteSpec:
    dataset = _section(document, "dataset", {"commit", "task_count", "task_tree_sha256", "inventory"})
    schedule = _section(document, "schedule", {"concurrency", "attempts_per_task", "harbor_max_retries"})
    runtime = _section(document, "runtime", {
        "harbor_version", "node_version", "pi_version"})
    provider = _section(document, "provider", {
        "capability", "model", "upstream_base_url", "max_output_tokens"})
    proxy = _section(document, "proxy", {
        "per_task_max_requests", "suite_max_requests", "per_task_max_cost_usd", "deadline_seconds",
        "request_body_limit_bytes", "response_body_limit_bytes", "trace_progress_seconds",
        "subnet_pool", "subnet_prefix"})
    _validate_dataset(dataset, inventory, inventory_path)
    _validate_schedule(schedule)
    return SuiteSpec(
        source, _identifier(document, "suite"), _sha(dataset, "commit", 40),
        _sha(dataset, "task_tree_sha256", 64), inventory,
        _positive(schedule, "concurrency"), _positive(schedule, "attempts_per_task"),
        _nonnegative(schedule, "harbor_max_retries"), _text(runtime, "harbor_version"),
        _text(runtime, "node_version"), _text(runtime, "pi_version"),
        _text(provider, "capability"), _text(provider, "model"),
        _text(provider, "upstream_base_url"), _positive(provider, "max_output_tokens"),
        _positive(proxy, "per_task_max_requests"), _positive(proxy, "suite_max_requests"),
        _text(proxy, "per_task_max_cost_usd"), _positive(proxy, "deadline_seconds"),
        _positive(proxy, "request_body_limit_bytes"), _positive(proxy, "response_body_limit_bytes"),
        _positive(proxy, "trace_progress_seconds"), _text(proxy, "subnet_pool"),
        _positive(proxy, "subnet_prefix"), _network_mode(document["network"]),
        _prerequisites(document), _digest(source, inventory_path),
    )


def _inventory(
    source: Path, dataset_value: object,
) -> tuple[Path, tuple[TaskPin, ...]]:
    dataset = _mapping(dataset_value, "dataset")
    inventory_path = (source.parent / _text(dataset, "inventory")).resolve()
    document = _json_mapping(inventory_path)
    _fields(document, {
        "schema_version", "source_commit", "task_tree_sha256", "tasks"}, "inventory")
    if document["schema_version"] != INVENTORY_SCHEMA:
        raise SuiteSpecError(f"inventory schema_version must be {INVENTORY_SCHEMA!r}")
    rows = document["tasks"]
    if not isinstance(rows, list):
        raise SuiteSpecError("inventory tasks must be a list")
    tasks = tuple(_task_pin(row, index) for index, row in enumerate(rows))
    if len({task.task_id for task in tasks}) != len(tasks):
        raise SuiteSpecError("inventory task_id values must be unique")
    return inventory_path, tasks


def _task_pin(value: object, index: int) -> TaskPin:
    row = _mapping(value, f"inventory task[{index}]")
    _fields(row, {"task_id", "image_ref", "image_id"}, f"inventory task[{index}]")
    image_id = _text(row, "image_id")
    if not image_id.startswith("sha256:") or not _is_hex(image_id[7:], 64):
        raise SuiteSpecError(f"inventory task[{index}] image_id must be sha256:<64 hex>")
    task_id = _task_id(row)
    return TaskPin(task_id, _text(row, "image_ref"), image_id)


def _validate_dataset(
    dataset: Mapping[str, Any], tasks: tuple[TaskPin, ...], inventory_path: Path,
) -> None:
    count = _positive(dataset, "task_count")
    if count != len(tasks):
        raise SuiteSpecError(f"dataset task_count {count} does not match inventory {len(tasks)}")
    inventory = _json_mapping(inventory_path)
    pairs = (
        ("commit", "source_commit", 40),
        ("task_tree_sha256", "task_tree_sha256", 64),
    )
    for dataset_field, inventory_field, length in pairs:
        if _sha(dataset, dataset_field, length) != _sha(inventory, inventory_field, length):
            raise SuiteSpecError(f"dataset {dataset_field} does not match inventory")


def _validate_schedule(schedule: Mapping[str, Any]) -> None:
    observed = (
        _positive(schedule, "concurrency"), _positive(schedule, "attempts_per_task"),
        _nonnegative(schedule, "harbor_max_retries"),
    )
    expected = (FIXED_CONCURRENCY, FIXED_ATTEMPTS, FIXED_HARBOR_RETRIES)
    if observed != expected:
        raise SuiteSpecError(f"schedule must be concurrency/attempts/retries {expected}; got {observed}")


def _network_mode(value: object) -> str:
    network = _mapping(value, "network")
    _fields(network, {"mode"}, "network")
    mode = _text(network, "mode")
    if mode != "open":
        raise SuiteSpecError(f"network mode must be 'open'; got {mode!r}")
    return mode


def _prerequisites(document: Mapping[str, Any]) -> tuple[str, ...]:
    value = document["outstanding_prerequisites"]
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        raise SuiteSpecError("outstanding_prerequisites must be a non-empty string list")
    return tuple(value)


def _section(
    document: Mapping[str, Any], field: str, expected: set[str],
) -> Mapping[str, Any]:
    section = _mapping(document[field], field)
    _fields(section, expected, field)
    return section


def _fields(document: Mapping[str, Any], expected: set[str], label: str) -> None:
    unknown = sorted(set(document) - expected)
    if unknown:
        raise SuiteSpecError(f"{label} rejects unknown fields {unknown}")
    missing = sorted(expected - set(document))
    if missing:
        raise SuiteSpecError(f"{label} requires fields {missing}")


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SuiteSpecError(f"{label} must be a mapping")
    return value


def _text(document: Mapping[str, Any], field: str) -> str:
    value = document.get(field)
    if not isinstance(value, str) or not value:
        raise SuiteSpecError(f"{field} must be a non-empty string")
    return value


def _task_id(document: Mapping[str, Any]) -> str:
    value = _text(document, "task_id")
    if TASK_IDENTIFIER.fullmatch(value) is None or ".." in value:
        raise SuiteSpecError("task_id must be a safe relative task name")
    return value


def _identifier(document: Mapping[str, Any], field: str) -> str:
    value = _text(document, field)
    if IDENTIFIER.fullmatch(value) is None:
        raise SuiteSpecError(f"{field} must be a lowercase DNS-safe identifier")
    return value


def _positive(document: Mapping[str, Any], field: str) -> int:
    value = document.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise SuiteSpecError(f"{field} must be a positive integer")
    return value


def _nonnegative(document: Mapping[str, Any], field: str) -> int:
    value = document.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise SuiteSpecError(f"{field} must be a non-negative integer")
    return value


def _sha(document: Mapping[str, Any], field: str, length: int) -> str:
    value = _text(document, field)
    if not _is_hex(value, length):
        raise SuiteSpecError(f"{field} must be {length} lowercase hex characters")
    return value


def _is_hex(value: str, length: int) -> bool:
    return len(value) == length and HEX.fullmatch(value) is not None


def _yaml_mapping(path: Path) -> Mapping[str, Any]:
    try:
        return _mapping(yaml.safe_load(path.read_text(encoding="utf-8")), "suite")
    except (OSError, yaml.YAMLError) as error:
        raise SuiteSpecError(f"cannot read suite spec {path}: {error}") from error


def _json_mapping(path: Path) -> Mapping[str, Any]:
    try:
        return _mapping(json.loads(path.read_text(encoding="utf-8")), "inventory")
    except (OSError, json.JSONDecodeError) as error:
        raise SuiteSpecError(f"cannot read task inventory {path}: {error}") from error


def _digest(spec_path: Path, inventory_path: Path) -> str:
    digest = hashlib.sha256()
    for path in (spec_path, inventory_path):
        digest.update(path.read_bytes())
    return digest.hexdigest()
