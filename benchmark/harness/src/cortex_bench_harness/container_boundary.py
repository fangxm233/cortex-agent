# input:  Docker lifecycle state and host /proc namespace census
# output: post-stop container exit and process census observation
# pos:    Host container boundary recorder
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from harbor.environments.base import ExecResult

CommandRunner = Callable[[tuple[str, ...]], Awaitable[ExecResult]]
NAMESPACE_TARGET = re.compile(r"^pid:\[(\d+)]$")


class ContainerBoundaryUnproven(RuntimeError):
    """A required host exit, descendant, or namespace fact was not observable."""


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    start_ticks: int


@dataclass(frozen=True)
class LiveContainerCensus:
    container_id: str
    namespace_id: int
    cgroups: tuple[str, ...]
    processes: tuple[ProcessIdentity, ...]


@dataclass(frozen=True)
class ContainerBoundaryObservation:
    observed_at: str
    exit_code: int
    descendants_alive: int
    process_namespace_alive: bool

    def document(self, trial_id: str) -> dict[str, object]:
        return {
            "schema_version": "cortex-bench-container-boundary-attestation/1",
            "trial_id": trial_id, "observed_at": self.observed_at,
            "container_exit": {
                "status": "exited", "exit_code": self.exit_code,
                "running": False, "pid": 0,
            },
            "post_stop": {
                "descendants_alive": self.descendants_alive,
                "process_namespace_alive": self.process_namespace_alive,
            },
        }


class ContainerBoundaryProbe:
    def __init__(
        self, run_command: CommandRunner | None = None, *, proc_root: Path = Path("/proc"),
    ) -> None:
        self._run_command = run_command or run_host_command
        self._proc_root = proc_root

    async def capture(self, container_id: str) -> LiveContainerCensus:
        state = await self._docker_state(container_id)
        pid = _running_init_pid(state)
        processes = await self._docker_processes(container_id)
        if pid not in processes:
            raise ContainerBoundaryUnproven("container init PID absent from Docker top")
        namespace_id = await self._namespace_id(container_id)
        try:
            cgroups = _container_cgroups(self._proc_root / str(pid) / "cgroup")
            identities = tuple(_read_identity(self._proc_root, item) for item in processes)
            _require_cgroup_membership(self._proc_root, identities, cgroups)
        except FileNotFoundError as error:
            raise ContainerBoundaryUnproven("live process census changed") from error
        return LiveContainerCensus(container_id, namespace_id, cgroups, identities)

    async def observe_after_stop(
        self, census: LiveContainerCensus,
    ) -> ContainerBoundaryObservation:
        waited = await self._required(("docker", "wait", census.container_id))
        exit_code = _parse_exit_code(waited.stdout)
        state = await self._docker_state(census.container_id)
        _require_exited_state(state, exit_code)
        descendants = _descendants_alive(self._proc_root, census)
        namespace_alive = await self._namespace_alive(census.namespace_id)
        return ContainerBoundaryObservation(
            _timestamp(), exit_code, descendants, namespace_alive,
        )

    async def _docker_state(self, container_id: str) -> Mapping[str, object]:
        result = await self._required(
            ("docker", "inspect", "--format", "{{json .State}}", container_id),
        )
        try:
            value = json.loads(result.stdout or "")
        except (TypeError, ValueError) as error:
            raise ContainerBoundaryUnproven("Docker state is unreadable") from error
        if not isinstance(value, Mapping):
            raise ContainerBoundaryUnproven("Docker state is not a mapping")
        return value

    async def _docker_processes(self, container_id: str) -> tuple[int, ...]:
        result = await self._required(("docker", "top", container_id, "-eo", "pid"))
        lines = (result.stdout or "").splitlines()
        try:
            values = tuple(int(line.strip()) for line in lines[1:])
        except ValueError as error:
            raise ContainerBoundaryUnproven("Docker process census is unreadable") from error
        if not lines or lines[0].strip().casefold() != "pid":
            raise ContainerBoundaryUnproven("Docker process census has no PID header")
        if not values or any(value <= 0 for value in values) or len(values) != len(set(values)):
            raise ContainerBoundaryUnproven("Docker process census is incomplete")
        return values

    async def _namespace_id(self, container_id: str) -> int:
        result = await self._required(
            ("docker", "exec", container_id, "readlink", "/proc/1/ns/pid"),
        )
        match = NAMESPACE_TARGET.fullmatch((result.stdout or "").strip())
        if match is None:
            raise ContainerBoundaryUnproven("PID namespace identity is unreadable")
        return int(match.group(1))

    async def _namespace_alive(self, namespace_id: int) -> bool:
        result = await self._required(
            ("lsns", "--type", "pid", "--output", "NS", "--noheadings"),
        )
        try:
            namespaces = {int(line.strip()) for line in (result.stdout or "").splitlines()}
        except ValueError as error:
            raise ContainerBoundaryUnproven("PID namespace census is unreadable") from error
        return namespace_id in namespaces

    async def _required(self, command: tuple[str, ...]) -> ExecResult:
        try:
            result = await self._run_command(command)
        except Exception as error:
            raise ContainerBoundaryUnproven("host observation command failed") from error
        if result.return_code != 0:
            raise ContainerBoundaryUnproven("host observation command failed")
        return result


