# input:  installed harness wheel, pinned Docker image, and scanner fixture
# output: unpaid stub-trial proxy, C2/C3, diff, and clean-scan proof
# pos:    Real Harbor container integration for artifact scanning
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import base64
import difflib
import inspect
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths

from cortex_bench_harness import CortexBenchAgent
from cortex_bench_harness.proxy import (
    ProxyBudget,
    TrialProxyHandle,
    fill_proxy_manifest,
    start_trial_proxy,
)
from cortex_bench_harness.scan.cli import main as scan_main

PROXY_TESTS = Path(__file__).resolve().parents[1] / "proxy"
sys.path.insert(0, str(PROXY_TESTS))
from synthetic import SyntheticUpstream  # noqa: E402

IMAGE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
IMAGE_REF = f"debian@{IMAGE_DIGEST}"
WHEEL_NAME = "cortex_bench_harness-0.1.0-py3-none-any.whl"
SYNTHETIC_CREDENTIAL = "sk-ant-SYNTHETIC-STUB-TRIAL"
ROOT_RUN_ID = "root-stub-scan"
TRIAL_ID = "trial-stub-scan"
MIN_FREE_BYTES = 10 * 1024**3
MAX_IMAGE_BYTES = 2 * 1024**3


@dataclass(frozen=True)
class Layout:
    root: Path
    repo_root: Path
    harness_dir: Path
    trial_paths: TrialPaths
    environment_dir: Path
    workspace: Path
    wheel_path: Path


@dataclass(frozen=True)
class TrialEvidence:
    proxy_requests: int
    trajectory_validation: dict[str, object]
    workspace_diff_bytes: int
    scan_report: dict[str, object]


def emit(event: str, **values: object) -> None:
    print(json.dumps({"event": event, **values}, sort_keys=True), flush=True)


def run_command(arguments: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments, check=False, capture_output=True, text=True, timeout=60, **kwargs,
    )


def resource_gate() -> int:
    result = run_command(["df", "-h", "/"])
    if result.returncode != 0:
        raise RuntimeError("df -h / failed")
    print(result.stdout, end="", flush=True)
    free_bytes = shutil.disk_usage("/").free
    if free_bytes < MIN_FREE_BYTES:
        raise RuntimeError("resource gate failed: less than 10 GiB free")
    return free_bytes


def inspect_image() -> dict[str, object]:
    result = run_command(["docker", "image", "inspect", IMAGE_REF])
    if result.returncode != 0:
        raise RuntimeError("pinned base image is not local; rerun disk gate before pulling it")
    image = json.loads(result.stdout)[0]
    size = image["Size"]
    if not isinstance(size, int) or size >= MAX_IMAGE_BYTES:
        raise RuntimeError("pinned base image is not under 2 GiB")
    return {"image_ref": IMAGE_REF, "image_digest": IMAGE_DIGEST, "image_size_bytes": size}


def image_inventory() -> set[str]:
    result = run_command(["docker", "image", "ls", "--no-trunc", "--quiet"])
    if result.returncode != 0:
        raise RuntimeError("docker image inventory failed")
    return set(result.stdout.splitlines())


def create_layout(root: Path) -> Layout:
    harness_dir = Path(__file__).resolve().parents[2]
    repo_root = harness_dir.parents[1]
    trial_paths = TrialPaths(root / "trial")
    trial_paths.mkdir()
    environment_dir = root / "environment"
    workspace = root / "workspace"
    environment_dir.mkdir()
    workspace.mkdir()
    return Layout(
        root, repo_root, harness_dir, trial_paths, environment_dir, workspace,
        harness_dir / "dist" / WHEEL_NAME,
    )


def create_environment(layout: Layout, session_id: str) -> DockerEnvironment:
    mounts: list[ServiceVolumeConfig] = [
        {"type": "bind", "source": str(layout.workspace), "target": "/app"},
        {
            "type": "bind", "source": str(layout.trial_paths.agent_dir),
            "target": "/logs/agent",
        },
        {
            "type": "bind", "source": str(layout.trial_paths.verifier_dir),
            "target": "/logs/verifier",
        },
        {
            "type": "bind", "source": str(layout.trial_paths.artifacts_dir),
            "target": "/logs/artifacts",
        },
    ]
    return DockerEnvironment(
        environment_dir=layout.environment_dir,
        environment_name="cortex-scan-stub",
        session_id=session_id,
        trial_paths=layout.trial_paths,
        task_env_config=EnvironmentConfig(docker_image=IMAGE_REF, workdir="/app"),
        mounts=mounts,
        extra_docker_compose=[Path(__file__).parent / "docker-compose-never-pull.yaml"],
    )


