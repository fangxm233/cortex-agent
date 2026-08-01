# input:  Harbor ExecResult values and cwd resolver
# output: dynamic path and fail-closed regression assertions
# pos:    Contract tests for container-side cwd discovery
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
from collections.abc import Sequence

import pytest
from harbor.environments.base import ExecResult

from cortex_bench_harness.cwd import WorkdirResolutionError, resolve_task_workdir


class FakeEnvironment:
    def __init__(self, results: Sequence[ExecResult]) -> None:
        self._results = iter(results)
        self.commands: list[str] = []

    async def exec(self, command: str, **_kwargs: object) -> ExecResult:
        self.commands.append(command)
        return next(self._results)


def result(stdout: str | None = None, return_code: int = 0) -> ExecResult:
    return ExecResult(stdout=stdout, return_code=return_code)


def test_resolves_pwd_with_realpath_and_exists_probe() -> None:
    environment = FakeEnvironment([result("/app\n"), result("/app\n"), result()])

    resolved = asyncio.run(resolve_task_workdir(environment))

    assert resolved.pwd_raw == "/app"
    assert resolved.realpath == "/app"
    assert resolved.exists is True
    assert environment.commands == ["pwd", "realpath -- /app", "test -d /app"]


def test_preserves_trailing_space_in_container_path() -> None:
    path = "/app-with-trailing-space "
    environment = FakeEnvironment([result(f"{path}\n"), result(f"{path}\n"), result()])

    resolved = asyncio.run(resolve_task_workdir(environment))

    assert resolved.pwd_raw == path
    assert resolved.realpath == path
    assert environment.commands == [
        "pwd",
        "realpath -- '/app-with-trailing-space '",
        "test -d '/app-with-trailing-space '",
    ]


@pytest.mark.parametrize(
    ("results", "message"),
    [
        ([result(return_code=1)], "pwd failed"),
        ([result("\n")], "pwd returned an empty path"),
        ([result("/app\n"), result(return_code=1)], "realpath failed"),
        ([result("/app\n"), result("/app\n"), result(return_code=1)], "does not exist"),
    ],
)
def test_resolution_failures_are_closed(
    results: Sequence[ExecResult], message: str
) -> None:
    with pytest.raises(WorkdirResolutionError, match=message):
        asyncio.run(resolve_task_workdir(FakeEnvironment(results)))
