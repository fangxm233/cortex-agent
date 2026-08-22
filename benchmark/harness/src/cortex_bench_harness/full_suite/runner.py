# input:  validated suite/host inputs, host-only credential and fixed slots
# output: one-attempt per-task Harbor results with isolated proxy evidence
# pos:    Full-suite execution coordinator
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict
from pathlib import Path

from cortex_bench_harness.proxy import SharedRequestLimit

from .config import HostInputs, SuiteSpec
from .network import NetworkSlot, create_networks, network_slots, remove_networks
from .processes import ProcessRegistry
from .scheduler import TaskOutcome, run_tasks
from .state import RunLedger
from .task_job import (
    build_child_environment,
    build_task_job,
    harbor_command,
    write_job,
    write_pi_config,
)
from .task_proxy import arm_task_proxy, finalize_task_proxy

HARNESS_ROOT = Path(__file__).resolve().parents[3]
SOURCE_ROOT = HARNESS_ROOT / "src"


class FullSuiteRunner:
    def __init__(
        self, spec: SuiteSpec, inputs: HostInputs, credential: str,
    ) -> None:
        self.spec = spec
        self.inputs = inputs
        self.credential = credential
        self.ledger = RunLedger.create(
            inputs.run_dir, spec.digest, [task.task_id for task in spec.tasks])
        self.slots = network_slots(spec, inputs.run_dir.name)
        self.shared_limit = SharedRequestLimit(spec.suite_max_requests)
        self.processes = ProcessRegistry()

    def run(self) -> dict[str, object]:
        create_networks(self.slots)
        try:
            outcomes = run_tasks(
                [task.task_id for task in self.spec.tasks], concurrency=self.spec.concurrency,
                execute=self._run_task, on_cancel=self.processes.cancel_all,
            )
        except BaseException:
            self._mark_not_run()
            raise
        finally:
            remove_networks(self.slots)
        document = self._suite_result(outcomes)
        _write_json(self.inputs.run_dir / "suite-result.json", document)
        return document

    def _run_task(self, task_id: str, slot_index: int) -> TaskOutcome:
        slot = self.slots[slot_index]
        root = self.inputs.run_dir / "tasks" / task_id
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.ledger.transition(task_id, "arming")
        try:
            return self._run_armed_task(task_id, root, slot)
        except BaseException as error:
            self._mark_failed(task_id)
            _remove_private_config(root)
            _assert_absent(root, (self.credential,))
            _write_json(root / "task-outcome.json", _failure(task_id, slot_index, error))
            raise

    def _run_armed_task(
        self, task_id: str, root: Path, slot: NetworkSlot,
    ) -> TaskOutcome:
        session = arm_task_proxy(
            self.spec, self.inputs, task_id=task_id, task_root=root,
            container_ipv4=slot.container_ipv4, credential=self.credential,
            shared_limit=self.shared_limit,
        )
        try:
            self.ledger.transition(task_id, "armed")
            code, dummy = self._invoke_harbor(task_id, root, slot, session.handle)
            finalized = finalize_task_proxy(session)
            result = _single_result(root / "harbor-results")
        except BaseException:
            session.handle.stop()
            raise
        _remove_private_config(root)
        _assert_absent(root, (self.credential, dummy))
        document = _task_document(task_id, slot.index, code, result, finalized)
        _write_json(root / "task-outcome.json", document)
        if not finalized.trace_complete:
            raise RuntimeError("network trace became incomplete")
        self.ledger.transition(task_id, "terminal")
        return TaskOutcome(task_id, slot.index, "terminal", _exception_name(result))

    def _invoke_harbor(
        self, task_id: str, root: Path, slot: NetworkSlot, handle: object,
    ) -> tuple[int, str]:
        dummy = str(getattr(handle, "dummy_token"))
        base_url = str(getattr(handle, "base_url"))
        config_root = root / "control/pi-config"
        write_pi_config(self.spec, config_root, base_url, dummy)
        job = build_task_job(
            self.spec, self.inputs, task_id=task_id,
            task_path=self.inputs.tasks_dir / task_id, task_root=root,
            pi_config=config_root, proxy_host=self.inputs.proxy_advertised_host,
            network_name=slot.name, container_ipv4=slot.container_ipv4,
        )
        job_path = root / "control/job.json"
        write_job(job_path, job)
        code = _run_harbor(self.inputs.harbor, job_path, root, self.processes)
        return code, dummy

    def _mark_failed(self, task_id: str) -> None:
        if self.ledger.state_of(task_id) in {"arming", "armed"}:
            self.ledger.transition(task_id, "failed")

    def _mark_not_run(self) -> None:
        for task_id in self.ledger.planned_tasks():
            self.ledger.transition(task_id, "not-run")

    def _suite_result(self, outcomes: list[TaskOutcome]) -> dict[str, object]:
        return {
            "ok": all(outcome.state == "terminal" for outcome in outcomes),
            "schema_version": "cortex-bench-full-suite-result/1",
            "suite": self.spec.suite, "spec_digest": self.spec.digest,
            "request_limit": {
                "maximum": self.shared_limit.maximum, "used": self.shared_limit.used},
            "outstanding_prerequisites": list(self.spec.outstanding_prerequisites),
            "tasks": [asdict(outcome) for outcome in outcomes],
        }