def trial_network(session_id: str) -> tuple[str, str]:
    names = run_command([
        "docker", "network", "ls", "--filter",
        f"label=com.docker.compose.project={session_id}", "--format", "{{.Name}}",
    ])
    network_names = names.stdout.splitlines()
    if names.returncode != 0 or len(network_names) != 1:
        raise RuntimeError("unable to resolve the Harbor trial network")
    result = run_command(["docker", "network", "inspect", network_names[0]])
    document = json.loads(result.stdout)[0]
    return _network_addresses(document)


def _network_addresses(document: dict[str, object]) -> tuple[str, str]:
    ipam = document["IPAM"]
    containers = document["Containers"]
    if not isinstance(ipam, dict) or not isinstance(containers, dict):
        raise RuntimeError("invalid Docker network metadata")
    gateway = ipam["Config"][0]["Gateway"]
    main = [item for item in containers.values() if "-main-" in item["Name"]]
    if len(main) != 1:
        raise RuntimeError("unable to resolve the Harbor main container")
    return str(gateway), str(main[0]["IPv4Address"]).split("/", 1)[0]


def assert_installed_package() -> None:
    objects = (CortexBenchAgent, start_trial_proxy, scan_main)
    paths = [Path(inspect.getfile(item)).resolve() for item in objects]
    if any("site-packages" not in path.parts for path in paths):
        raise RuntimeError("harness, proxy, and scanner must load from an installed wheel")


def create_agent(layout: Layout, image: dict[str, object], proxy) -> CortexBenchAgent:
    if not layout.wheel_path.is_file():
        raise FileNotFoundError(f"build the fixed wheel first: {layout.wheel_path.name}")
    return CortexBenchAgent(
        logs_dir=layout.trial_paths.agent_dir,
        artifact_dir=layout.trial_paths.artifacts_dir,
        extra_env={
            "ANTHROPIC_BASE_URL": proxy.base_url,
            "ANTHROPIC_AUTH_TOKEN": proxy.dummy_token,
        },
        manifest=_manifest_seed(layout, image),
    )


def _manifest_seed(layout: Layout, image: dict[str, object]) -> dict[str, object]:
    return {
        "root_run_id": ROOT_RUN_ID,
        "trial_id": TRIAL_ID,
        "arm": "cortex-direct-stub",
        "wheel_path": str(layout.wheel_path),
        "lockfile_path": str(layout.harness_dir / "uv.lock"),
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        **image,
    }


async def install_stub(environment: DockerEnvironment) -> None:
    payload = base64.b64encode((Path(__file__).parent / "stub_agent.sh").read_bytes()).decode()
    command = (
        f"printf %s {payload} | base64 -d > /usr/local/bin/cortex"
        " && chmod 0755 /usr/local/bin/cortex"
    )
    result = await environment.exec(command=command, user="root")
    if result.return_code != 0:
        raise RuntimeError("failed to install the container-side stub")


async def execute_agent(
    environment: DockerEnvironment, agent: CortexBenchAgent,
    manifest_path: Path, proxy: TrialProxyHandle,
) -> None:
    with environment.scoped_exec_env(agent.extra_env):
        await agent.setup(environment)
        fill_proxy_manifest(manifest_path, proxy)
        await agent.run("Complete the synthetic stub trial.", environment, AgentContext())


def assert_upstream_request(upstream: SyntheticUpstream) -> int:
    if len(upstream.requests) != 1:
        raise RuntimeError("stub trial did not make exactly one proxy request")
    headers = {key.lower(): value for key, value in upstream.requests[0].headers.items()}
    if headers.get("authorization") != f"Bearer {SYNTHETIC_CREDENTIAL}":
        raise RuntimeError("proxy did not inject the synthetic credential upstream")
    return len(upstream.requests)


def write_workspace_diff(layout: Layout) -> Path:
    solution = layout.workspace / "solution.txt"
    if not solution.is_file():
        raise RuntimeError("stub trial did not modify the workspace")
    lines = solution.read_text().splitlines(keepends=True)
    diff = difflib.unified_diff([], lines, fromfile="/dev/null", tofile="b/solution.txt")
    output = layout.trial_paths.artifacts_dir / "workspace.diff"
    output.write_text("".join(diff))
    if output.stat().st_size == 0:
        raise RuntimeError("workspace diff is empty")
    return output


def validate_trajectory(layout: Layout) -> dict[str, object]:
    tsx = layout.repo_root / "agent-server" / "node_modules" / ".bin" / "tsx"
    script = (
        "import {validateTrajectoryRoot} from './src/domain/agent-run/manifest.ts';"
        "const result=validateTrajectoryRoot(process.argv[1]);"
        "console.log(JSON.stringify(result));if(!result.ok)process.exit(1);"
    )
    result = run_command(
        [str(tsx), "--eval", script, str(layout.trial_paths.agent_dir / "trajectory")],
        cwd=layout.repo_root / "agent-server",
    )
    if result.returncode != 0:
        raise RuntimeError("C2/C3 validation failed")
    return json.loads(result.stdout.splitlines()[-1])


