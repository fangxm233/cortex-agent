# input:  committed subnet pool, run identity and Docker CLI
# output: fixed per-worker bridge networks and container source addresses
# pos:    Full-suite Docker slot allocator
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import ipaddress
import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass

from .config import SuiteSpec


@dataclass(frozen=True)
class NetworkSlot:
    index: int
    name: str
    subnet: str
    gateway: str
    container_ipv4: str


def network_slots(spec: SuiteSpec, run_name: str) -> tuple[NetworkSlot, ...]:
    pool = ipaddress.IPv4Network(spec.subnet_pool)
    subnets = list(pool.subnets(new_prefix=spec.subnet_prefix))
    if spec.concurrency > len(subnets):
        raise ValueError("suite concurrency exceeds declared network slots")
    prefix = re.sub(r"[^a-zA-Z0-9_.-]", "-", run_name)[:40]
    return tuple(
        NetworkSlot(
            index, f"cortex-{prefix}-slot-{index}", str(subnet),
            str(subnet.network_address + 1), str(subnet.network_address + 2),
        )
        for index, subnet in enumerate(subnets[:spec.concurrency])
    )


def create_networks(
    slots: tuple[NetworkSlot, ...], *,
    run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> None:
    created: list[NetworkSlot] = []
    try:
        for slot in slots:
            _create(slot, run_command)
            created.append(slot)
    except BaseException:
        remove_networks(tuple(created), run_command=run_command)
        raise


def remove_networks(
    slots: tuple[NetworkSlot, ...], *,
    run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> None:
    failures = []
    for slot in reversed(slots):
        if not _remove_attached_containers(slot, run_command):
            failures.append(f"{slot.name}:containers")
            continue
        result = run_command(
            ["docker", "network", "rm", slot.name],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            failures.append(slot.name)
    if failures:
        raise RuntimeError(f"run-owned Docker networks did not stop: {failures}")


def _remove_attached_containers(
    slot: NetworkSlot, run_command: Callable[..., subprocess.CompletedProcess[str]],
) -> bool:
    inspect = run_command(
        ["docker", "network", "inspect", slot.name, "--format", "{{json .Containers}}"],
        capture_output=True, text=True, check=False,
    )
    if inspect.returncode != 0:
        return False
    containers = json.loads(inspect.stdout or "{}") or {}
    results = [
        run_command(
            ["docker", "rm", "--force", container_id],
            capture_output=True, text=True, check=False,
        )
        for container_id in sorted(containers)
    ]
    return all(result.returncode == 0 for result in results)


def _create(
    slot: NetworkSlot,
    run_command: Callable[..., subprocess.CompletedProcess[str]],
) -> None:
    command = [
        "docker", "network", "create", "--driver", "bridge",
        "--subnet", slot.subnet, "--gateway", slot.gateway, slot.name,
    ]
    result = run_command(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"cannot create Docker network {slot.name}")
