# input:  one task, proxy handle, runtime roots and hostile environment
# output: single-task Harbor config and credential-boundary proofs
# pos:    Full-suite Harbor job builder tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import json
from pathlib import Path

from cortex_bench_harness.full_suite.config import HostInputs, load_suite_spec
from cortex_bench_harness.full_suite.task_job import (
    build_child_environment,
    build_task_job,
    write_pi_config,
)
from .test_config import write_spec


def host_inputs(tmp_path: Path) -> HostInputs:
    paths = {name: tmp_path / name for name in (
        "tasks", "run", "images.json", "harbor", "node", "pi", "gateway.yaml")}
    return HostInputs(
        tasks_dir=paths["tasks"], run_dir=paths["run"], image_inventory=paths["images.json"],
        harbor=paths["harbor"], node_root=paths["node"], pi_root=paths["pi"],
        gateway=paths["gateway.yaml"], proxy_listen_host="0.0.0.0",
        proxy_advertised_host="172.30.240.1",
    )


def test_job_contains_exactly_one_task_and_no_retry(tmp_path: Path) -> None:
    spec = load_suite_spec(write_spec(tmp_path))
    inputs = host_inputs(tmp_path)
    task_path = inputs.tasks_dir / "one"
    control = inputs.run_dir / "tasks/one/control"
    pi_config = control / "pi-config"
    job = build_task_job(
        spec, inputs, task_id="one", task_path=task_path, task_root=inputs.run_dir / "tasks/one",
        pi_config=pi_config, proxy_host="one.proxy.invalid", network_name="run-slot-0",
        container_ipv4="172.30.240.2",
    )
    assert job["tasks"] == [{"path": str(task_path)}]
    assert "datasets" not in job
    assert (job["n_attempts"], job["n_concurrent_trials"]) == (1, 1)
    assert job["retry"] == {"max_retries": 0}
    assert job["environment"]["kwargs"] == {
        "external_network_name": "run-slot-0",
        "proxy_host": "one.proxy.invalid",
        "container_ipv4": "172.30.240.2",
    }
    assert all(mount["read_only"] is True for mount in job["environment"]["mounts"])


def test_pi_config_contains_dummy_only_and_is_private(tmp_path: Path) -> None:
    spec = load_suite_spec(write_spec(tmp_path))
    root = tmp_path / "pi-config"
    write_pi_config(spec, root, "http://proxy.invalid:1234", "dummy-unique")
    payload = "".join(path.read_text() for path in root.iterdir())
    assert "dummy-unique" in payload
    assert spec.upstream_base_url not in payload
    assert root.stat().st_mode & 0o777 == 0o700
    assert (root / "auth.json").stat().st_mode & 0o777 == 0o600
    assert json.loads((root / "models.json").read_text())["providers"]["deepseek"]["baseUrl"] == "http://proxy.invalid:1234/v1"


def test_child_environment_is_allowlisted_and_has_no_provider_key(tmp_path: Path) -> None:
    parent = {
        "PATH": "/usr/bin", "HOME": "/home/test", "LANG": "C.UTF-8",
        "PYTHONPATH": "/hostile", "DEEPSEEK_API_KEY": "secret", "UNRELATED": "drop",
    }
    child = build_child_environment(parent, source_root=tmp_path / "src")
    assert child == {
        "HOME": "/home/test", "LANG": "C.UTF-8", "PATH": "/usr/bin",
        "PYTHONPATH": str(tmp_path / "src"),
    }
    assert "secret" not in json.dumps(child)
