# input:  DeepSeek adapter, bounded proxy, synthetic OpenAI streams
# output: exact route, cap, auth, usage, and byte-limit proofs
# pos:    DeepSeek chat-completions adapter contract tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey
from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from cortex_bench_harness.proxy.adapters import AuthInjectionUnavailable, select_adapter
from synthetic import LEASE_TERMS, SyntheticUpstream, proxy_request

MODEL = "deepseek-v4-flash"
REAL_CREDENTIAL = "relay-DEEPSEEK-SYNTHETIC-UNIQUE"
ROW = CredentialCapabilityKey("pi", "deepseek", "openai-completions", "api-key")
TARGET = "/v1/chat/completions"
# The trial's declared cap, frozen per trial rather than compiled in: the value below is one
# lawful envelope value, and the parameterized test proves the adapter carries whichever one the
# trial declared.
FROZEN_CAP = 32768


def adapter(
    upstream: str, credential: str | None = REAL_CREDENTIAL,
    *, frozen_completion_cap: int | None = FROZEN_CAP,
):
    return select_adapter(
        ROW, upstream_base_url=upstream, credential=credential, frozen_model=MODEL,
        frozen_completion_cap=frozen_completion_cap,
    )


def request_body(**overrides: object) -> bytes:
    document = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "reply OK"}],
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_completion_tokens": FROZEN_CAP,
        **overrides,
    }
    return json.dumps(document, separators=(",", ":")).encode()


