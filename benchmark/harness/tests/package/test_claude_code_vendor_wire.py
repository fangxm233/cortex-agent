# input:  historical Claude fixtures and current isolated CLI
# output: historical evidence and current behavioral contract proofs
# pos:    Claude Code history and current wire compatibility tests
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

import vendor_wire_capture as capture
from current_vendor_cli import installed_cli, isolated_or_rerun

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
    assert load(CAPTURE_PATH)["artifact_sha256"] == pin["artifact"]["sha256"]
    assert pin["host_observation"]["stdout"] == "2.1.232 (Claude Code)"
    assert pin["host_observation"]["matches_manifest"] is True
    assert pin["harbor_version_check"]["command"].endswith("claude --version")
    assert pin["harbor_version_check"]["comparison"] == "installed_version == requested_version"


@pytest.mark.parametrize("version", ("2.1.232", "9.0.0"))
def test_current_capture_records_executed_version_and_artifact(
    version: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    binary = tmp_path / "claude"
    binary.write_bytes(b"current-artifact-not-historical")
    completed = subprocess.CompletedProcess(
        [str(binary), "--version"], 0, f"{version} (Claude Code)\n", "",
    )
    monkeypatch.setattr(capture.shutil, "which", lambda _command: str(binary))
    monkeypatch.setattr(capture.subprocess, "run", lambda *_args, **_kwargs: completed)
    monkeypatch.setattr(capture, "require_isolated_network", lambda: None)
    monkeypatch.setattr(capture, "_capture_run", lambda *_args: {})
    monkeypatch.setattr(capture, "_capture_proxy_run", lambda *_args: {})
    monkeypatch.setattr(capture, "_containment", lambda _runs: {})
    monkeypatch.setattr(capture, "_observed_models", lambda _runs: {})

    document = capture.capture_claude_code_wire(tmp_path)

    assert document["claude_code_version"] == version
    assert document["artifact_sha256"] == hashlib.sha256(binary.read_bytes()).hexdigest()


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


def assert_current_wire_contract(document: dict) -> None:
    # Deliberate current aliases, not values learned from this run or historical equality.
    assert document["observed_model_identifiers"] == {
        "haiku": "claude-haiku-4-5-20251001", "opus": "claude-opus-5",
        "sonnet": "claude-sonnet-5", "subagent-haiku": "claude-haiku-4-5-20251001",
    }
    assert document["containment"]["real_home_mounted"] is False
    assert document["containment"]["non_loopback_connects"] == []
    runs = document["runs"]
    assert set(runs) == {spec.name for spec in capture.RUN_SPECS} | {"trial_proxy_bearer_substitution"}
    for name, run in runs.items():
        assert_current_run_contract(name, run)
        assert_current_request_models(name, run)
    assert runs["oauth_env_local_error"]["requests"] == []
    assert runs["trial_proxy_bearer_substitution"]["proxy_observation"] == {
        "adapter_received_no_container_auth": True,
        "proxy_admitted_trial_dummy": True,
        "upstream_received_host_bearer": True,
        "upstream_received_trial_dummy": False,
    }
    assert capture.DUMMY_CREDENTIAL not in json.dumps(document)
    assert capture.HOST_BEARER not in json.dumps(document)


def assert_current_request_models(name: str, run: dict) -> None:
    sonnet, opus, haiku = "claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"
    expected = {
        "sonnet_success": [sonnet], "sonnet_error": [sonnet],
        "opus_success": [opus], "haiku_success": [haiku],
        "oauth_env_local_error": [], "subagent_haiku_success": [sonnet, haiku, sonnet],
        "trial_proxy_bearer_substitution": [sonnet],
    }
    assert [request["body"]["model"] for request in run["requests"]] == expected[name]
    # Claude 2.1.263 still uses these caps; future changes require wire review.
    caps = {sonnet: 64000, opus: 64000, haiku: 32000}
    assert [request["body"]["max_tokens"] for request in run["requests"]] == [
        caps[model] for model in expected[name]
    ]


def assert_current_run_contract(name: str, run: dict) -> None:
    result = run["cli_events"][-1]
    is_error = name in {"sonnet_error", "oauth_env_local_error"}
    assert result["type"] == "result"
    assert result["is_error"] is is_error
    assert (run["returncode"] != 0) is is_error
    if not is_error:
        assert result["result"] == "fixture-ok"
        assert run["requests"]
    for request in run["requests"]:
        assert request["method"] == "POST"
        assert request["path"] == "/v1/messages"
        assert request["query"] == "beta=true"
        assert request["body"]["stream"] is True
        assert request["body"]["messages"]
        headers = {key.lower(): value for key, value in request["headers"].items()}
        assert headers.get("authorization") == "<REDACTED>"
        assert "x-api-key" not in headers
    if name == "sonnet_error":
        assert run["requests"]
        assert "synthetic fixture error" in json.dumps(result)


def test_current_contract_ignores_incidental_metadata_not_behavior() -> None:
    document = load(CAPTURE_PATH)
    document["claude_code_version"] = "9.0.0"
    document["artifact_sha256"] = "new-artifact"
    document["runs"]["sonnet_success"]["cli_events"][-1]["duration_ms"] = 123

    assert_current_wire_contract(document)


@pytest.mark.parametrize("regression", ("model", "cap", "auth", "stream", "result", "egress"))
def test_current_contract_rejects_behavioral_regressions(regression: str) -> None:
    document = load(CAPTURE_PATH)
    run = document["runs"]["sonnet_success"]
    mutations = {
        "model": (run["requests"][0]["body"], "model", "wrong-model"),
        "cap": (run["requests"][0]["body"], "max_tokens", 1),
        "auth": (document["runs"]["trial_proxy_bearer_substitution"]["proxy_observation"],
                 "upstream_received_trial_dummy", True),
        "stream": (run["requests"][0]["body"], "stream", False),
        "result": (run["cli_events"][-1], "result", "wrong-result"),
        "egress": (document["containment"], "non_loopback_connects", ["203.0.113.7:443"]),
    }
    target, key, value = mutations[regression]
    target[key] = value

    with pytest.raises(AssertionError):
        assert_current_wire_contract(document)


@pytest.mark.skipif(
    os.environ.get("RUN_CLAUDE_CODE_VENDOR_WIRE") != "1",
    reason="set RUN_CLAUDE_CODE_VENDOR_WIRE=1 for the real isolated CLI recapture",
)
def test_current_claude_process_satisfies_wire_contract(
    tmp_path: Path, request: pytest.FixtureRequest,
) -> None:
    if not isolated_or_rerun(request):
        return
    identity = installed_cli("claude-code")
    document = capture.capture_claude_code_wire(tmp_path)
    (tmp_path / "current-wire.json").write_text(json.dumps(document, indent=2), encoding="utf-8")
    print(f"Current wire capture: {tmp_path / 'current-wire.json'}", flush=True)

    assert document["claude_code_version"] == identity.version_output.removesuffix(" (Claude Code)")
    assert document["artifact_sha256"] == identity.artifact_sha256
    assert_current_wire_contract(document)
