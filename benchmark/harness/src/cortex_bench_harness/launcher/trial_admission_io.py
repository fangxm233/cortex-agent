# input:  image metadata, env values, egress options, Docker runtime
# output: isolated commands, sealed Docker policy overlays, per-slot CPU pin overlay
# pos:    Admission IO and deterministic serialization primitives
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import os
import re
import shlex
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, override

from harbor.environments.docker.docker import DockerEnvironment


ENDPOINT_FILTER_MARK = 114514
ENDPOINT_FILTER_TABLE = "cortex_proxy_endpoint"
# gost's own table is `gost_egress` at filter priority 0, and it is torn down entirely when the
# policy widens to PUBLIC (`network-policy allow-all` runs `nft delete table inet gost_egress`).
# Ours are separate tables at higher priorities, so they survive that teardown -- which is what
# makes a denylist-only trial possible at all.
DENYLIST_FILTER_TABLE = "cortex_network_denylist"
MAIN_SERVICE_NAME = "main"
# Docker's cpuset syntax: single cores and ranges, comma separated ("0-7", "0,2,4").
CPUSET_PATTERN = re.compile(r"\d+(-\d+)?(,\d+(-\d+)?)*")


class HarborTrialAdmissionError(ValueError):
    """The final Harbor construction cannot enforce the standalone boundary."""


def cpuset_for_slot(index: int, slots: int, *, cores: int | None = None) -> str:
    """The fixed host CPU range that concurrency slot `index` owns.

    The host is divided once, evenly, and a slot keeps its share whether or not its neighbours
    are busy -- so a trial's machine is the same machine on a quiet host and a saturated one.
    Cores past the last whole share stay idle on purpose: identical slots are worth more here
    than the last few percent of the host, because the numbers being compared are wall-clock.
    """
    if slots < 1 or not 0 <= index < slots:
        raise HarborTrialAdmissionError(f"concurrency slot {index} is outside {slots} slots")
    total = (os.cpu_count() or 0) if cores is None else cores
    width = total // slots
    if width < 1:
        raise HarborTrialAdmissionError(
            f"host has {total} CPUs, too few to give each of {slots} concurrent trials one")
    start = index * width
    return f"{start}-{start + width - 1}"


