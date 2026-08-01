# input:  Harbor BaseEnvironment and POSIX path commands
# output: resolved task cwd or a fail-closed exception
# pos:    Container-side task workdir resolver
# >>> If I am updated, update my header and folder CORTEX.md <<<

import logging
import shlex
from dataclasses import dataclass
from typing import Protocol

from harbor.environments.base import ExecResult

LOGGER = logging.getLogger(__name__)


class ExecEnvironment(Protocol):
    async def exec(self, command: str, **kwargs: object) -> ExecResult: ...


@dataclass(frozen=True)
class ResolvedCwd:
    pwd_raw: str
    realpath: str
    exists: bool


class WorkdirResolutionError(RuntimeError):
    pass


def _log_exec(command: str, result: ExecResult) -> None:
    LOGGER.info(
        "container exec command=%r return_code=%s stdout=%r stderr=%r",
        command,
        result.return_code,
        result.stdout,
        result.stderr,
    )


async def _exec(environment: ExecEnvironment, command: str, failure: str) -> ExecResult:
    result = await environment.exec(command=command)
    _log_exec(command, result)
    if result.return_code != 0:
        raise WorkdirResolutionError(f"{failure}: {command}")
    return result


def _path_output(result: ExecResult, empty_message: str) -> str:
    value = result.stdout or ""
    if value.endswith("\n"):
        value = value[:-1]
    if not value:
        raise WorkdirResolutionError(empty_message)
    if "\n" in value or "\r" in value:
        raise WorkdirResolutionError("container path output contained multiple lines")
    return value


async def resolve_task_workdir(environment: ExecEnvironment) -> ResolvedCwd:
    pwd_result = await _exec(environment, "pwd", "pwd failed")
    pwd_raw = _path_output(pwd_result, "pwd returned an empty path")
    realpath_command = f"realpath -- {shlex.quote(pwd_raw)}"
    realpath_result = await _exec(environment, realpath_command, "realpath failed")
    realpath = _path_output(realpath_result, "realpath returned an empty path")
    exists_command = f"test -d {shlex.quote(realpath)}"
    await _exec(environment, exists_command, "resolved path does not exist")
    return ResolvedCwd(pwd_raw=pwd_raw, realpath=realpath, exists=True)