def _run_harbor(
    harbor: Path, job_path: Path, root: Path, registry: ProcessRegistry,
) -> int:
    environment = build_child_environment(os.environ, source_root=SOURCE_ROOT)
    with (root / "harbor.stdout.log").open("wb") as stdout:
        with (root / "harbor.stderr.log").open("wb") as stderr:
            return registry.run(
                harbor_command(harbor, job_path), cwd=HARNESS_ROOT,
                env=environment, stdout=stdout, stderr=stderr,
            )


def _single_result(root: Path) -> dict[str, object]:
    paths = list(root.rglob("result.json")) if root.is_dir() else []
    if len(paths) != 1:
        raise RuntimeError(f"expected one Harbor result.json, found {len(paths)}")
    try:
        result = json.loads(paths[0].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot parse Harbor result: {error}") from error
    if not isinstance(result, dict):
        raise RuntimeError("Harbor result must be a mapping")
    return result


def _task_document(
    task_id: str, slot: int, harbor_code: int, result: dict[str, object], finalized: object,
) -> dict[str, object]:
    verifier = result.get("verifier_result")
    reward = verifier.get("rewards") if isinstance(verifier, dict) else None
    return {
        "schema_version": "cortex-bench-full-suite-task-result/1",
        "task_id": task_id, "slot": slot, "harbor_exit_code": harbor_code,
        "exception_type": _exception_name(result), "reward": reward,
        "network_trace_complete": getattr(finalized, "trace_complete"),
        "network_trace": str(getattr(finalized, "network_trace_path")),
        "accounting": str(getattr(finalized, "accounting_path")),
        "revocation": str(getattr(finalized, "revocation_path")),
    }


def _exception_name(result: dict[str, object]) -> str | None:
    exception = result.get("exception_info")
    return str(exception.get("exception_type")) if isinstance(exception, dict) else None


def _failure(task_id: str, slot: int, error: BaseException) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-full-suite-task-result/1",
        "task_id": task_id, "slot": slot, "infrastructure_error": type(error).__name__,
    }


def _remove_private_config(root: Path) -> None:
    private = root / "control/pi-config"
    if private.exists():
        shutil.rmtree(private)


def _assert_absent(root: Path, secrets: tuple[str, ...]) -> None:
    planted = tuple(secret.encode() for secret in secrets if secret)
    for path in (candidate for candidate in root.rglob("*") if candidate.is_file()):
        payload = path.read_bytes()
        if any(secret in payload for secret in planted):
            raise RuntimeError(f"credential handle reached task artifact: {path.name}")


def _write_json(path: Path, document: object) -> None:
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
