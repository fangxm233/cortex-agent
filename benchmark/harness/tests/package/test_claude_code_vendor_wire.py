# input:  committed Claude Code pin/wire fixtures and optional host CLI
# output: artifact, protocol, redaction, and live-recapture proofs
# pos:    Claude Code vendor-wire fixture contract tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
from pathlib import Path

import pytest

import vendor_wire_capture as capture

FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures/vendor-wire/claude-code"
PIN_PATH = FIXTURE_DIR / "pin.json"
CAPTURE_PATH = FIXTURE_DIR / "wire-capture.json"
DETERMINATION_PATH = FIXTURE_DIR / "determination.json"
EXPECTED_VERSION = "2.1.232"
EXPECTED_MODELS = {
    "haiku": "claude-haiku-4-5-20251001",
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "subagent-haiku": "claude-haiku-4-5-20251001",
}


def load(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_pin_fixes_host_artifact_and_harbor_version_contract() -> None:
    pin = load(PIN_PATH)
    assert pin["artifact"] == {
        "distribution": "native",
        "platform": "linux-x64",
        "sha256": "61d23f8749136907d586d5b11831ea8a5234d4c1dea40a5e55c33b52e204c6d1",
        "size_bytes": 323021104,
        "version": EXPECTED_VERSION,
    }
    assert pin["host_observation"]["stdout"] == "2.1.232 (Claude Code)"
    assert pin["host_observation"]["matches_manifest"] is True
    assert pin["harbor_version_check"]["command"].endswith("claude --version")
    assert pin["harbor_version_check"]["comparison"] == "installed_version == requested_version"


def test_capture_refuses_version_matching_unpinned_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    binary = tmp_path / "claude"
    binary.write_bytes(b"not-the-pinned-artifact")
    version_check_called = False

    def version_check(*_args: object, **_kwargs: object) -> object:
        nonlocal version_check_called
        version_check_called = True
        return type("Result", (), {"stdout": "2.1.232 (Claude Code)"})()

    monkeypatch.setattr(capture.shutil, "which", lambda _command: "/usr/bin/tool")
    monkeypatch.setattr(capture.subprocess, "run", version_check)

    with pytest.raises(RuntimeError, match="artifact sha256"):
        capture._check_prerequisites(binary)
    assert version_check_called is False


def test_proxy_capture_cleans_server_when_proxy_start_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class Server:
        server_address = ("127.0.0.1", 12345)
        serve_forever = object()
        shutdown = lambda self: events.append("shutdown")
        server_close = lambda self: events.append("close")

    class Thread:
        def __init__(self, **_kwargs: object) -> None: pass
        def start(self) -> None: events.append("start")
        def join(self, timeout: int) -> None: events.append(f"join:{timeout}")

    monkeypatch.setattr(capture, "CaptureServer", lambda _spec: Server())
    monkeypatch.setattr(capture.threading, "Thread", Thread)
    monkeypatch.setattr(
        capture, "_start_proxy",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("proxy start failed")),
    )

    with pytest.raises(RuntimeError, match="proxy start failed"):
        capture._capture_proxy_run(tmp_path / "claude", tmp_path / "capture")
    assert events == ["start", "shutdown", "close", "join:2"]


def test_proxy_capture_cleans_server_when_proxy_stop_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class Server:
        server_address = ("127.0.0.1", 12345)
        serve_forever = object()
        shutdown = lambda self: events.append("shutdown")
        server_close = lambda self: events.append("close")

    class Thread:
        def __init__(self, **_kwargs: object) -> None: pass
        def start(self) -> None: events.append("start")
        def join(self, timeout: int) -> None: events.append(f"join:{timeout}")

    handle = type("Handle", (), {
        "base_url": "http://127.0.0.1:1", "dummy_token": "dummy",
        "stop": lambda self: (events.append("proxy-stop"),
                              (_ for _ in ()).throw(RuntimeError("proxy stop failed")))[1],
    })()
    monkeypatch.setattr(capture, "CaptureServer", lambda _spec: Server())
    monkeypatch.setattr(capture.threading, "Thread", Thread)
    monkeypatch.setattr(capture, "_start_proxy", lambda *_args, **_kwargs: handle)
    monkeypatch.setattr(capture.subprocess, "run", lambda *_args, **_kwargs: object())

    with pytest.raises(RuntimeError, match="proxy stop failed"):
        capture._capture_proxy_run(tmp_path / "claude", tmp_path / "capture")
    assert events == ["start", "proxy-stop", "shutdown", "close", "join:2"]


def test_capture_records_complete_redacted_wire_and_model_aliases() -> None:
    capture = load(CAPTURE_PATH)
    assert capture["claude_code_version"] == EXPECTED_VERSION
    assert capture["containment"]["real_home_mounted"] is False
    assert capture["containment"]["non_loopback_connects"] == []
    observed = capture["observed_model_identifiers"]
    assert observed == EXPECTED_MODELS
    assert set(capture["runs"]) == {
        "haiku_success", "oauth_env_local_error", "opus_success",
        "sonnet_error", "sonnet_success", "subagent_haiku_success",
        "trial_proxy_bearer_substitution",
    }
    for run in capture["runs"].values():
        for request in run["requests"]:
            assert request["path"] == "/v1/messages"
            assert request["query"] == "beta=true"
            headers = request["headers"]
            assert headers.get("Authorization") in (None, "<REDACTED>")
            assert headers.get("x-api-key") in (None, "<REDACTED>")
            assert "body" in request
        assert run["cli_events"][-1]["type"] == "result"
    assert capture["runs"]["sonnet_error"]["cli_events"][-1]["is_error"] is True
    assert capture["runs"]["oauth_env_local_error"]["requests"] == []
    substitution = capture["runs"]["trial_proxy_bearer_substitution"]["proxy_observation"]
    assert substitution == {
        "adapter_received_no_container_auth": True,
        "proxy_admitted_trial_dummy": True,
        "upstream_received_host_bearer": True,
        "upstream_received_trial_dummy": False,
    }


def test_determination_distinguishes_observed_from_unverified_claims() -> None:
    determination = load(DETERMINATION_PATH)
    assert determination["decision"] == "direct-trial-proxy-bearer-injection-supported"
    assert determination["required_container_inputs"] == [
        "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
    ]
    assert determination["gateway_requirement"] == "not-required-for-static-bearer-injection"
    assert determination["unverified"]
    assert all(item["evidence"] for item in determination["observed"])


def test_connect_audit_preserves_ipv4_and_ipv6_destinations(tmp_path: Path) -> None:
    from vendor_wire_capture import _connects

    trace = tmp_path / "connect.trace"
    trace.write_text(
        '1 connect(3, {sa_family=AF_INET, sin_port=htons(443), '
        'sin_addr=inet_addr("203.0.113.7")}, 16) = 0\n'
        '2 connect(4, {sa_family=AF_INET6, sin6_port=htons(8443), '
        'inet_pton(AF_INET6, "2001:db8::7", &sin6_addr)}, 28) = 0\n',
        encoding="utf-8",
    )
    assert _connects(trace) == ["2001:db8::7:8443", "203.0.113.7:443"]


@pytest.mark.skipif(
    os.environ.get("RUN_CLAUDE_CODE_VENDOR_WIRE") != "1",
    reason="set RUN_CLAUDE_CODE_VENDOR_WIRE=1 for the real isolated CLI recapture",
)
def test_real_claude_process_reproduces_committed_wire_fixture(tmp_path: Path) -> None:
    from vendor_wire_capture import capture_claude_code_wire

    assert capture_claude_code_wire(tmp_path) == load(CAPTURE_PATH)