def sse(*documents: dict[str, object], done: bool = True) -> bytes:
    lines = [f"data: {json.dumps(document, separators=(',', ':'))}\n\n" for document in documents]
    if done:
        lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def complete_stream(*, model: str = MODEL) -> bytes:
    return sse(
        {"id": "chatcmpl-synthetic", "model": model,
         "choices": [{"delta": {"content": "OK"}, "finish_reason": None}]},
        {"id": "chatcmpl-synthetic", "model": model, "choices": [],
         "usage": {"prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11}},
    )


def start_proxy(
    tmp_path: Path, upstream: SyntheticUpstream, *, request_limit: int | None = 64 * 1024,
    response_limit: int | None = 1024 * 1024,
):
    return start_trial_proxy(
        trial_id="trial-deepseek", upstream_base_url=upstream.base_url,
        adapter=adapter(upstream.base_url), bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        budget=ProxyBudget(
            Decimal("0.05"), Decimal("0.05"), Decimal("0.14"), Decimal("0.28"),
        ),
        log_path=tmp_path / "deepseek.jsonl", lease_terms=LEASE_TERMS,
        request_body_limit_bytes=request_limit, response_body_limit_bytes=response_limit,
    )


def post(handle, body: bytes, *, target: str = TARGET, headers: dict[str, str] | None = None):
    return proxy_request(
        handle.base_url, handle.dummy_token, "unused", target=target, body=body,
        extra_headers=headers,
    )


def records(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_admits_only_exact_chat_completion_routes_and_body() -> None:
    bound = adapter("https://api.deepseek.test")
    assert bound.validate_route("POST", TARGET).allow is True
    assert bound.validate_route("POST", "/chat/completions").allow is True
    for target in ("/v1/chat/completions?trace=1", "/models", "/v1/responses"):
        assert bound.validate_route("POST", target).allow is False
    assert bound.validate_route("GET", TARGET).allow is False
    assert bound.validate_body("chat_completions", request_body()).allow is True


def test_rejects_model_stream_usage_and_completion_cap_drift() -> None:
    bound = adapter("https://api.deepseek.test")
    invalid = [
        (request_body(model="deepseek-v4-pro"), "request_model_mismatch"),
        (request_body(stream=False), "request_stream_required"),
        (request_body(stream_options={}), "request_stream_usage_required"),
        (request_body(max_completion_tokens=FROZEN_CAP + 1), "request_completion_cap_mismatch"),
        (request_body(max_tokens=FROZEN_CAP), "request_completion_cap_conflict"),
    ]
    for body, reason in invalid:
        decision = bound.validate_body("chat_completions", body)
        assert (decision.allow, decision.reason) == (False, reason)


@pytest.mark.parametrize("cap", [1, 256, 4096, 131072])
def test_admits_exactly_the_frozen_completion_cap_whatever_the_trial_declared(cap: int) -> None:
    """The cap is a per-trial datum, not a compiled constant: whichever value the trial froze is
    the only one the body may declare."""
    bound = adapter("https://api.deepseek.test", frozen_completion_cap=cap)

    admitted = bound.validate_body("chat_completions", request_body(max_completion_tokens=cap))
    drifted = bound.validate_body("chat_completions", request_body(max_completion_tokens=cap + 1))

    assert admitted.allow is True
    assert (drifted.allow, drifted.reason) == (False, "request_completion_cap_mismatch")


def test_refuses_every_request_when_no_completion_cap_is_frozen() -> None:
    """The same shape the frozen model has: an adapter that was handed no cap admits nothing,
    rather than falling back to a shipped default the trial never declared."""
    bound = adapter("https://api.deepseek.test", frozen_completion_cap=None)

    decision = bound.validate_body("chat_completions", request_body())

    assert (decision.allow, decision.reason) == (False, "request_completion_cap_unfrozen")


def test_a_max_tokens_body_conflicts_before_the_unfrozen_cap_is_read() -> None:
    """A body defect is named ahead of the adapter's own missing cap, so the conflict refusal
    keeps its meaning on every adapter."""
    bound = adapter("https://api.deepseek.test", frozen_completion_cap=None)

    decision = bound.validate_body("chat_completions", request_body(max_tokens=16))

    assert (decision.allow, decision.reason) == (False, "request_completion_cap_conflict")


@pytest.mark.parametrize("cap", [0, -1, True, 2.5, "256"])
def test_refuses_to_bind_a_cap_that_is_not_a_positive_integer(cap: object) -> None:
    with pytest.raises(ValueError, match="frozen_completion_cap"):
        adapter("https://api.deepseek.test", frozen_completion_cap=cap)


def test_injects_only_allowlisted_headers_and_host_bearer() -> None:
    bound = adapter("https://api.deepseek.test")
    headers = bound.inject_auth({
        "Content-Type": "application/json", "Accept": "text/event-stream",
        "Authorization": "Bearer container", "X-API-Key": "container-key",
        "Cookie": "private", "X-Trace": "ambient",
    }, "chat_completions")
    assert headers == {
        "Content-Type": "application/json", "Accept": "text/event-stream",
        "authorization": f"Bearer {REAL_CREDENTIAL}",
    }


def test_extracts_one_terminal_stream_usage() -> None:
    usage = adapter("https://api.deepseek.test").extract_usage(
        complete_stream(), "text/event-stream",
    )
    assert usage.accounted is True
    assert (usage.upstream_model, usage.input_tokens, usage.output_tokens) == (MODEL, 9, 2)


def test_rejects_partial_duplicate_conflicting_and_nonstream_usage() -> None:
    bound = adapter("https://api.deepseek.test")
    usage = {"prompt_tokens": 9, "completion_tokens": 2}
    payloads = [
        (sse({"model": MODEL, "choices": [], "usage": usage}, done=False),
         "text/event-stream"),
        (sse({"model": MODEL, "choices": [], "usage": usage},
             {"model": MODEL, "choices": [], "usage": usage}), "text/event-stream"),
        (sse({"model": MODEL, "choices": []},
             {"model": "deepseek-v4-pro", "choices": [], "usage": usage}),
         "text/event-stream"),
        (json.dumps({"model": MODEL, "usage": usage}).encode(), "application/json"),
    ]
    assert all(not bound.extract_usage(body, kind).accounted for body, kind in payloads)


def test_rejects_invalid_tokens_malformed_sse_and_data_after_done() -> None:
    bound = adapter("https://api.deepseek.test")
    invalid_usage = [
        {"prompt_tokens": True, "completion_tokens": 2},
        {"prompt_tokens": -1, "completion_tokens": 2},
        {"prompt_tokens": 9, "completion_tokens": 2.5},
    ]
    payloads = [
        sse({"model": MODEL, "choices": [], "usage": usage})
        for usage in invalid_usage
    ]
    payloads.extend([
        (b'data: {"model":"deepseek-v4-flash","choices":[],"usage":'
         b'{"prompt_tokens":9,"completion_tokens":2}}\n\n'
         b'data: {not-json}\n\ndata: [DONE]\n\n'),
        sse({"model": MODEL, "choices": [],
             "usage": {"prompt_tokens": 9, "completion_tokens": 2}})
        + b'data: {"model":"deepseek-v4-flash"}\n\n',
    ])
    assert all(
        not bound.extract_usage(payload, "text/event-stream").accounted
        for payload in payloads
    )


def test_stop_clears_the_adapter_credential(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream)
        handle.stop()
        with pytest.raises(AuthInjectionUnavailable, match="no api key"):
            handle._server.upstream._adapter.inject_auth({}, "chat_completions")


def test_trial_policy_rejects_declared_request_over_64_kib_before_upstream(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.content_type = "text/event-stream"
        upstream.server.raw_body = complete_stream()
        handle = start_proxy(tmp_path, upstream)
        try:
            status, payload = post(handle, b"x" * (64 * 1024 + 1))
        finally:
            handle.stop()
    assert status == 413
    assert json.loads(payload) == {"error": "request_body_too_large"}
    assert upstream.requests == []


def test_deepseek_protocol_does_not_impose_the_smoke_request_limit(tmp_path: Path) -> None:
    large = request_body(messages=[{"role": "user", "content": "x" * (70 * 1024)}])
    with SyntheticUpstream() as upstream:
        upstream.server.content_type = "text/event-stream"
        upstream.server.raw_body = complete_stream()
        handle = start_proxy(tmp_path, upstream, request_limit=None)
        try:
            status, _ = post(handle, large)
        finally:
            handle.stop()
    assert status == 200
    assert len(upstream.requests) == 1


def test_proxy_accounts_one_complete_stream_and_replaces_auth(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.content_type = "text/event-stream"
        upstream.server.raw_body = complete_stream()
        handle = start_proxy(tmp_path, upstream)
        try:
            status, payload = post(handle, request_body(), headers={"cookie": "ambient"})
        finally:
            handle.stop()
    captured = upstream.requests[0]
    outgoing = {key.lower(): value for key, value in captured.headers.items()}
    assert status == 200
    assert payload == complete_stream()
    assert json.loads(captured.body)["max_completion_tokens"] == FROZEN_CAP
    assert outgoing["authorization"] == f"Bearer {REAL_CREDENTIAL}"
    assert "cookie" not in outgoing
    assert records(tmp_path / "deepseek.jsonl")[0]["tokens"] == {
        "input": 9, "output": 2, "total": 11,
    }


def test_oversized_response_retains_reservation_and_revokes_route(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.content_type = "text/event-stream"
        upstream.server.raw_body = b"x" * (1024 * 1024 + 1)
        handle = start_proxy(tmp_path, upstream)
        try:
            first, payload = post(handle, request_body())
            second, _ = post(handle, request_body())
        finally:
            handle.stop()
    assert (first, second) == (502, 410)
    assert json.loads(payload) == {"error": "upstream_unavailable"}
    assert len(upstream.requests) == 1
    assert records(tmp_path / "deepseek.jsonl")[0]["outcome"] == "upstream_response_too_large"
