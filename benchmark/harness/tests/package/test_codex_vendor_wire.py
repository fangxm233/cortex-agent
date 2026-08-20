# input:  current and historical Codex wire fixtures, Harbor agent, OAuth adapter
# output: exact pins, auth, request, SSE, probes, and expiry assertions
# pos:    Contract tests for Codex native wire evidence
# >>> If I am updated, update my header and folder CORTEX.md <<<

import base64
import json
import runpy
from pathlib import Path

from harbor.agents.installed.codex import Codex

from cortex_bench_harness.proxy.adapters.openai_codex_responses import (
    JWT_ACCOUNT_CLAIM,
    TERMINAL_WIRE_EVENT,
    extract_account_id,
)

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures/vendor-wire/codex"


def load_fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def jwt_payload(token: str) -> dict[str, object]:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def test_pin_matches_host_and_harbor_version_check() -> None:
    fixture = load_fixture("contract.json")
    pin = fixture["artifact_pin"]
    harbor = fixture["harbor_version_check"]

    assert pin["cli_output"] == "codex-cli 0.117.0"
    assert pin["npm_package"] == "@openai/codex@0.117.0"
    assert pin["platform_package"] == "@openai/codex@0.117.0-linux-x64"
    assert harbor == {
        "install_check_command": Codex._INSTALL_CHECK_COMMAND,
        "version_command": Codex._INSTALL_VERSION_COMMAND,
        "requested_version": "0.117.0",
        "parsed_version": Codex.parse_version(object.__new__(Codex), pin["cli_output"]),
        "match_required": True,
    }


def test_current_pin_model_native_default_and_transport_probes_are_explicit() -> None:
    fixture = load_fixture("current-contract.json")
    pin = fixture["artifact_pin"]
    catalog = fixture["account_catalog"]
    wire = fixture["dummy_auth_wire"]
    probes = fixture["authenticated_transport_probes"]

    assert pin["version"] == "0.148.0"
    assert pin["platform_package"] == "@openai/codex@0.148.0-linux-x64"
    assert catalog["default_model"] == wire["model"] == "gpt-5.6-sol"
    assert catalog["supported_visible_models"][0] == "gpt-5.6-sol"
    assert wire["request_count"] == 1
    assert wire["max_output_tokens_present"] is False
    assert wire["host_credential_present"] is False
    assert probes["generation_requests"] == 0
    assert probes["http"]["status"] == 404
    assert probes["responses_websocket"]["status"] == 101


def test_minimal_auth_is_adapter_compatible() -> None:
    fixture = load_fixture("contract.json")
    auth = fixture["minimal_auth_json"]

    assert set(auth) == {"tokens", "last_refresh"}
    assert set(auth["tokens"]) == {"id_token", "access_token", "refresh_token"}
    access = auth["tokens"]["access_token"]
    assert len(access.split(".")) == 3
    claim = jwt_payload(access)[JWT_ACCOUNT_CLAIM]["chatgpt_account_id"]
    assert extract_account_id(access) == claim == "dummy-account-wire-capture"


def test_request_and_sse_fixture_records_the_native_contract() -> None:
    fixture = load_fixture("contract.json")
    request = fixture["request"]
    body = load_fixture("request-body.json")
    events = load_fixture("success-sse.json")["events"]

    assert request["target"] == {"path": "/codex/responses", "query": ""}
    assert request["compression"] == {
        "content_encoding_header": None,
        "zstd_magic_present": False,
        "decoded_as": "json",
    }
    assert body["model"] == request["model"] == "gpt-5.3-codex"
    assert body["stream"] is True and body["store"] is False
    assert [event["type"] for event in events] == fixture["sse"]["completed_sequence"]
    assert events[-1]["type"] == "response.completed"
    assert TERMINAL_WIRE_EVENT == events[-1]["type"]


def test_capture_probe_records_the_complete_json_body() -> None:
    observe_request = runpy.run_path(
        str(FIXTURE_DIR / "capture.py"), run_name="codex_capture_test",
    )["observe_request"]
    body = {"model": "gpt-5.3-codex", "input": [{"role": "user"}], "stream": True}
    observed = observe_request(
        "/codex/responses", {"authorization": "Bearer dummy"},
        json.dumps(body).encode(),
    )
    assert observed["body"] == body
    assert observed["headers"]["authorization"] == "Bearer <REDACTED_DUMMY_JWT>"


def test_terminal_failure_and_expiry_observations_are_explicit() -> None:
    fixture = load_fixture("contract.json")
    terminal = fixture["sse"]["terminal_observations"]
    expiry = fixture["jwt_expiry_observations"]

    assert set(terminal) == {
        "response.done", "response.completed", "response.incomplete",
        "response.failed", "error",
    }
    assert terminal["response.completed"]["accepted"] is True
    assert all(not terminal[name]["accepted"] for name in terminal if name != "response.completed")
    assert expiry["no_exp_claim"]["request_emitted"] is True
    assert expiry["ten_seconds_remaining"]["refresh_attempted"] is False
    assert expiry["expired"]["refresh_attempted"] is True
    assert expiry["expired"]["request_emitted_after_refresh_failure"] is True
    assert expiry["refresh_exchange_wire_details"]["verified"] is False
