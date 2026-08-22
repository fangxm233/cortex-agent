# input:  synthetic task assets, runtime pins, fake gateway and Docker inventory
# output: zero-provider full-suite preflight validation proofs
# pos:    Full-suite preflight tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import json
import subprocess
from pathlib import Path

import yaml

from cortex_bench_harness.full_suite.config import HostInputs, load_suite_spec
from cortex_bench_harness.full_suite.preflight import preflight, task_tree_digest
from .test_config import write_spec

FAKE_CREDENTIAL = "test-not-real-deepseek-key-0123456789abcdef"


def test_preflight_validates_every_task_without_creating_run(tmp_path: Path) -> None:
    spec_path = write_spec(tmp_path)
    tasks = tmp_path / "task-assets"
    for task_id, image in (("one", "example/one:pin"), ("two", "example/two:pin")):
        root = tasks / task_id
        root.mkdir(parents=True)
        (root / "task.toml").write_text(f'[environment]\ndocker_image = "{image}"\n')
        (root / "instruction.md").write_text(task_id)
    digest = task_tree_digest(tasks)
    _replace_tree_digest(spec_path, digest)
    inventory = json.loads((tmp_path / "tasks.json").read_text())
    image_inventory = tmp_path / "host-images.json"
    image_inventory.write_text(json.dumps(inventory))
    harbor = _executable(tmp_path / "harbor")
    node = _executable(tmp_path / "node/bin/node")
    pi = tmp_path / "pi"
    pi.mkdir()
    (pi / "package.json").write_text(json.dumps({"version": "0.82.1"}))
    gateway = tmp_path / "gateway.yaml"
    gateway.write_text(
        f"deepseek:\n  deepseek:\n    keys:\n      - {FAKE_CREDENTIAL}\n")
    inputs = HostInputs(
        tasks, tmp_path / "absent-run", image_inventory, harbor, node.parent.parent,
        pi, gateway, "0.0.0.0", "172.30.240.1",
    )

    report = preflight(load_suite_spec(spec_path), inputs, run_command=_fake_command)

    assert report["ok"] is True
    assert report["task_count"] == 2
    assert report["provider_requests"] == 0
    assert report["credential_loaded"] is True
    assert report["would_arm_routes"] == 0
    assert not inputs.run_dir.exists()
    assert FAKE_CREDENTIAL not in json.dumps(report)


def _replace_tree_digest(spec_path: Path, digest: str) -> None:
    document = yaml.safe_load(spec_path.read_text())
    document["dataset"]["task_tree_sha256"] = digest
    spec_path.write_text(yaml.safe_dump(document))
    inventory_path = spec_path.parent / document["dataset"]["inventory"]
    inventory = json.loads(inventory_path.read_text())
    inventory["task_tree_sha256"] = digest
    inventory_path.write_text(json.dumps(inventory))


def _executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o755)
    return path


def _fake_command(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
    if command[-1] == "--version" and command[0].endswith("harbor"):
        output = "harbor 0.20.0\n"
    elif command[-1] == "--version":
        output = "v22.19.0\n"
    else:
        task = command[-3]
        image_id = "sha256:" + ("1" * 64 if "one" in task else "2" * 64)
        output = image_id + "\n"
    return subprocess.CompletedProcess(command, 0, output, "")
