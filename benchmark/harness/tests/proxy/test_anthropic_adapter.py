# input:  row-1 adapter duties over synthetic routes, bodies, and payloads
# output: allow-list, body-model, auth-form, usage, and billable proofs
# pos:    Row-1 Anthropic adapter unit tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json

import pytest

from cortex_bench_harness.proxy.adapters import AuthInjectionUnavailable
from cortex_bench_harness.proxy.adapters.anthropic import (
    MESSAGES_BETA_ROUTE,
    AnthropicMessagesApiKeyAdapter,
)
from cortex_bench_harness.proxy.models import ProxyUsage

FROZEN_MODEL = "claude-synthetic-1"
CREDENTIAL = "sk-ant-SYNTHETIC-ADAPTER-UNIQUE"


def adapter(
    credential: str | None = CREDENTIAL, frozen_model: str | None = FROZEN_MODEL,
) -> AnthropicMessagesApiKeyAdapter:
    return AnthropicMessagesApiKeyAdapter(
        "http://127.0.0.1:9000", credential, frozen_model,
    )


def test_admits_only_the_beta_messages_target() -> None:
    decision = adapter().validate_route("POST", "/v1/messages?beta=true")
    assert (decision.allow, decision.route_id, decision.reason) == (
        True, MESSAGES_BETA_ROUTE, None,
    )


def test_refuses_the_non_beta_messages_target() -> None:
    decision = adapter().validate_route("POST", "/v1/messages")
    assert decision.allow is False
    assert decision.route_id is None
    assert decision.reason == "route_denied_messages_non_beta"


@pytest.mark.parametrize(
    "target", ["/v1/messages?beta=false", "/v1/messages?beta=true&stream=1", "/v1/messages?"],
)
def test_refuses_a_messages_target_whose_query_is_not_exactly_beta(target: str) -> None:
    assert adapter().validate_route("POST", target).reason == "route_denied_messages_non_beta"


def test_refuses_a_non_post_method_on_the_messages_route() -> None:
    assert adapter().validate_route("GET", "/v1/messages?beta=true").reason == (
        "route_denied_messages_method"
    )


def test_refuses_the_count_tokens_route() -> None:
    assert adapter().validate_route("POST", "/v1/messages/count_tokens").reason == (
        "route_denied_count_tokens"
    )


@pytest.mark.parametrize(
    ("method", "target"),
    [
        ("POST", "/v1/messages/batches?beta=true"),
        ("GET", "/v1/messages/batches?beta=true"),
        ("GET", "/v1/messages/batches/batch_1?beta=true"),
        ("DELETE", "/v1/messages/batches/batch_1?beta=true"),
        ("POST", "/v1/messages/batches/batch_1/cancel?beta=true"),
    ],
)
def test_refuses_every_batches_path_and_method(method: str, target: str) -> None:
    assert adapter().validate_route(method, target).reason == "route_denied_batches"


@pytest.mark.parametrize(
    "target", ["/v1/complete", "/api/claude_cli_profile", "/", "/v1/messages/"],
)
def test_refuses_an_unknown_path_with_the_unknown_route_reason(target: str) -> None:
    assert adapter().validate_route("POST", target).reason == "route_not_allowed"


def test_known_route_denials_are_distinguishable_from_unknown_ones() -> None:
    known = {
        adapter().validate_route("POST", "/v1/messages").reason,
        adapter().validate_route("POST", "/v1/messages/count_tokens").reason,
        adapter().validate_route("GET", "/v1/messages/batches/batch_1").reason,
    }
    assert "route_not_allowed" not in known
    assert len(known) == 3


def test_admits_a_body_whose_model_is_the_frozen_model() -> None:
    decision = adapter().validate_body(
        MESSAGES_BETA_ROUTE, json.dumps({"model": FROZEN_MODEL, "max_tokens": 1}).encode())
    assert (decision.allow, decision.requested_model, decision.reason) == (
        True, FROZEN_MODEL, None,
    )


def test_refuses_a_body_whose_model_differs_from_the_frozen_model() -> None:
    decision = adapter().validate_body(
        MESSAGES_BETA_ROUTE, json.dumps({"model": "claude-other-9"}).encode())
    assert decision.allow is False
    assert decision.requested_model == "claude-other-9"
    assert decision.reason == "request_model_mismatch"


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (b'{"max_tokens":1}', "request_model_absent"),
        (b'{"model":""}', "request_model_absent"),
        (b'{"model":{"name":"claude-synthetic-1"}}', "request_model_absent"),
        (b"not-json-at-all", "request_body_unparsable"),
        (b"[]", "request_body_unparsable"),
        (b"", "request_body_unparsable"),
    ],
)
def test_refuses_a_body_whose_model_cannot_be_located(body: bytes, reason: str) -> None:
    decision = adapter().validate_body(MESSAGES_BETA_ROUTE, body)
    assert decision.allow is False
    assert decision.reason == reason


def test_refuses_a_body_on_a_route_the_adapter_did_not_allow() -> None:
    decision = adapter().validate_body("batches", json.dumps({"model": FROZEN_MODEL}).encode())
    assert decision.allow is False
    assert decision.reason == "request_route_unknown"