class PullDisabledDockerEnvironment(DockerEnvironment):
    def __init__(
        self, *args: object, external_network_name: str | None = None,
        proxy_host: str | None = None, container_ipv4: str | None = None,
        cpuset: str | None = None, **kwargs: Any,
    ) -> None:
        self._pull_policy_directory = tempfile.TemporaryDirectory()
        root = Path(self._pull_policy_directory.name)
        self._pull_policy_path = root / "pull-policy.json"
        self._external_network_path = root / "external-network.json"
        self._proxy_host_path = root / "proxy-host.json"
        self._container_address_path = root / "container-address.json"
        self._cpuset_path = root / "cpuset.json"
        # Harbor decides in its own `__init__` whether an egress sidecar exists, and that decision
        # is what every overlay below has to address. So construct first, then write.
        super().__init__(*args, **kwargs)
        self._write_network_overlays(external_network_name, proxy_host, container_ipv4)
        self._write_cpuset_overlay(cpuset)

    def _network_namespace_service(self) -> str:
        """The service that holds this trial's network namespace.

        With egress control on, Harbor puts every other service into
        `network_mode: service:<sidecar>`, so the sidecar owns the namespace and `main` shares it.
        With it off, no sidecar is built at all and `main` owns its own. Overlays that configure
        the trial's network, and commands that must run inside it, address whichever it is rather
        than naming one and being wrong half the time.
        """
        if self._enable_egress_control:
            return self._EGRESS_CONTROL_SERVICE_NAME
        return MAIN_SERVICE_NAME

    def _write_network_overlays(
        self, external_network_name: str | None, proxy_host: str | None,
        container_ipv4: str | None,
    ) -> None:
        service = self._network_namespace_service()
        # Naming a service in an override file defines it, so the sidecar may only be mentioned
        # when it is really part of the project.
        document = {"services": {MAIN_SERVICE_NAME: {"pull_policy": "never"}}}
        document["services"][service] = {"pull_policy": "never"}
        self._pull_policy_path.write_text(json.dumps(document))
        if external_network_name is not None:
            self._external_network_path.write_text(json.dumps({
                "networks": {"default": {
                    "external": True, "name": external_network_name,
                }},
            }))
        if proxy_host is not None:
            self._proxy_host_path.write_text(json.dumps({
                "services": {service: {
                    "extra_hosts": [f"{proxy_host}:host-gateway"],
                }},
            }))
        if container_ipv4 is not None:
            # Only the namespace holder is a member of the trial's network, so pinning it pins the
            # source address every request to the credential route will carry. Declared here rather
            # than predicted from Docker's allocation order, because concurrent trials each hold a
            # different subnet.
            self._container_address_path.write_text(json.dumps({
                "services": {service: {
                    "networks": {"default": {"ipv4_address": container_ipv4}},
                }},
            }))

    def declared_cpuset(self) -> str | None:
        """The host CPU range this trial owns, or None when it was launched unpinned."""
        return self._cpuset

    def _write_cpuset_overlay(self, cpuset: str | None) -> None:
        """Pin this trial to the host cores its concurrency slot owns.

        Harbor exports the task's declared `cpus` to Compose and then no shipped template reads
        it, so a prebuilt-image trial gets the whole host. Several tasks assert against a
        wall-clock threshold measured inside the container; run several unbounded containers at
        once and that assertion measures how busy the host was, not what the agent wrote.

        The pin is per slot rather than per task, so every trial of every arm on a given host gets
        the same machine no matter which task it drew -- a comparison stays a comparison. It also
        makes `nproc` inside the container tell the truth, which is what build parallelism reads.
        """
        self._cpuset = cpuset
        if cpuset is None:
            return
        if not CPUSET_PATTERN.fullmatch(cpuset):
            raise HarborTrialAdmissionError(f"trial cpuset is not a CPU list: {cpuset!r}")
        # Service-level `cpuset`, not `deploy.resources`: the latter is only honored under swarm,
        # and silently doing nothing is the failure mode being removed here.
        self._cpuset_path.write_text(
            json.dumps({"services": {MAIN_SERVICE_NAME: {"cpuset": cpuset}}}))

    @property
    @override
    def _docker_compose_paths(self) -> list[Path]:
        paths = [*super()._docker_compose_paths, self._pull_policy_path]
        for overlay in (
            self._external_network_path, self._proxy_host_path,
            self._container_address_path, self._cpuset_path,
        ):
            if overlay.is_file():
                paths.append(overlay)
        return paths

    async def _install_namespace_filter(self, table: str, rules: str) -> None:
        """Install one nftables table inside the trial's network namespace.

        Refuses when no sidecar exists rather than exec-ing into `main`: the task image is a
        benchmark runtime that need not carry `nft` at all, so the failure would be a confusing
        one about a missing binary instead of a clear one about the topology.
        """
        if not self._enable_egress_control:
            raise HarborTrialAdmissionError(
                f"cannot install {table}: this trial has no egress sidecar to hold the rules")
        await self._run_docker_compose_command(
            ["exec", "--no-TTY", self._EGRESS_CONTROL_SERVICE_NAME,
             "nft", "--file", "-"], stdin_data=rules.encode(),
        )

    async def _install_proxy_endpoint_filter(self, port: int) -> None:
        rules = (
            f"table inet {ENDPOINT_FILTER_TABLE} {{\n"
            "  chain output {\n"
            "    type filter hook output priority 1; policy accept;\n"
            f"    meta mark {ENDPOINT_FILTER_MARK} tcp dport {port} accept\n"
            f"    meta mark {ENDPOINT_FILTER_MARK} reject\n"
            "  }\n"
            "}\n"
        )
        await self._install_namespace_filter(ENDPOINT_FILTER_TABLE, rules)

    async def _install_denylist_filter(
        self, ipv4: Sequence[str], ipv6: Sequence[str],
    ) -> None:
        """Reject traffic to the addresses a campaign's denylist resolved to.

        Priority 2 puts this after gost's own table (0) and the proxy endpoint filter (1), and in
        a separate table so `network-policy allow-all` -- which deletes only `gost_egress` -- does
        not take it with it. An empty family emits no rule at all, because nftables has no syntax
        for an empty anonymous set.
        """
        if not ipv4 and not ipv6:
            return
        lines = [
            f"table inet {DENYLIST_FILTER_TABLE} {{",
            "  chain output {",
            "    type filter hook output priority 2; policy accept;",
        ]
        if ipv4:
            lines.append(f"    ip daddr {{ {', '.join(ipv4)} }} reject")
        if ipv6:
            lines.append(f"    ip6 daddr {{ {', '.join(ipv6)} }} reject")
        lines.extend(["  }", "}", ""])
        await self._install_namespace_filter(DENYLIST_FILTER_TABLE, "\n".join(lines))

    @override
    async def stop(self, delete: bool) -> None:
        try:
            await super().stop(delete=delete)
        finally:
            self._pull_policy_directory.cleanup()


