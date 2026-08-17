# input:  artifact builder, file locks and temporary output roots
# output: deterministic checkout pack serialization assertions
# pos:    Regression tests for concurrent artifact builds
# >>> If I am updated, update my header and folder CORTEX.md <<<

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock
from typing import IO

from cortex_bench_harness import artifact_build


class PackController:
    def __init__(self) -> None:
        self.first_pack_entered = Event()
        self.second_pack_entered = Event()
        self.second_lock_attempted = Event()
        self.release_first_pack = Event()
        self._state_lock = Lock()
        self._pack_calls = 0
        self._lock_attempts = 0
        self._flock = artifact_build.fcntl.flock

    def flock(self, lock_file: int | IO[str], operation: int) -> None:
        with self._state_lock:
            self._lock_attempts += 1
            attempt = self._lock_attempts
        if attempt == 2:
            self.second_lock_attempted.set()
        self._flock(lock_file, operation)

    def run(self, command: list[str], _cwd: Path, _environment: dict[str, str]) -> None:
        if command[:2] != ["npm", "pack"]:
            return
        with self._state_lock:
            self._pack_calls += 1
            call_number = self._pack_calls
        if call_number == 1:
            self.first_pack_entered.set()
            assert self.release_first_pack.wait(timeout=5)
        else:
            self.second_pack_entered.set()
        destination = Path(command[command.index("--pack-destination") + 1])
        (destination / f"cortex-agent-server-{call_number}.tgz").write_bytes(b"artifact")


def test_same_checkout_pack_builds_are_serialized(monkeypatch, tmp_path: Path) -> None:
    controller = PackController()
    monkeypatch.setattr(artifact_build, "_run", controller.run)
    monkeypatch.setattr(artifact_build.fcntl, "flock", controller.flock)
    checkout = tmp_path / "checkout"
    (checkout / "agent-server").mkdir(parents=True)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            artifact_build.build_offline_npm_artifact, checkout, tmp_path / "first",
        )
        assert controller.first_pack_entered.wait(timeout=5)
        second = executor.submit(
            artifact_build.build_offline_npm_artifact, checkout, tmp_path / "second",
        )
        assert controller.second_lock_attempted.wait(timeout=5)
        overlapped = controller.second_pack_entered.wait(timeout=0.25)
        controller.release_first_pack.set()
        artifacts = {first.result(timeout=5).name, second.result(timeout=5).name}

    assert not overlapped
    assert artifacts == {"cortex-agent-server-1.tgz", "cortex-agent-server-2.tgz"}