def test_refuses_every_body_when_no_model_is_frozen() -> None:
    decision = adapter(frozen_model=None).validate_body(
        MESSAGES_BETA_ROUTE, json.dumps({"model": FROZEN_MODEL}).encode())
    assert decision.allow is False
    assert decision.reason == "request_model_unfrozen"


def test_injects_the_api_key_header_and_never_a_bearer() -> None:
    outbound = adapter().inject_auth({"content-type": "application/json"}, MESSAGES_BETA_ROUTE)
    assert outbound["x-api-key"] == CREDENTIAL
    assert "authorization" not in {key.lower() for key in outbound}
    assert outbound["content-type"] == "application/json"


def test_missing_credential_refuses_rather_than_injecting_nothing() -> None:
    with pytest.raises(AuthInjectionUnavailable):
        adapter(credential=None).inject_auth({}, MESSAGES_BETA_ROUTE)


def test_auth_injection_refuses_a_route_the_adapter_did_not_allow() -> None:
    with pytest.raises(AuthInjectionUnavailable):
        adapter().inject_auth({}, "batches")


@pytest.mark.parametrize("credential", ["", "line-one\nline-two", "carriage\rreturn"])
def test_construction_rejects_a_credential_that_is_not_one_line(credential: str) -> None:
    with pytest.raises(ValueError, match="credential"):
        adapter(credential=credential)


def test_extracts_usage_from_a_non_streaming_body() -> None:
    body = json.dumps({
        "model": FROZEN_MODEL, "usage": {"input_tokens": 7, "output_tokens": 11},
    }).encode()
    usage = adapter().extract_usage(body, "application/json")
    assert usage == ProxyUsage(FROZEN_MODEL, 7, 11, True)


def test_accumulates_streaming_usage_across_message_start_and_message_delta() -> None:
    body = _sse_body([
        {"type": "message_start",
         "message": {"model": FROZEN_MODEL, "usage": {"input_tokens": 9}}},
        {"type": "content_block_delta", "delta": {"text": "hello"}},
        {"type": "message_delta", "usage": {"output_tokens": 4}},
        {"type": "message_stop"},
    ])
    usage = adapter().extract_usage(body, "text/event-stream")
    assert usage == ProxyUsage(FROZEN_MODEL, 9, 4, True)


def test_streaming_usage_is_incomplete_before_message_delta() -> None:
    body = _sse_body([
        {"type": "message_start",
         "message": {"model": FROZEN_MODEL, "usage": {"input_tokens": 9}}},
    ])
    assert adapter().extract_usage(body, "text/event-stream").accounted is False


def test_streaming_usage_is_incomplete_when_message_start_already_carries_output() -> None:
    body = _sse_body([
        {"type": "message_start",
         "message": {"model": FROZEN_MODEL,
                     "usage": {"input_tokens": 9, "output_tokens": 1}}},
        {"type": "content_block_delta", "delta": {"text": "hello"}},
    ])
    assert adapter().extract_usage(body, "text/event-stream").accounted is False


def test_streaming_usage_is_unaccounted_when_an_event_line_is_unparsable() -> None:
    body = (
        b'data: {"type":"message_start","message":{"model":"' + FROZEN_MODEL.encode()
        + b'","usage":{"input_tokens":9,"output_tokens":1}}}\n\n'
        b'data: {"type":"message_delta","usage":{"output_toke\n\n'
    )
    assert adapter().extract_usage(body, "text/event-stream").accounted is False


def test_streaming_usage_ignores_output_tokens_outside_message_delta() -> None:
    body = _sse_body([
        {"type": "message_start",
         "message": {"model": FROZEN_MODEL,
                     "usage": {"input_tokens": 9, "output_tokens": 1}}},
        {"type": "content_block_stop", "usage": {"output_tokens": 4}},
    ])
    assert adapter().extract_usage(body, "text/event-stream").accounted is False


@pytest.mark.parametrize(
    "body",
    [b"<html>gateway error</html>", b'{"usage":{"input_tokens":1,"output_tokens":"two"}}', b""],
)
def test_unparsable_usage_payload_is_never_accounted(body: bytes) -> None:
    assert adapter().extract_usage(body, "application/json").accounted is False


def test_billable_mirrors_the_accounted_token_counts() -> None:
    billable = adapter().billable(ProxyUsage(FROZEN_MODEL, 7, 11, True))
    assert (billable.input_tokens, billable.output_tokens) == (7, 11)


def test_billable_refuses_an_unaccounted_usage() -> None:
    with pytest.raises(ValueError, match="unaccounted"):
        adapter().billable(ProxyUsage(None, 0, 0, False))


def test_upstream_hosts_is_one_host_taken_from_the_frozen_upstream() -> None:
    assert adapter().upstream_hosts == ("127.0.0.1",)
    assert AnthropicMessagesApiKeyAdapter(
        "https://api.example.test/v1", CREDENTIAL, FROZEN_MODEL,
    ).upstream_hosts == ("api.example.test",)


def _sse_body(documents: list[dict[str, object]]) -> bytes:
    lines = [f"data: {json.dumps(document)}" for document in documents]
    return ("\n\n".join(lines) + "\n\n").encode()
