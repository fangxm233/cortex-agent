# input:  current PI CLI, historical fixtures, bounded capture
# output: historical evidence and current wire behavior assertions
# pos:    PI historical evidence and current CLI compatibility tests
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import hashlib
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


@pytest.fixture
def capture_script() -> dict:
    return runpy.run_path(str(CAPTURE_SCRIPT))


@pytest.mark.parametrize("version", ["0.82.1", "0.90.0", "9.0.0"])
def test_resolve_pi_records_actual_identity(
    version: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capture_script: dict,
) -> None:
    executable = tmp_path / "dist/pi"
    executable.parent.mkdir()
    executable.write_bytes(b"current PI entrypoint")
    package = {"name": "@earendil-works/pi-coding-agent", "version": version}
    (tmp_path / "package.json").write_text(json.dumps(package), encoding="utf-8")
    monkeypatch.setattr(shutil, "which", lambda _command: str(executable))
    completed = subprocess.CompletedProcess([], 0, f"{version}\n", "")
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: completed)

    binary, pin = capture_script["resolve_pi"]("pi")

    assert binary == executable.resolve()
    assert pin["artifact"]["version"] == version
    assert pin["cli"]["observed_stdout"] == version
    assert pin["cli"]["resolved_path"] == str(binary)
    assert pin["cli"]["sha256"] == hashlib.sha256(executable.read_bytes()).hexdigest()


@pytest.mark.parametrize("returncode,stdout", [(1, "9.0.0\n"), (0, "")])
def test_resolve_pi_rejects_failed_or_empty_version(
    returncode: int, stdout: str, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch, capture_script: dict,
) -> None:
    executable = tmp_path / "pi"
    executable.write_bytes(b"bad CLI")
    (tmp_path / "package.json").write_text(json.dumps({
        "name": "@earendil-works/pi-coding-agent", "version": "9.0.0",
    }), encoding="utf-8")
    monkeypatch.setattr(shutil, "which", lambda _command: str(executable))
    completed = subprocess.CompletedProcess([], returncode, stdout, "version failed")
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: completed)
    with pytest.raises(RuntimeError, match="PI --version failed or returned empty output"):
        capture_script["resolve_pi"]("pi")


def test_resolve_pi_rejects_missing_command(
    monkeypatch: pytest.MonkeyPatch, capture_script: dict,
) -> None:
    monkeypatch.setattr(shutil, "which", lambda _command: None)
    with pytest.raises(RuntimeError, match="PI executable not found"):
        capture_script["resolve_pi"]("missing-pi")


def test_capture_requires_explicit_output_directory(capture_script: dict) -> None:
    with pytest.raises(SystemExit) as error:
        capture_script["parser"]().parse_args([])
    assert error.value.code == 2


def test_safe_environment_drops_host_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capture_script: dict,
) -> None:
    monkeypatch.setenv("PI_CODING_AGENT_DIR", "/host-agent")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "host-secret")
    monkeypatch.setenv("PATH", f"/host-bin:{os.environ['PATH']}")
    env = capture_script["safe_environment"](tmp_path, tmp_path / "agent")
    assert env["HOME"] == str(tmp_path / "home")
    assert env["PI_CODING_AGENT_DIR"] == str(tmp_path / "agent")
    assert "/host-bin" not in env["PATH"].split(os.pathsep)
    assert "DEEPSEEK_API_KEY" not in env
    assert env["PI_OFFLINE"] == env["PI_SKIP_VERSION_CHECK"] == "1"
    assert env["PI_TELEMETRY"] == "0"


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


def test_current_pi_satisfies_wire_contract_without_egress(tmp_path: Path) -> None:
    output_dir = tmp_path / "pi"
    executable = shutil.which("pi")
    assert executable, "pi must be installed on PATH"
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(tmp_path / "host-agent"),
           "PATH": f"{tmp_path / 'host-bin'}:{os.environ['PATH']}",
           "DEEPSEEK_API_KEY": "host-secret"}
    # Version, success and error each have a 30s child budget; allow teardown too.
    completed = subprocess.run(
        [sys.executable, str(CAPTURE_SCRIPT), "--output-dir", str(output_dir),
         "--pi-command", executable],
        capture_output=True, text=True, timeout=120, env=env,
    )
    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    result = json.loads(completed.stdout)
    assert result["ok"] is True
    assert result["network_isolation"] == "linux-user-network-namespace"
    pin = load_json(output_dir / "artifact-pin.json")
    assert pin["cli"]["observed_stdout"] == result["pi_version"]
    assert result["pi_version"]
    assert pin["cli"]["resolved_path"] == str(Path(executable).resolve())
    assert pin["cli"]["sha256"] == hashlib.sha256(Path(executable).read_bytes()).hexdigest()
    print(f"Current PI identity: {json.dumps(pin)}; capture: {output_dir}")
    wire = load_json(output_dir / "capture.json")
    assert_current_wire_contract(wire)
    assert "host-secret" not in json.dumps(wire)


