# input:  external-suite YAML, ordered task pins, malformed documents
# output: strict reproducible full-suite spec parsing proofs
# pos:    Full-suite specification boundary tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import json
from pathlib import Path

import pytest
import yaml

from cortex_bench_harness.full_suite.config import SuiteSpecError, load_suite_spec

HARNESS = Path(__file__).resolve().parents[2]
COMMITTED_SPEC = HARNESS.parent / "external-suites/terminal-bench-2.1-full-pi.yaml"


def write_spec(tmp_path: Path, **updates: object) -> Path:
    inventory = tmp_path / "tasks.json"
    inventory.write_text(json.dumps({
        "schema_version": "cortex-bench-external-task-inventory/1",
        "source_commit": "a" * 40,
        "task_tree_sha256": "b" * 64,
        "tasks": [
            {"task_id": "one", "image_ref": "example/one:pin", "image_id": "sha256:" + "1" * 64},
            {"task_id": "two", "image_ref": "example/two:pin", "image_id": "sha256:" + "2" * 64},
        ],
    }), encoding="utf-8")
    document = {
        "schema_version": "cortex-bench-external-suite/1",
        "suite": "tb21-full-pi",
        "dataset": {
            "commit": "a" * 40, "task_count": 2,
            "task_tree_sha256": "b" * 64, "inventory": "tasks.json",
        },
        "schedule": {
            "concurrency": 8, "attempts_per_task": 1, "harbor_max_retries": 0,
        },
        "runtime": {"harbor_version": "0.20.0", "node_version": "22.19.0", "pi_version": "0.82.1"},
        "provider": {
            "capability": "pi-deepseek-api-key", "model": "deepseek-v4-flash",
            "upstream_base_url": "http://127.0.0.1:9880/m/deepseek/deepseek",
            "max_output_tokens": 65536,
        },
        "proxy": {
            "per_task_max_requests": 500, "suite_max_requests": 5000,
            "per_task_max_cost_usd": "2.00",
            "deadline_seconds": 7200, "request_body_limit_bytes": 67108864,
            "response_body_limit_bytes": 67108864, "trace_progress_seconds": 10,
            "subnet_pool": "172.30.240.0/20", "subnet_prefix": 24,
        },
        "network": {"mode": "open"},
        "outstanding_prerequisites": ["timeout-containment", "verifier-bootstrap"],
    }
    document.update(updates)
    path = tmp_path / "suite.yaml"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return path


def test_loads_strict_spec_and_ordered_inventory(tmp_path: Path) -> None:
    spec = load_suite_spec(write_spec(tmp_path))
    assert (spec.task_count, spec.concurrency, spec.attempts, spec.harbor_retries) == (2, 8, 1, 0)
    assert [task.task_id for task in spec.tasks] == ["one", "two"]
    assert spec.per_task_max_requests == 500
    assert spec.suite_max_requests == 5000


def test_unknown_top_level_field_is_refused(tmp_path: Path) -> None:
    path = write_spec(tmp_path, accidental_host_path="/tmp/not-committed")
    with pytest.raises(SuiteSpecError, match="unknown fields.*accidental_host_path"):
        load_suite_spec(path)


def test_paid_schedule_cannot_override_concurrency_attempts_or_retries(tmp_path: Path) -> None:
    path = write_spec(tmp_path)
    document = yaml.safe_load(path.read_text())
    document["schedule"]["harbor_max_retries"] = 1
    path.write_text(yaml.safe_dump(document))
    with pytest.raises(SuiteSpecError, match="schedule must be"):
        load_suite_spec(path)


def test_inventory_identity_must_match_dataset(tmp_path: Path) -> None:
    path = write_spec(tmp_path)
    document = yaml.safe_load(path.read_text())
    document["dataset"]["task_count"] = 3
    path.write_text(yaml.safe_dump(document))
    with pytest.raises(SuiteSpecError, match="task_count"):
        load_suite_spec(path)


def test_committed_spec_pins_all_89_tasks() -> None:
    spec = load_suite_spec(COMMITTED_SPEC)
    assert (spec.task_count, spec.concurrency, spec.attempts, spec.harbor_retries) == (89, 8, 1, 0)
    assert len({task.task_id for task in spec.tasks}) == 89
