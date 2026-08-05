# input:  Docker CLI, pinned Debian image, raw HTTP request data
# output: isolated bridge fixtures and real-container command results
# pos:    Docker containment test support
# >>> If I am updated, update my header and folder CORTEX.md <<<

import ipaddress
import json
import shlex
import subprocess
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Mapping
from urllib.parse import urlsplit

IMAGE = "debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"


@dataclass(frozen=True)
class TrialNetwork:
    name: str
    gateway: str
    trial_ip: str
    attacker_ip: str


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args], check=check, capture_output=True, text=True, timeout=15,
    )


def inspect_network(name: str) -> TrialNetwork:
    document = json.loads(docker("network", "inspect", name).stdout)[0]
    config = document["IPAM"]["Config"][0]
    subnet = ipaddress.ip_network(config["Subnet"])
    trial_ip = str(subnet.network_address + 10)
    attacker_ip = str(subnet.network_address + 11)
    return TrialNetwork(name, config["Gateway"], trial_ip, attacker_ip)


@contextmanager
def internal_network() -> Iterator[TrialNetwork]:
    with _network(internal=True) as network:
        yield network


@contextmanager
def external_network() -> Iterator[TrialNetwork]:
    with _network(internal=False) as network:
        yield network


@contextmanager
def _network(*, internal: bool) -> Iterator[TrialNetwork]:
    name = f"cortex-proxy-{uuid.uuid4().hex[:12]}"
    arguments = ["network", "create", "--driver", "bridge"]
    if internal:
        arguments.append("--internal")
    docker(*arguments, name)
    try:
        yield inspect_network(name)
    finally:
        docker("network", "rm", name, check=False)


def run_container(
    network: TrialNetwork,
    source_ip: str,
    script: str,
    env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    command = ["run", "--rm", "--pull=never", "--network", network.name]
    command.extend(["--ip", source_ip])
    for key, value in (env or {}).items():
        command.extend(["--env", f"{key}={value}"])
    command.extend([IMAGE, "/bin/bash", "-c", script])
    return docker(*command, check=False)


def raw_proxy_request(
    network: TrialNetwork, source_ip: str, base_url: str, token: str,
) -> subprocess.CompletedProcess[str]:
    target = urlsplit(base_url)
    payload = '{"model":"claude-synthetic-1","prompt":"container-call"}'
    request = _http_request(target.hostname or "", token, payload)
    script = _request_script(target.hostname or "", target.port or 80, request)
    return run_container(network, source_ip, script)


def _http_request(host: str, token: str, payload: str) -> str:
    lines = [
        "POST /v1/messages?beta=true HTTP/1.1", f"Host: {host}",
        f"Authorization: Bearer {token}", "Content-Type: application/json",
        f"Content-Length: {len(payload.encode())}", "Connection: close", "", payload,
    ]
    return "\r\n".join(lines)


def _request_script(host: str, port: int, request: str) -> str:
    return (
        f"exec 3<>/dev/tcp/{shlex.quote(host)}/{port}; "
        f"printf %s {shlex.quote(request)} >&3; cat <&3"
    )