def write_scan_policy(layout: Layout, dummy_token: str) -> Path:
    document = {
        "secrets": {
            "synthetic_credential": SYNTHETIC_CREDENTIAL,
            "dummy_to_real_mapping": f"{dummy_token} -> {SYNTHETIC_CREDENTIAL}",
        },
        "repository_checkout": str(layout.repo_root),
        "hostname": socket.gethostname(),
    }
    path = layout.root / "scan-policy.json"
    path.write_text(json.dumps(document))
    return path


def scan_command(layout: Layout, policy_path: Path) -> list[str]:
    agent_dir = layout.trial_paths.agent_dir
    artifacts_dir = layout.trial_paths.artifacts_dir
    return [
        sys.executable, "-m", "cortex_bench_harness.scan",
        "--stdout-file", str(agent_dir / "stdout.txt"),
        "--stderr-file", str(agent_dir / "stderr.txt"),
        "--events-file", str(agent_dir / "trajectory" / "events.jsonl"),
        "--manifest-file", str(artifacts_dir / "cortex-bench-harness-manifest.json"),
        "--workspace-diff-file", str(artifacts_dir / "workspace.diff"),
        "--config-file", str(policy_path),
    ]


def run_scan(layout: Layout, policy_path: Path) -> dict[str, object]:
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    result = run_command(scan_command(layout, policy_path), env=environment)
    if result.returncode != 0:
        raise RuntimeError("artifact scan did not report clean")
    report = json.loads(result.stdout)
    expected = ["stdout", "stderr", "events", "manifest", "workspace_diff"]
    sources = [item.get("source") for item in report.get("sources", [])]
    if report.get("clean") is not True or sources != expected:
        raise RuntimeError("artifact scan omitted a required source")
    return report


async def run_trial(layout: Layout, image: dict[str, object]) -> TrialEvidence:
    session_id = f"cortex-scan-stub-{os.getpid()}"
    environment = create_environment(layout, session_id)
    proxy: TrialProxyHandle | None = None
    await environment.start(force_build=False)
    try:
        gateway, source_ip = trial_network(session_id)
        with SyntheticUpstream() as upstream:
            proxy = start_proxy(layout, upstream, gateway, source_ip)
            try:
                await install_stub(environment)
                agent = create_agent(layout, image, proxy)
                manifest = layout.trial_paths.artifacts_dir / "cortex-bench-harness-manifest.json"
                await execute_agent(environment, agent, manifest, proxy)
            finally:
                proxy.stop()
            request_count = assert_upstream_request(upstream)
    finally:
        await environment.stop(delete=True)
    if proxy is None:
        raise RuntimeError("trial proxy did not start")
    workspace_diff = write_workspace_diff(layout)
    validation = validate_trajectory(layout)
    policy_path = write_scan_policy(layout, proxy.dummy_token)
    report = run_scan(layout, policy_path)
    return TrialEvidence(request_count, validation, workspace_diff.stat().st_size, report)


def start_proxy(
    layout: Layout, upstream: SyntheticUpstream, gateway: str, source_ip: str,
) -> TrialProxyHandle:
    return start_trial_proxy(
        trial_id=TRIAL_ID,
        upstream_base_url=upstream.base_url,
        real_credential=SYNTHETIC_CREDENTIAL,
        bound_source_ip=source_ip,
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        budget=ProxyBudget(Decimal("1"), Decimal("1"), Decimal("0"), Decimal("0")),
        log_path=layout.trial_paths.agent_dir / "proxy.jsonl",
        listen_host=gateway,
        advertised_host=gateway,
    )


def main() -> None:
    free_bytes = resource_gate()
    image = inspect_image()
    before_images = image_inventory()
    assert_installed_package()
    with tempfile.TemporaryDirectory(prefix="cortex-bench-stub-scan-") as temp_dir:
        evidence = asyncio.run(run_trial(create_layout(Path(temp_dir)), image))
    after_images = image_inventory()
    if after_images != before_images:
        raise RuntimeError("stub trial changed the Docker image inventory")
    emit("resource_gate", free_bytes=free_bytes, minimum_bytes=MIN_FREE_BYTES)
    emit("container_image", **image, pull_policy="never", pulls_performed=0)
    emit("proxy", request_count=evidence.proxy_requests, synthetic_upstream=True)
    emit("trajectory", validation=evidence.trajectory_validation)
    emit("workspace", modified=True, diff_bytes=evidence.workspace_diff_bytes)
    emit("scan", return_code=0, report=evidence.scan_report)
    emit("image_inventory", before=len(before_images), after=len(after_images), new=len(after_images - before_images))
    emit(
        "scope", stub_agent_trial=True,
        real_cortex_agent_run="deferred to parent integration",
        paid_model_calls=0,
    )


if __name__ == "__main__":
    main()
