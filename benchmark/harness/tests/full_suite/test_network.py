# input:  run-owned Docker slot with an attached container
# output: container-before-network cleanup ordering proof
# pos:    Full-suite network cleanup tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import subprocess

from cortex_bench_harness.full_suite.network import NetworkSlot, remove_networks


def test_cleanup_forces_attached_run_container_before_network_removal() -> None:
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        stdout = '{"container-one": {}}' if command[1:3] == ["network", "inspect"] else ""
        return subprocess.CompletedProcess(command, 0, stdout, "")

    slot = NetworkSlot(0, "run-slot-0", "172.30.240.0/24", "172.30.240.1", "172.30.240.2")
    remove_networks((slot,), run_command=run)

    assert commands == [
        ["docker", "network", "inspect", "run-slot-0", "--format", "{{json .Containers}}"],
        ["docker", "rm", "--force", "container-one"],
        ["docker", "network", "rm", "run-slot-0"],
    ]
