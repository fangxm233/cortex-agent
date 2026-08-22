# input:  suite spec, external task/runtime assets, fake-or-real gateway
# output: zero-provider validation report or precise refusal
# pos:    Full-suite host preflight boundary
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import hashlib
import json
import subprocess
import tomllib
from collections.abc import Callable
from pathlib import Path

from cortex_bench_harness.launcher.deepseek_paid_smoke import (
    load_deepseek_relay_credential,
)

from .config import HostInputs, SuiteSpec, TaskPin


class PreflightError(RuntimeError):
    """Host inputs cannot reproduce the committed full-suite spec."""


def preflight(
    spec: SuiteSpec, inputs: HostInputs, *,
    run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, object]:
    _require_fresh_run(inputs.run_dir)
    _validate_task_tree(spec, inputs.tasks_dir)
    _validate_host_inventory(spec, inputs.image_inventory)
    _validate_runtimes(spec, inputs, run_command)
    _validate_images(spec.tasks, run_command)
    credential = _load_credential(inputs.gateway)
    del credential
    return {
        "ok": True, "schema_version": "cortex-bench-full-suite-preflight/1",
        "suite": spec.suite, "spec_digest": spec.digest,
        "task_count": spec.task_count, "concurrency": spec.concurrency,
        "provider_requests": 0, "would_arm_routes": 0,
        "credential_loaded": True,
        "outstanding_prerequisites": list(spec.outstanding_prerequisites),
    }


def task_tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    files = sorted(path for path in root.rglob("*") if path.is_file())
    for path in files:
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def _require_fresh_run(run_dir: Path) -> None:
    if run_dir.exists():
        raise PreflightError(f"run directory already exists: {run_dir}; choose a new run identity")


def _validate_task_tree(spec: SuiteSpec, root: Path) -> None:
    if not root.is_dir():
        raise PreflightError(f"task directory is unavailable: {root}")
    actual_ids = sorted(path.name for path in root.iterdir() if (path / "task.toml").is_file())
    expected_ids = sorted(task.task_id for task in spec.tasks)
    if actual_ids != expected_ids:
        raise PreflightError("task directory ids differ from the committed inventory")
    if task_tree_digest(root) != spec.task_tree_sha256:
        raise PreflightError("task tree digest differs from the committed inventory")
    for task in spec.tasks:
        _validate_task_image(root / task.task_id / "task.toml", task)


def _validate_task_image(path: Path, task: TaskPin) -> None:
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
        image_ref = document["environment"]["docker_image"]
    except (OSError, tomllib.TOMLDecodeError, KeyError, TypeError) as error:
        raise PreflightError(f"cannot read task image from {path}: {error}") from error
    if image_ref != task.image_ref:
        raise PreflightError(f"task {task.task_id} image ref differs from inventory")


def _validate_host_inventory(spec: SuiteSpec, path: Path) -> None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        rows = document["tasks"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise PreflightError(f"cannot read host image inventory {path}: {error}") from error
    observed = [
        (row.get("task_id"), row.get("image_ref"), row.get("image_id")) for row in rows
    ]
    expected = [(task.task_id, task.image_ref, task.image_id) for task in spec.tasks]
    if observed != expected:
        raise PreflightError("host image inventory differs from committed task pins")


def _validate_runtimes(
    spec: SuiteSpec, inputs: HostInputs,
    run_command: Callable[..., subprocess.CompletedProcess[str]],
) -> None:
    harbor = _command_text(run_command, [str(inputs.harbor), "--version"])
    if spec.harbor_version not in harbor:
        raise PreflightError(f"Harbor version differs from {spec.harbor_version}")
    node = _command_text(run_command, [str(inputs.node_root / "bin/node"), "--version"])
    if node != f"v{spec.node_version}":
        raise PreflightError(f"Node version differs from {spec.node_version}")
    try:
        pi_version = json.loads((inputs.pi_root / "package.json").read_text())["version"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise PreflightError(f"cannot read PI runtime version: {error}") from error
    if pi_version != spec.pi_version:
        raise PreflightError(f"PI version differs from {spec.pi_version}")


def _validate_images(
    tasks: tuple[TaskPin, ...],
    run_command: Callable[..., subprocess.CompletedProcess[str]],
) -> None:
    for task in tasks:
        command = ["docker", "image", "inspect", task.image_ref, "--format", "{{.Id}}"]
        if _command_text(run_command, command) != task.image_id:
            raise PreflightError(f"local image identity differs for {task.task_id}")


def _command_text(
    run_command: Callable[..., subprocess.CompletedProcess[str]], command: list[str],
) -> str:
    result = run_command(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise PreflightError(f"command failed without provider traffic: {command[0]}")
    return result.stdout.strip()


def _load_credential(path: Path) -> str:
    try:
        return load_deepseek_relay_credential(path)
    except (OSError, ValueError) as error:
        raise PreflightError(f"cannot load the gateway credential from {path}: {error}") from error