def redact_mount_sources(
    mounts: list[dict[str, object]],
) -> list[dict[str, object]]:
    evidence = []
    for mount in mounts:
        source = mount.get("source")
        if not isinstance(source, str) or not source:
            raise HarborTrialAdmissionError("mount source must be a non-empty string")
        record = {key: value for key, value in mount.items() if key != "source"}
        record["source_sha256"] = hashlib.sha256(source.encode()).hexdigest()
        evidence.append(record)
    return evidence


def environment_digest(environment: Mapping[str, str]) -> str:
    payload = json.dumps(
        dict(sorted(environment.items())), sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def isolated_command(command: str, environment: Mapping[str, str]) -> str:
    assignments = " ".join(
        f"{key}={shlex.quote(value)}" for key, value in sorted(environment.items())
    )
    return f"exec env -i {assignments} /bin/bash -c {shlex.quote(command)}"


def atomic_write_json(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _parse_image_environment_entry(entry: object) -> tuple[str, str]:
    if not isinstance(entry, str) or "=" not in entry:
        raise HarborTrialAdmissionError("image environment is not a KEY=value list")
    key, value = entry.split("=", 1)
    if not key:
        raise HarborTrialAdmissionError("image environment contains an empty key")
    return key, value


def parse_image_configuration(
    source: str,
) -> tuple[dict[str, str], frozenset[str]]:
    try:
        document = json.loads(source)
    except json.JSONDecodeError as error:
        raise HarborTrialAdmissionError("image configuration probe returned invalid JSON") from error
    if not isinstance(document, Mapping):
        raise HarborTrialAdmissionError("image configuration probe did not return a mapping")
    environment = document.get("Env") or []
    volumes = document.get("Volumes") or {}
    if not isinstance(environment, list) or not isinstance(volumes, Mapping):
        raise HarborTrialAdmissionError("image configuration has unsupported fields")
    entries = dict(_parse_image_environment_entry(entry) for entry in environment)
    if len(entries) != len(environment):
        raise HarborTrialAdmissionError("image environment contains duplicate keys")
    if not all(isinstance(target, str) for target in volumes):
        raise HarborTrialAdmissionError("image volumes must name string targets")
    return entries, frozenset(volumes)


def inspect_image_configuration(
    image_ref: str,
) -> tuple[dict[str, str], frozenset[str]]:
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .Config}}", image_ref],
            check=True, capture_output=True, text=True, timeout=10,
        )
    except Exception as error:
        raise HarborTrialAdmissionError(
            "pinned image configuration cannot be inspected without pulling"
        ) from error
    return parse_image_configuration(result.stdout)
