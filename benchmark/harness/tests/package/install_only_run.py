# input:  fixed wheel, Harbor DockerEnvironment, pinned Debian image
# output: real-container setup transcript and H3 manifest
# pos:    Unpaid install-only integration proof
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import base64
import inspect
import json
import logging
import os
import shlex
import subprocess
import tempfile
from pathlib import Path

from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths

from cortex_bench_harness import CortexBenchAgent

IMAGE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
IMAGE_REF = f"debian@{IMAGE_DIGEST}"
WHEEL_NAME = "cortex_bench_harness-0.1.0-py3-none-any.whl"


def emit(event: str, **values: object) -> None:
    print(json.dumps({"event": event, **values}, sort_keys=True), flush=True)


def inspect_image() -> dict[str, object]:
    result = subprocess.run(
        ["docker", "image", "inspect", IMAGE_REF],
        check=True,
        capture_output=True,
        text=True,
    )
    image = json.loads(result.stdout)[0]
    return {
        "image_ref": IMAGE_REF,
        "image_digest": IMAGE_DIGEST,
        "image_size_bytes": image["Size"],
    }


def create_environment(root: Path) -> DockerEnvironment:
    trial_paths = TrialPaths(root / "trial")
    trial_paths.mkdir()
    environment_dir = root / "environment"
    environment_dir.mkdir()
    task_root = root / "task-root"
    task_root.mkdir()
    mounts: list[ServiceVolumeConfig] = [
        {"type": "bind", "source": str(task_root), "target": "/app"}
    ]
    return DockerEnvironment(
        environment_dir=environment_dir,
        environment_name="cortex-bench-install-only",
        session_id=f"cortex-bench-install-only-{os.getpid()}",
        trial_paths=trial_paths,
        task_env_config=EnvironmentConfig(docker_image=IMAGE_REF, workdir="/app"),
        mounts=mounts,
    )


async def install_stub(environment: DockerEnvironment) -> None:
    stub = "#!/bin/sh\nprintf '%s\\n' 'cortex install-only stub 0.0.0'\n"
    payload = base64.b64encode(stub.encode()).decode()
    command = (
        f"printf %s {shlex.quote(payload)} | base64 -d > /usr/local/bin/cortex"
        " && chmod 0755 /usr/local/bin/cortex && cortex --version"
    )
    result = await environment.exec(command=command, user="root")
    emit(
        "container_exec",
        command=command,
        return_code=result.return_code,
        stdout=result.stdout,
        stderr=result.stderr,
    )
    if result.return_code != 0:
        raise RuntimeError("failed to install the container-side stub")


def create_agent(root: Path, image: dict[str, object]) -> CortexBenchAgent:
    harness_dir = Path(__file__).resolve().parents[2]
    wheel_path = harness_dir / "dist" / WHEEL_NAME
    if not wheel_path.is_file():
        raise FileNotFoundError(f"build the fixed wheel first: {wheel_path}")
    import_file = Path(inspect.getfile(CortexBenchAgent)).resolve()
    if "site-packages" not in import_file.parts:
        raise RuntimeError(f"wrapper was not imported from an installed wheel: {import_file}")
    return CortexBenchAgent(
        logs_dir=root / "trial" / "agent",
        artifact_dir=root / "trial" / "artifacts",
        manifest={
            "root_run_id": "root-install-only",
            "trial_id": "trial-install-only",
            "arm": "cortex-direct",
            "wheel_path": str(wheel_path),
            "lockfile_path": str(harness_dir / "uv.lock"),
            "lockfile_manifest_path": "benchmark/harness/uv.lock",
            **image,
        },
    )


def assert_install_result(argv: list[str], document: dict[str, object]) -> None:
    cwd_index = argv.index("--cwd")
    events_index = argv.index("--events-file")
    root_index = argv.index("--trajectory-root")
    assert argv[cwd_index + 1] == "/app"
    assert argv[events_index + 1].startswith(argv[root_index + 1] + "/")
    assert document["resolved_cwd"] == {
        "pwd_raw": "/app", "realpath": "/app", "exists": True,
    }
    assert document["cortex_cli"] == {"version": None}


async def run_install_only(root: Path) -> None:
    image = inspect_image()
    assert isinstance(image["image_size_bytes"], int)
    assert image["image_size_bytes"] < 2 * 1024**3
    emit("container_image", **image)
    environment = create_environment(root)
    try:
        await environment.start(force_build=False)
        await install_stub(environment)
        agent = create_agent(root, image)
        emit(
            "harbor_wrapper",
            import_file=inspect.getfile(CortexBenchAgent),
            mro=[f"{item.__module__}.{item.__name__}" for item in type(agent).__mro__],
        )
        await agent.setup(environment)
        argv = agent.preview_run_argv()
        emit("agent_run_argv", argv=argv)
        manifest_path = root / "trial" / "artifacts" / "cortex-bench-harness-manifest.json"
        document = json.loads(manifest_path.read_text())
        assert_install_result(argv, document)
        emit("manifest", document=document)
    finally:
        await environment.stop(delete=False)
        emit("container_stopped", delete=False)


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    with tempfile.TemporaryDirectory(prefix="cortex-bench-install-only-") as temp_dir:
        await run_install_only(Path(temp_dir))


if __name__ == "__main__":
    asyncio.run(main())
