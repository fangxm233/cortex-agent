# input:  scripted or opt-in Docker state and host proc census
# output: post-stop observation and fail-closed census proofs
# pos:    Container stop/wait boundary tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
import shutil
import subprocess
import uuid
from collections import defaultdict
from pathlib import Path

import pytest
from harbor.environments.base import ExecResult

from docker_gate import docker_opt_in
from cortex_bench_harness.container_boundary import (
    ContainerBoundaryObservation,
    ContainerBoundaryProbe,
    ContainerBoundaryUnproven,
)
from cortex_bench_harness.host_finalization import HostFinalizationError
from cortex_bench_harness.launcher.trial_admission import AdmittedDockerEnvironment
from cortex_bench_harness.launcher.trial_admission_io import PullDisabledDockerEnvironment

CONTAINER_ID = "a" * 64
NAMESPACE_ID = 4_026_531_841
CGROUP = f"/system.slice/docker-{CONTAINER_ID}.scope"
LOCAL_DEBIAN = "debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
INSPECT = ("docker", "inspect", "--format", "{{json .State}}", CONTAINER_ID)
TOP = ("docker", "top", CONTAINER_ID, "-eo", "pid")
NAMESPACE = ("docker", "exec", CONTAINER_ID, "readlink", "/proc/1/ns/pid")
WAIT = ("docker", "wait", CONTAINER_ID)
LSNS = ("lsns", "--type", "pid", "--output", "NS", "--noheadings")


class ScriptedRunner:
    def __init__(self, responses: dict[tuple[str, ...], list[ExecResult]]) -> None:
        self.responses = defaultdict(list, responses)
        self.calls: list[tuple[str, ...]] = []

    async def __call__(self, command: tuple[str, ...]) -> ExecResult:
        self.calls.append(command)
        values = self.responses[command]
        if not values:
            return ExecResult(return_code=127, stderr="unexpected command")
        return values.pop(0)


def state(*, running: bool, pid: object, status: str, exit_code: int) -> str:
    return json.dumps({
        "Status": status, "ExitCode": exit_code, "Running": running, "Pid": pid,
    })


def proc_stat(pid: int, start_ticks: int) -> str:
    return f"{pid} (fixture) S " + " ".join(["0"] * 18 + [str(start_ticks), "0"]) + "\n"


def write_process(proc_root: Path, pid: int, start_ticks: int) -> None:
    root = proc_root / str(pid)
    root.mkdir(parents=True)
    (root / "stat").write_text(proc_stat(pid, start_ticks))
    (root / "cgroup").write_text(f"0::{CGROUP}\n")


def runner(*, lsns: ExecResult | None = None) -> ScriptedRunner:
    return ScriptedRunner({
        INSPECT: [
            ExecResult(stdout=state(running=True, pid=101, status="running", exit_code=0), return_code=0),
            ExecResult(stdout=state(running=False, pid=0, status="exited", exit_code=17), return_code=0),
        ],
        TOP: [ExecResult(stdout="PID\n101\n102\n", return_code=0)],
        NAMESPACE: [ExecResult(stdout=f"pid:[{NAMESPACE_ID}]\n", return_code=0)],
        WAIT: [ExecResult(stdout="17\n", return_code=0)],
        LSNS: [lsns or ExecResult(stdout="4026531836\n", return_code=0)],
    })


def capture(probe: ContainerBoundaryProbe):
    return asyncio.run(probe.capture(CONTAINER_ID))


def observe(probe: ContainerBoundaryProbe, census):
    return asyncio.run(probe.observe_after_stop(census))


