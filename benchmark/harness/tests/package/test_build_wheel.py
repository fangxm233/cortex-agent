# input:  build script, locked source, and hostile process env
# output: ambient-epoch reproducibility regression assertion
# pos:    Contract test for the fixed wheel build epoch
# >>> If I am updated, update my header and folder CORTEX.md <<<

import os
import shutil
import subprocess
from pathlib import Path

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