def assert_current_wire_contract(wire: dict) -> None:
    assert wire["schema_version"] == "cortex-bench-vendor-wire-capture/1"
    assert wire["network_isolation"] == "linux-user-network-namespace"
    for key, scenario in [("request", "success"), ("error_request", "error")]:
        request = wire[key]
        assert request["method"] == "POST"
        assert request["path"] == "/v1/chat/completions"
        assert request["query"] == ""
        assert request["headers"]["authorization"] == "<REDACTED>"
        assert request["headers"]["host"] == "127.0.0.1:<PORT>"
        body = request["body"]
        assert body["model"] == "deepseek-chat"
        assert body["stream"] is True and body["store"] is False
        assert body["max_completion_tokens"] == 8192
        assert body["stream_options"] == {"include_usage": True}
        assert body["messages"] == [
            {"role": "system", "content": "synthetic system prompt\nCurrent working directory: <CAPTURE_CWD>"},
            {"role": "user", "content": [{"type": "text", "text": f"wire {scenario}"}]},
        ]
    assert wire["upstream_stream"][-1] == "data: [DONE]"
    assert wire["error_response"]["status"] == 401
    assert_current_process_contract(wire["success_process"], "stop")
    assert_current_process_contract(wire["error_process"], "error")
    assert "dummy-pi-wire-key" not in json.dumps(wire)


def assert_current_process_contract(process: dict, stop_reason: str) -> None:
    # PI reports provider errors in JSON events, not the process exit code.
    assert process["returncode"] == 0
    assert process["stderr"] == ""
    assert process["event_types"][-2:] == ["agent_end", "agent_settled"]
    assert process["stop_reasons"] and set(process["stop_reasons"]) == {stop_reason}
    terminal = process["events"][-2]
    assert terminal["type"] == "agent_end" and terminal["willRetry"] is False
    message = terminal["messages"][-1]
    assert message["role"] == "assistant"
    assert message["model"] == "deepseek-chat"
    assert message["provider"] == "deepseek"
    assert message["stopReason"] == stop_reason
    if stop_reason == "stop":
        assert message["content"] == [{"type": "text", "text": "synthetic ok"}]
        assert message["usage"]["input"] == 5
        assert message["usage"]["output"] == 2
    else:
        assert "401" in message["errorMessage"]
        assert "synthetic rejected" in message["errorMessage"]


def test_current_contract_ignores_incidental_runtime_metadata() -> None:
    wire = load_json(CAPTURE_PATH)
    wire["request"]["headers"]["user-agent"] = "OpenAI/JS future-version"
    assert_current_wire_contract(wire)


@pytest.mark.parametrize("regression", ["model", "cap", "auth", "stream", "result", "error", "egress"])
def test_current_contract_rejects_behavioral_regressions(regression: str) -> None:
    wire = load_json(CAPTURE_PATH)
    mutations = {
        "model": (wire["request"]["body"], "model", "wrong-model"),
        "cap": (wire["request"]["body"], "max_completion_tokens", 1),
        "auth": (wire["error_request"]["headers"], "authorization", "Bearer host-key"),
        "stream": (wire["request"]["body"], "stream", False),
        "result": (wire["success_process"]["events"][-2]["messages"][-1], "content", []),
        "error": (wire["error_process"]["events"][-2]["messages"][-1], "errorMessage", "other error"),
        "egress": (wire, "network_isolation", "host"),
    }
    target, key, value = mutations[regression]
    target[key] = value
    with pytest.raises(AssertionError):
        assert_current_wire_contract(wire)


def test_historical_pi_pin_is_complete() -> None:
    pin = load_json(PIN_PATH)

    assert pin == {
        "schema_version": "cortex-bench-vendor-artifact-pin/1",
        "artifact": {"ecosystem": "npm", "package": "@earendil-works/pi-coding-agent", "version": "0.82.1"},
        "cli": {"command": "pi --version", "observed_stdout": "0.82.1"},
        "harbor": {"package_version": "0.20.0", "version_check_command": ". ~/.nvm/nvm.sh; pi --version"},
    }
    assert Pi.get_version_command(Pi.__new__(Pi)) == pin["harbor"]["version_check_command"]


def test_historical_pi_observed_contract_is_complete() -> None:
    capture = load_json(CAPTURE_PATH)
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