async def run_host_command(command: tuple[str, ...]) -> ExecResult:
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    return ExecResult(
        stdout=stdout.decode(errors="replace"), stderr=stderr.decode(errors="replace"),
        return_code=process.returncode,
    )


def _running_init_pid(state: Mapping[str, object]) -> int:
    pid = state.get("Pid")
    valid = (
        state.get("Status") == "running" and state.get("Running") is True
        and isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    )
    if not valid:
        raise ContainerBoundaryUnproven("container was not observably running before stop")
    return pid


def _parse_exit_code(value: str | None) -> int:
    try:
        exit_code = int((value or "").strip())
    except ValueError as error:
        raise ContainerBoundaryUnproven("Docker wait returned no exit code") from error
    if exit_code < 0:
        raise ContainerBoundaryUnproven("Docker wait returned an invalid exit code")
    return exit_code


def _require_exited_state(state: Mapping[str, object], waited_exit_code: int) -> None:
    exit_code = state.get("ExitCode")
    pid = state.get("Pid")
    valid = (
        set(("Status", "ExitCode", "Running", "Pid")) <= set(state)
        and state.get("Status") == "exited" and state.get("Running") is False
        and isinstance(pid, int) and not isinstance(pid, bool) and pid == 0
        and isinstance(exit_code, int) and not isinstance(exit_code, bool)
        and exit_code == waited_exit_code
    )
    if not valid:
        raise ContainerBoundaryUnproven("post-stop Docker state is unproven")


def _read_cgroups(path: Path) -> tuple[str, ...]:
    try:
        lines = path.read_text().splitlines()
        values = tuple(line.split(":", 2)[2] for line in lines)
    except FileNotFoundError:
        raise
    except (OSError, IndexError) as error:
        raise ContainerBoundaryUnproven("process cgroup is unreadable") from error
    if not values or any(not value.startswith("/") for value in values):
        raise ContainerBoundaryUnproven("process cgroup is ambiguous")
    return values


def _container_cgroups(path: Path) -> tuple[str, ...]:
    values = tuple(value for value in _read_cgroups(path) if value != "/")
    if not values:
        raise ContainerBoundaryUnproven("container cgroup is ambiguous")
    return values


def _read_identity(proc_root: Path, pid: int) -> ProcessIdentity:
    try:
        value = (proc_root / str(pid) / "stat").read_text()
        fields = value[value.rindex(")") + 2:].split()
        start_ticks = int(fields[19])
    except FileNotFoundError:
        raise
    except (OSError, ValueError, IndexError) as error:
        raise ContainerBoundaryUnproven("process identity is unreadable") from error
    return ProcessIdentity(pid, start_ticks)


def _require_cgroup_membership(
    proc_root: Path, identities: tuple[ProcessIdentity, ...], cgroups: tuple[str, ...],
) -> None:
    for identity in identities:
        values = _read_cgroups(proc_root / str(identity.pid) / "cgroup")
        if not any(_cgroup_contains(root, value) for root in cgroups for value in values):
            raise ContainerBoundaryUnproven("Docker process is outside the captured cgroup")


def _cgroup_contains(root: str, value: str) -> bool:
    return value == root or value.startswith(f"{root.rstrip('/')}/")


def _descendants_alive(proc_root: Path, census: LiveContainerCensus) -> int:
    alive = set()
    try:
        entries = tuple(proc_root.iterdir())
    except OSError as error:
        raise ContainerBoundaryUnproven("host proc census is unreadable") from error
    for entry in entries:
        if entry.name.isdigit():
            _add_cgroup_member(proc_root, int(entry.name), census.cgroups, alive)
    for identity in census.processes:
        if _identity_still_alive(proc_root, identity):
            alive.add((identity.pid, identity.start_ticks))
    return len(alive)


def _add_cgroup_member(
    proc_root: Path, pid: int, cgroups: tuple[str, ...], alive: set[tuple[int, int]],
) -> None:
    try:
        values = _read_cgroups(proc_root / str(pid) / "cgroup")
        if any(_cgroup_contains(root, value) for root in cgroups for value in values):
            identity = _read_identity(proc_root, pid)
            alive.add((identity.pid, identity.start_ticks))
    except FileNotFoundError:
        return


def _identity_still_alive(proc_root: Path, expected: ProcessIdentity) -> bool:
    try:
        actual = _read_identity(proc_root, expected.pid)
    except FileNotFoundError:
        return False
    return actual == expected


def _timestamp() -> str:
    value = datetime.now(UTC).isoformat(timespec="milliseconds")
    return value.replace("+00:00", "Z")
