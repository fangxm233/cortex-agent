# input:  image metadata, env values, launch evidence, Docker runtime
# output: isolated commands and pull/endpoint-confined Docker mixin
# pos:    Admission IO and deterministic serialization primitives
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import os
import shlex
import subprocess
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any, override

from harbor.environments.docker.docker import DockerEnvironment


ENDPOINT_FILTER_MARK = 114514
ENDPOINT_FILTER_TABLE = "cortex_proxy_endpoint"


class HarborTrialAdmissionError(ValueError):
    """The final Harbor construction cannot enforce the standalone boundary."""


class PullDisabledDockerEnvironment(DockerEnvironment):
    def __init__(self, *args: object, **kwargs: Any) -> None:
        self._pull_policy_directory = tempfile.TemporaryDirectory()
        self._pull_policy_path = Path(self._pull_policy_directory.name) / "pull-policy.json"
        document = {"services": {
            "main": {"pull_policy": "never"},
            self._EGRESS_CONTROL_SERVICE_NAME: {"pull_policy": "never"},
        }}
        self._pull_policy_path.write_text(json.dumps(document))
        super().__init__(*args, **kwargs)

    @property
    @override
    def _docker_compose_paths(self) -> list[Path]:
        return [*super()._docker_compose_paths, self._pull_policy_path]

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
        await self._run_docker_compose_command(
            ["exec", "--no-TTY", self._EGRESS_CONTROL_SERVICE_NAME,
             "nft", "--file", "-"], stdin_data=rules.encode(),
        )

    @override
    async def stop(self, delete: bool) -> None:
        try:
            await super().stop(delete=delete)
        finally:
            self._pull_policy_directory.cleanup()


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
