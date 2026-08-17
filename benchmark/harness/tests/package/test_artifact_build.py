# input:  artifact builder, concurrent callers and temporary output roots
# output: checkout-scoped npm pack serialization assertions
# pos:    Regression tests for concurrent artifact builds
# >>> If I am updated, update my header and folder CORTEX.md <<<

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock

from cortex_bench_harness import artifact_build


def test_same_checkout_pack_builds_are_serialized(monkeypatch, tmp_path: Path) -> None:
    first_pack_entered = Event()
    second_pack_entered = Event()
    release_first_pack = Event()
    state_lock = Lock()
    pack_calls = 0

    def controlled_run(
        command: list[str], _cwd: Path, _environment: dict[str, str],
    ) -> None:
        nonlocal pack_calls
        if command[:2] != ["npm", "pack"]:
            return
        with state_lock:
            pack_calls += 1
            call_number = pack_calls
        if call_number == 1:
            first_pack_entered.set()
            assert release_first_pack.wait(timeout=2)
        else:
            second_pack_entered.set()
        destination = Path(command[command.index("--pack-destination") + 1])
        (destination / f"cortex-agent-server-{call_number}.tgz").write_bytes(b"artifact")

    monkeypatch.setattr(artifact_build, "_run", controlled_run)
    checkout = tmp_path / "checkout"
    (checkout / "agent-server").mkdir(parents=True)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            artifact_build.build_offline_npm_artifact, checkout, tmp_path / "first",
        )
        assert first_pack_entered.wait(timeout=2)
        second = executor.submit(
            artifact_build.build_offline_npm_artifact, checkout, tmp_path / "second",
        )
        overlapped = second_pack_entered.wait(timeout=0.25)
        release_first_pack.set()
        artifacts = {first.result(timeout=2).name, second.result(timeout=2).name}

    assert not overlapped
    assert artifacts == {"cortex-agent-server-1.tgz", "cortex-agent-server-2.tgz"}
