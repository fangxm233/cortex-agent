# input:  real PI 0.82.1 binary, capture script, Harbor PI agent
# output: reproducible PI artifact pin and loopback wire contract
# pos:    Contract test for the real PI vendor fixture
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
import runpy
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from harbor.agents.installed.pi import Pi

HARNESS_DIR = Path(__file__).resolve().parents[2]
CAPTURE_SCRIPT = HARNESS_DIR / "scripts" / "capture-pi-vendor-wire.py"
FIXTURE_DIR = HARNESS_DIR / "tests" / "fixtures" / "vendor-wire" / "pi"
PIN_PATH = FIXTURE_DIR / "artifact-pin.json"
CAPTURE_PATH = FIXTURE_DIR / "capture.json"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def isolated_pi_wrapper(root: Path, rejected_agent_dir: Path, rejected_bin: Path) -> Path:
    real_pi = shutil.which("pi")
    assert real_pi
    package_dir = root / "pi-package"
    executable = package_dir / "dist/pi"
    executable.parent.mkdir(parents=True)
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        f"assert os.environ.get('PI_CODING_AGENT_DIR') != {str(rejected_agent_dir)!r}\n"
        f"assert {str(rejected_bin)!r} not in os.environ.get('PATH', '').split(':')\n"
        f"os.execv({real_pi!r}, [{real_pi!r}, *sys.argv[1:]])\n",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    (package_dir / "package.json").write_text(json.dumps({
        "name": "@earendil-works/pi-coding-agent", "version": "0.82.1",
    }), encoding="utf-8")
    return executable


@pytest.mark.parametrize("authorization", [None, "Bearer unexpected-key"])
def test_redaction_rejects_non_dummy_authorization(
    authorization: str | None, tmp_path: Path,
) -> None:
    redact_request = runpy.run_path(str(CAPTURE_SCRIPT))["redact_request"]
    headers = {"Host": "127.0.0.1:1234", "Content-Length": "2"}
    if authorization is not None:
        headers["Authorization"] = authorization
    request = {"method": "POST", "path": "/v1/chat/completions", "query": "", "headers": headers, "body": {}}

    with pytest.raises(RuntimeError, match="expected dummy PI authorization bearer"):
        redact_request(request, tmp_path)


def test_real_pi_fixture_regenerates_without_egress(tmp_path: Path) -> None:
    output_dir = tmp_path / "pi"
    rejected_agent_dir = tmp_path / "host-agent"
    rejected_bin = tmp_path / "host-bin"
    pi_wrapper = isolated_pi_wrapper(tmp_path, rejected_agent_dir, rejected_bin)
    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = str(rejected_agent_dir)
    env["PATH"] = f"{rejected_bin}:{env['PATH']}"
    completed = subprocess.run(
        [
            sys.executable, str(CAPTURE_SCRIPT), "--output-dir", str(output_dir),
            "--pi-command", str(pi_wrapper),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )

    result = json.loads(completed.stdout)
    assert result["ok"] is True
    assert result["network_isolation"] == "linux-user-network-namespace"
    assert load_json(output_dir / "artifact-pin.json") == load_json(PIN_PATH)
    assert load_json(output_dir / "capture.json") == load_json(CAPTURE_PATH)


def test_pi_pin_and_observed_contract_are_complete() -> None:
    pin = load_json(PIN_PATH)
    capture = load_json(CAPTURE_PATH)

    assert pin == {
        "schema_version": "cortex-bench-vendor-artifact-pin/1",
        "artifact": {"ecosystem": "npm", "package": "@earendil-works/pi-coding-agent", "version": "0.82.1"},
        "cli": {"command": "pi --version", "observed_stdout": "0.82.1"},
        "harbor": {"package_version": "0.20.0", "version_check_command": ". ~/.nvm/nvm.sh; pi --version"},
    }
    assert Pi.get_version_command(Pi.__new__(Pi)) == pin["harbor"]["version_check_command"]
    assert capture["request"]["path"] == "/v1/chat/completions"
    assert capture["request"]["query"] == ""
    assert capture["request"]["headers"]["authorization"] == "<REDACTED>"
    assert capture["request"]["body"]["model"] == "deepseek-chat"
    assert capture["request"]["body"]["stream"] is True
    assert capture["error_request"]["path"] == "/v1/chat/completions"
    assert capture["error_request"]["body"]["model"] == "deepseek-chat"
    assert capture["upstream_stream"][-1] == "data: [DONE]"
    assert capture["error_response"]["status"] == 401
    assert capture["success_process"]["event_types"][-2:] == ["agent_end", "agent_settled"]
    assert capture["error_process"]["stop_reasons"] == ["error", "error", "error"]
    assert capture["error_process"]["event_types"][-2:] == ["agent_end", "agent_settled"]
    assert capture["observations"]["PI_CODING_AGENT_DIR"]["status"] == "observed"
    assert capture["observations"]["PI_OFFLINE"]["status"] == "observed"
    assert capture["observations"]["PI_SKIP_VERSION_CHECK"]["status"] == "not-exercised"
    assert capture["observations"]["PI_TELEMETRY"]["status"] == "not-exercised"
    assert capture["observations"]["auth.json"]["status"] == "observed"
    assert capture["observations"]["models.json"]["status"] == "observed"
    assert "dummy-pi-wire-key" not in json.dumps(capture)