def test_positive_stop_wait_observation_requires_empty_cgroup_and_dead_namespace(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    write_process(proc_root, 101, 1001)
    write_process(proc_root, 102, 1002)
    commands = runner()
    probe = ContainerBoundaryProbe(commands, proc_root=proc_root)
    census = capture(probe)
    shutil.rmtree(proc_root / "101")
    shutil.rmtree(proc_root / "102")

    observation = observe(probe, census)

    assert observation.document("trial-one") == {
        "schema_version": "cortex-bench-container-boundary-attestation/1",
        "trial_id": "trial-one", "observed_at": observation.observed_at,
        "container_exit": {
            "status": "exited", "exit_code": 17, "running": False, "pid": 0,
        },
        "post_stop": {"descendants_alive": 0, "process_namespace_alive": False},
    }
    assert commands.calls.index(WAIT) < commands.calls.index(INSPECT, 1)
    assert commands.calls[-1] == LSNS


def test_unobservable_container_exit_code_fails_closed(tmp_path: Path) -> None:
    proc_root = tmp_path / "proc"
    write_process(proc_root, 101, 1001)
    write_process(proc_root, 102, 1002)
    commands = runner()
    commands.responses[WAIT] = [ExecResult(return_code=1, stderr="wait unavailable")]
    probe = ContainerBoundaryProbe(commands, proc_root=proc_root)
    census = capture(probe)
    shutil.rmtree(proc_root / "101")
    shutil.rmtree(proc_root / "102")

    with pytest.raises(ContainerBoundaryUnproven):
        observe(probe, census)


@pytest.mark.parametrize("pid", [False, 0.0])
def test_non_integer_zero_pid_is_not_positive_exit_evidence(
    tmp_path: Path, pid: object,
) -> None:
    proc_root = tmp_path / "proc"
    write_process(proc_root, 101, 1001)
    write_process(proc_root, 102, 1002)
    commands = runner()
    commands.responses[INSPECT][1] = ExecResult(
        stdout=state(running=False, pid=pid, status="exited", exit_code=17),
        return_code=0,
    )
    probe = ContainerBoundaryProbe(commands, proc_root=proc_root)
    census = capture(probe)
    shutil.rmtree(proc_root / "101")
    shutil.rmtree(proc_root / "102")

    with pytest.raises(ContainerBoundaryUnproven):
        observe(probe, census)


def test_exited_docker_state_alone_is_insufficient_when_namespace_is_unobservable(
    tmp_path: Path,
) -> None:
    proc_root = tmp_path / "proc"
    write_process(proc_root, 101, 1001)
    write_process(proc_root, 102, 1002)
    commands = runner(lsns=ExecResult(return_code=1, stderr="permission denied"))
    probe = ContainerBoundaryProbe(commands, proc_root=proc_root)
    census = capture(probe)
    shutil.rmtree(proc_root / "101")
    shutil.rmtree(proc_root / "102")

    with pytest.raises(ContainerBoundaryUnproven):
        observe(probe, census)


def test_unobservable_descendant_cgroup_census_fails_closed(tmp_path: Path) -> None:
    proc_root = tmp_path / "proc"
    write_process(proc_root, 101, 1001)
    write_process(proc_root, 102, 1002)
    commands = runner()
    probe = ContainerBoundaryProbe(commands, proc_root=proc_root)
    census = capture(probe)
    shutil.rmtree(proc_root / "101")
    shutil.rmtree(proc_root / "102")
    unreadable = proc_root / "103"
    unreadable.mkdir()
    (unreadable / "stat").write_text(proc_stat(103, 1003))
    (unreadable / "cgroup").mkdir()

    with pytest.raises(ContainerBoundaryUnproven):
        observe(probe, census)


def test_live_descendant_refuses_observation(tmp_path: Path) -> None:
    proc_root = tmp_path / "proc"
    write_process(proc_root, 101, 1001)
    write_process(proc_root, 102, 1002)
    commands = runner()
    probe = ContainerBoundaryProbe(commands, proc_root=proc_root)
    census = capture(probe)

    with pytest.raises(ContainerBoundaryUnproven):
        observe(probe, census)


def test_live_pid_namespace_refuses_observation(tmp_path: Path) -> None:
    proc_root = tmp_path / "proc"
    write_process(proc_root, 101, 1001)
    write_process(proc_root, 102, 1002)
    commands = runner(lsns=ExecResult(stdout=f"{NAMESPACE_ID}\n", return_code=0))
    probe = ContainerBoundaryProbe(commands, proc_root=proc_root)
    census = capture(probe)
    shutil.rmtree(proc_root / "101")
    shutil.rmtree(proc_root / "102")

    with pytest.raises(ContainerBoundaryUnproven):
        observe(probe, census)


@docker_opt_in
def test_real_pull_disabled_container_stop_is_observed_from_host() -> None:
    name = f"cortex-boundary-{uuid.uuid4().hex[:12]}"
    inspect = subprocess.run(
        ["docker", "image", "inspect", LOCAL_DEBIAN], capture_output=True, text=True,
    )
    assert inspect.returncode == 0, "the pinned local Debian image is required"
    started = subprocess.run(
        ["docker", "run", "--detach", "--pull=never", "--name", name,
         LOCAL_DEBIAN, "sleep", "infinity"],
        capture_output=True, text=True, check=True,
    )
    container_id = started.stdout.strip()
    try:
        probe = ContainerBoundaryProbe()
        census = asyncio.run(probe.capture(container_id))
        assert census.container_id == container_id
        subprocess.run(["docker", "stop", name], check=True, capture_output=True)
        observation = observe(probe, census)
        assert observation.descendants_alive == 0
        assert observation.process_namespace_alive is False
    finally:
        subprocess.run(["docker", "rm", "--force", name], capture_output=True)


def test_admitted_environment_finalizes_between_stop_wait_and_container_removal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []
    observation = ContainerBoundaryObservation(
        observed_at="2026-08-16T00:00:00.000Z", exit_code=0,
        descendants_alive=0, process_namespace_alive=False,
    )

    class Controller:
        post_stop_finalization_pending = True

        def finalize_after_container_stop(self, value: object) -> None:
            events.append(("finalize", value))

        def revoke_admitted_proxy(self) -> None:
            events.append("revoke")

    class Probe:
        async def capture(self, container_id: str) -> str:
            events.append(("capture", container_id))
            return "census"

        async def observe_after_stop(self, census: str) -> ContainerBoundaryObservation:
            events.append(("wait-observe", census))
            return observation

    environment = object.__new__(AdmittedDockerEnvironment)
    environment._proxy_controller = Controller()

    async def compose(command: list[str], **_kwargs: object) -> ExecResult:
        events.append(tuple(command))
        if command == ["ps", "--quiet", "main"]:
            return ExecResult(stdout=f"{CONTAINER_ID}\n", return_code=0)
        return ExecResult(return_code=0)

    async def base_stop(_self: object, delete: bool) -> None:
        events.append(("remove", delete))

    environment._run_docker_compose_command = compose
    environment._container_boundary_probe = lambda: Probe()
    monkeypatch.setattr(PullDisabledDockerEnvironment, "stop", base_stop)

    asyncio.run(environment.stop(delete=False))

    assert events.index(("stop",)) < events.index(("wait-observe", "census"))
    assert events.index(("wait-observe", "census")) < events.index(("finalize", observation))
    assert events.index(("finalize", observation)) < events.index(("remove", False))


def test_unobservable_stop_census_reports_boundary_failure_and_still_removes_container(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []

    class Controller:
        post_stop_finalization_pending = True

        def finalize_after_container_stop(self, value: object) -> None:
            events.append(("finalize", value))
            if value is None:
                raise HostFinalizationError("container_boundary_unproven")

        def revoke_admitted_proxy(self) -> None:
            events.append("revoke")

    class Probe:
        async def capture(self, _container_id: str) -> str:
            return "census"

        async def observe_after_stop(self, _census: str) -> ContainerBoundaryObservation:
            raise ContainerBoundaryUnproven("namespace census unavailable")

    environment = object.__new__(AdmittedDockerEnvironment)
    environment._proxy_controller = Controller()

    async def compose(command: list[str], **_kwargs: object) -> ExecResult:
        if command == ["ps", "--quiet", "main"]:
            return ExecResult(stdout=f"{CONTAINER_ID}\n", return_code=0)
        return ExecResult(return_code=0)

    async def base_stop(_self: object, delete: bool) -> None:
        events.append(("remove", delete))

    environment._run_docker_compose_command = compose
    environment._container_boundary_probe = lambda: Probe()
    monkeypatch.setattr(PullDisabledDockerEnvironment, "stop", base_stop)

    with pytest.raises(HostFinalizationError) as raised:
        asyncio.run(environment.stop(delete=False))

    assert raised.value.reason == "container_boundary_unproven"
    assert ("finalize", None) in events
    assert ("remove", False) in events
