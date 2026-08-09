# input:  pytest subprocesses, Docker opt-in gate, real-agent module
# output: proof that default and scoped ZERO-PAID runs skip it
# pos:    Regression test for the real-agent container safety fence
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from docker_gate import DOCKER_OPT_IN

HARNESS_ROOT = Path(__file__).parents[2]
REAL_AGENT_RUN = Path("tests/scan/test_real_agent_run.py")
PROBE_SOURCE = '''
import json
import os
from pathlib import Path

import pytest

TARGET = "tests/scan/test_real_agent_run.py"
target_count = 0
call_count = 0


def is_target(item):
    return item.path.as_posix().endswith(TARGET)


def pytest_collection_modifyitems(config, items):
    global target_count
    selected = [item for item in items if is_target(item)]
    deselected = [item for item in items if not is_target(item)]
    target_count = len(selected)
    items[:] = selected
    config.hook.pytest_deselected(items=deselected)


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_call(item):
    global call_count
    if is_target(item):
        call_count += 1
        pytest.fail("ZERO-PAID probe reached a real-agent test body")


def pytest_sessionfinish(session):
    report = {"targets": target_count, "calls": call_count}
    Path(os.environ["ZERO_PAID_PROBE_REPORT"]).write_text(json.dumps(report))
'''


def run_zero_paid_probe(tmp_path: Path, selection: tuple[str, ...]) -> tuple[dict, str]:
    plugin = tmp_path / "zero_paid_probe.py"
    report = tmp_path / "report.json"
    plugin.write_text(PROBE_SOURCE)
    env = os.environ.copy()
    env.pop(DOCKER_OPT_IN, None)
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    env["PYTHONPATH"] = os.pathsep.join(filter(None, (str(tmp_path), env.get("PYTHONPATH"))))
    env["ZERO_PAID_PROBE_REPORT"] = str(report)
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-rs", "-p", "zero_paid_probe", *selection],
        cwd=HARNESS_ROOT, env=env, text=True, capture_output=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(report.read_text()), result.stdout


@pytest.mark.parametrize("selection", [(), (str(REAL_AGENT_RUN),)])
def test_zero_paid_commands_do_not_execute_real_agent_tests(
    tmp_path: Path, selection: tuple[str, ...],
) -> None:
    report, output = run_zero_paid_probe(tmp_path, selection)

    assert report["targets"] > 0
    assert report["calls"] == 0
    assert f"set {DOCKER_OPT_IN}=1" in output
