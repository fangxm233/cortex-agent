# input:  one task, isolated proxy handle, fixed network slot, mounted runtimes
# output: private PI config, single-task Harbor job and allowlisted child env
# pos:    Full-suite Harbor job materializer
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path

from .config import HostInputs, SuiteSpec

CHILD_ENV_ALLOWLIST = (
    "DOCKER_HOST", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "XDG_RUNTIME_DIR",
)


def write_pi_config(
    spec: SuiteSpec, root: Path, proxy_base_url: str, dummy_token: str,
) -> None:
    root.mkdir(parents=True, mode=0o700, exist_ok=False)
    root.chmod(0o700)
    auth = {"deepseek": {"type": "api_key", "key": dummy_token}}
    provider = {
        "api": "openai-completions", "apiKey": dummy_token,
        "baseUrl": f"{proxy_base_url}/v1",
        "models": [{
            "id": spec.model, "name": spec.model, "reasoning": False,
            "input": ["text"], "contextWindow": 1_000_000,
            "maxTokens": spec.max_output_tokens,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        }],
    }
    _write_json(root / "auth.json", auth, 0o600)
    _write_json(root / "models.json", {"providers": {"deepseek": provider}}, 0o600)


def build_task_job(
    spec: SuiteSpec, inputs: HostInputs, *, task_id: str, task_path: Path,
    task_root: Path, pi_config: Path, proxy_host: str, network_name: str,
    container_ipv4: str, cpuset: str | None = None,
) -> dict[str, object]:
    return {
        "job_name": f"{spec.suite}-{task_id}",
        "jobs_dir": str(task_root / "harbor-results"),
        "n_attempts": spec.attempts,
        "n_concurrent_trials": 1,
        "quiet": True,
        "retry": {"max_retries": spec.harbor_retries},
        "environment": _environment(
            inputs, pi_config, proxy_host, network_name, container_ipv4, cpuset),
        "agents": [_agent(spec, proxy_host)],
        "tasks": [{"path": str(task_path)}],
    }


def write_job(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(path, document, 0o600)


def build_child_environment(
    parent: Mapping[str, str], *, source_root: Path,
) -> dict[str, str]:
    environment = {
        name: parent[name] for name in CHILD_ENV_ALLOWLIST
        if name in parent and parent[name]
    }
    environment["PYTHONPATH"] = str(source_root)
    return dict(sorted(environment.items()))


def harbor_command(harbor: Path, job_path: Path) -> list[str]:
    return [str(harbor), "run", "--config", str(job_path), "--yes"]


def _environment(
    inputs: HostInputs, pi_config: Path, proxy_host: str,
    network_name: str, container_ipv4: str, cpuset: str | None,
) -> dict[str, object]:
    kwargs: dict[str, object] = {
        "external_network_name": network_name,
        "proxy_host": proxy_host,
        "container_ipv4": container_ipv4,
    }
    if cpuset is not None:
        kwargs["cpuset"] = cpuset
    return {
        "import_path": (
            "cortex_bench_harness.launcher.trial_admission_io:"
            "PullDisabledDockerEnvironment"
        ),
        "mounts": _mounts(inputs, pi_config),
        "extra_allowed_hosts": [proxy_host],
        "kwargs": kwargs,
    }


def _mounts(inputs: HostInputs, pi_config: Path) -> list[dict[str, object]]:
    sources = (
        (pi_config, "/opt/cortex-bench-pi-config"),
        (inputs.node_root, "/opt/cortex-bench-node"),
        (inputs.pi_root, "/opt/cortex-bench-pi-runtime"),
    )
    return [
        {"type": "bind", "source": str(source), "target": target, "read_only": True}
        for source, target in sources
    ]


def _agent(spec: SuiteSpec, proxy_host: str) -> dict[str, object]:
    return {
        "import_path": "cortex_bench_harness.full_suite.pi_agent:MountedContainedPi",
        "model_name": f"deepseek/{spec.model}",
        "kwargs": {"version": spec.pi_version},
        "env": {
            "PI_CODING_AGENT_DIR": "/opt/cortex-bench-pi-config",
            "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
        },
        "extra_allowed_hosts": [proxy_host],
    }


def _write_json(path: Path, document: object, mode: int) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
