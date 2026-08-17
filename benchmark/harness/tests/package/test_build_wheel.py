# input:  build script, locked source, hostile env and committed arm bundles
# output: reproducible wheel and packaged production bundle assertions
# pos:    Contract tests for deterministic complete wheel contents
# >>> If I am updated, update my header and folder CORTEX.md <<<

import os
import shutil
import subprocess
import zipfile
from pathlib import Path

from cortex_bench_harness.launcher.production_arms import PRODUCTION_ARM_BUNDLES

HARNESS_DIR = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = HARNESS_DIR / "scripts" / "build-wheel.sh"
WHEEL_PATH = HARNESS_DIR / "dist" / "cortex_bench_harness-0.1.0-py3-none-any.whl"


def build_wheel(source_date_epoch: str | None) -> bytes:
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    if source_date_epoch is None:
        environment.pop("SOURCE_DATE_EPOCH", None)
    else:
        environment["SOURCE_DATE_EPOCH"] = source_date_epoch
    environment["UV_BIN"] = shutil.which("uv") or "uv"
    subprocess.run(
        [str(BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=True, capture_output=True, text=True,
    )
    return WHEEL_PATH.read_bytes()


def test_conflicting_ambient_epoch_cannot_change_wheel() -> None:
    baseline = build_wheel(None)
    hostile = build_wheel("946684800")

    assert hostile == baseline


def test_wheel_contains_every_committed_arm_bundle() -> None:
    """A bundle that is not packaged is an arm the installed harness cannot launch."""
    build_wheel(None)
    expected = {
        f"cortex_bench_harness/launcher/bundles/{bundle.key}/cortex-home/"
        f"{path.relative_to(bundle.bundle_dir).as_posix()}"
        for bundle in PRODUCTION_ARM_BUNDLES
        for path in bundle.bundle_dir.rglob("*") if path.is_file()
    }
    assert len(expected) >= 20
    with zipfile.ZipFile(WHEEL_PATH) as wheel:
        assert expected <= set(wheel.namelist())
