# input:  repository checkout, installed dependencies and host file locks
# output: serialized npm artifacts and deterministic harness wheels
# pos:    Trial artifact builders
# >>> If I am updated, update my header and folder CORTEX.md <<<

# The npm builder lived in `tests/offline_package.py` and was reachable only from three tests, so
# the only automated thing that ever rebuilt the agent-server artifact was a test run. Whether the
# `dist/` copy a campaign pins was current depended on an operator remembering to rebuild it by
# hand. On 2026-08-14 nobody did, and the r6 campaign measured a 34-hour-stale agent-server.
#
# Both builders now live on the release path and the tests import them from here, so there is one
# implementation of "how this artifact is produced" rather than a release copy and a test copy that
# can drift apart.

from __future__ import annotations

import fcntl
import hashlib
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

WHEEL_NAME = "cortex_bench_harness-0.1.0-py3-none-any.whl"
NPM_ARTIFACT_GLOB = "cortex-agent-server-*.tgz"


class ArtifactBuildError(RuntimeError):
    """An artifact could not be built from this checkout."""


def build_environment() -> dict[str, str]:
    """A build environment with the two things this host gets wrong removed.

    `PYTHONPATH` is set by the ambient ROS installation and leaks into any Python a build shells
    out to. npm's update notifier reaches the network, which an offline build must not do.
    """
    environment = {**os.environ, "npm_config_offline": "true",
                   "npm_config_update_notifier": "false"}
    environment.pop("PYTHONPATH", None)
    return environment


@contextmanager
def _checkout_pack_lock(repo_root: Path) -> Iterator[None]:
    identity = hashlib.sha256(os.fsencode(repo_root.resolve())).hexdigest()
    lock_path = Path(tempfile.gettempdir()) / f"cortex-npm-pack-{identity}.lock"
    with lock_path.open("a") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield


def build_offline_npm_artifact(repo_root: Path, output_dir: Path) -> Path:
    """Build the web SPA, then pack the production agent-server tarball into `output_dir`.

    Packing goes through `scripts/pack-offline.mjs` rather than `npm pack`, because the published
    package is thin and only this path adds the bundled runtime closure the offline containers
    install from.

    `npm pack` will not create its destination, and fails late and confusingly when it is missing
    -- after the whole build has already run -- so it is created here.
    """
    with _checkout_pack_lock(repo_root):
        server_root = repo_root / "agent-server"
        environment = build_environment()
        output_dir.mkdir(parents=True, exist_ok=True)
        _run(["pnpm", "--filter", "@cortex-agent/web...", "run", "build"], repo_root, environment)
        _run(["node", "scripts/pack-offline.mjs", "--pack-destination", str(output_dir)],
             server_root, environment)
        artifacts = sorted(output_dir.glob(NPM_ARTIFACT_GLOB))
        if len(artifacts) != 1:
            raise ArtifactBuildError(
                f"expected exactly one {NPM_ARTIFACT_GLOB} in {output_dir}, found "
                f"{[path.name for path in artifacts]}")
        return artifacts[0]


def build_harness_wheel(harness_dir: Path) -> Path:
    """Build the harness wheel through the committed script, which pins the build epoch."""
    script = harness_dir / "scripts" / "build-wheel.sh"
    environment = build_environment()
    environment["UV_BIN"] = shutil.which("uv") or "uv"
    _run(["bash", str(script)], harness_dir, environment)
    wheel = harness_dir / "dist" / WHEEL_NAME
    if not wheel.is_file():
        raise ArtifactBuildError(f"{script.name} did not produce {wheel}")
    return wheel


def _run(command: list[str], cwd: Path, environment: dict[str, str]) -> None:
    try:
        subprocess.run(
            command, cwd=cwd, env=environment, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as error:
        raise ArtifactBuildError(
            f"{command[0]} failed in {cwd} with exit {error.returncode}:\n"
            f"{(error.stderr or error.stdout or '').strip()[-4000:]}") from error
    except OSError as error:
        raise ArtifactBuildError(f"cannot run {command[0]} in {cwd}: {error}") from error
