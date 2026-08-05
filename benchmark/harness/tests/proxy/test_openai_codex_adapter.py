# input:  codex request targets, request bodies, and streamed upstream payloads
# output: route, body, auth, usage, billable, and offline containment proofs
# pos:    OpenAI Codex responses adapter tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import base64
import json
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey
from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from cortex_bench_harness.proxy.adapters import (
    AdapterUnavailable,
    AdapterVersionMismatch,
    AuthInjectionUnavailable,
    select_adapter,
)
from cortex_bench_harness.proxy.adapters.anthropic import AnthropicMessagesApiKeyAdapter
from cortex_bench_harness.proxy.adapters.openai_codex_responses import (
    ACCOUNT_ID_HEADER,
    ADAPTER_ID,
    JWT_ACCOUNT_CLAIM,
    RESPONSES_PATH,
    RESPONSES_ROUTE,
    ZSTD_MAGIC,
    OpenAICodexResponsesOAuthAdapter,
    extract_account_id,
)
from cortex_bench_harness.proxy.models import PROXY_SCHEMA_VERSION
from synthetic import SYNTHETIC_MODEL, SyntheticUpstream, proxy_request, row_one_adapter

CODEX_MODEL = "gpt-synthetic-codex"
HOST_ACCOUNT_ID = "acct-synthetic-host-7"
ROW_FOUR_KEY = CredentialCapabilityKey(
    "pi", "openai-codex", "openai-codex-responses", "oauth",
)


def codex_token(account_id: str | None, *, nonce: str = "n0") -> str:
    # A Codex access token is a three-part JWT whose payload carries the account
    # claim; the client decodes it locally rather than fetching the account id.
    claim = {} if account_id is None else {JWT_ACCOUNT_CLAIM: {"chatgpt_account_id": account_id}}
    return ".".join((
        _segment({"alg": "none", "typ": "JWT"}),
        _segment({**claim, "nonce": nonce}),
        base64.b64encode(nonce.encode()).decode().rstrip("="),
    ))


def _segment(document: dict[str, object]) -> str:
    return base64.b64encode(
        json.dumps(document, separators=(",", ":")).encode()).decode().rstrip("=")


def _payload_of(token: str) -> dict[str, object]:
    segment = token.split(".")[1]
    return json.loads(base64.b64decode(segment + "=" * (-len(segment) % 4)))


HOST_ACCESS_TOKEN = codex_token(HOST_ACCOUNT_ID, nonce="host")


def row_four_adapter(
    upstream_base_url: str, credential: str | None = HOST_ACCESS_TOKEN,
    frozen_model: str | None = CODEX_MODEL,
) -> OpenAICodexResponsesOAuthAdapter:
    adapter = select_adapter(
        ROW_FOUR_KEY, upstream_base_url=upstream_base_url,
        credential=credential, frozen_model=frozen_model,
    )
    assert isinstance(adapter, OpenAICodexResponsesOAuthAdapter)
    return adapter


def start_proxy(
    tmp_path: Path, upstream_base_url: str, *, credential: str | None = HOST_ACCESS_TOKEN,
    bound_source_ip: str = "127.0.0.1", deadline: datetime | None = None,
    max_cost: str = "20", frozen_model: str | None = CODEX_MODEL,
):
    return start_trial_proxy(
        trial_id="trial-codex", upstream_base_url=upstream_base_url,
        adapter=row_four_adapter(upstream_base_url, credential, frozen_model),
        bound_source_ip=bound_source_ip,
        absolute_deadline=deadline or datetime.now(UTC) + timedelta(minutes=5),
        budget=ProxyBudget(
            Decimal(max_cost), Decimal("5"), Decimal("1000000"), Decimal("1000000"),
        ),
        log_path=tmp_path / "codex.jsonl",
    )


def terminal_event(
    *, name: str = "response.done", input_tokens: int = 3, output_tokens: int = 2,
    cached_tokens: int = 1, cache_write_tokens: int = 1,
) -> dict[str, object]:
    return {
        "type": name,
        "response": {
            "id": "resp_synthetic", "status": "completed", "model": CODEX_MODEL,
            "usage": {
                "input_tokens": input_tokens,
                "input_tokens_details": {
                    "cached_tokens": cached_tokens,
                    "cache_write_tokens": cache_write_tokens,
                },
                "output_tokens": output_tokens,
                "output_tokens_details": {"reasoning_tokens": 12},
                "total_tokens": input_tokens + output_tokens,
            },
        },
    }


def sse_stream(events: list[dict[str, object]], *, done: bool = True) -> bytes:
    lines = [f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events]
    if done:
        lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def serve_stream(upstream: SyntheticUpstream, body: bytes) -> None:
    upstream.server.content_type = "text/event-stream"
    upstream.server.raw_body = body


def codex_request(handle, **kwargs) -> tuple[int, bytes]:
    kwargs.setdefault("target", RESPONSES_PATH)
    kwargs.setdefault("model", CODEX_MODEL)
    return proxy_request(handle.base_url, handle.dummy_token, "codex", **kwargs)


def codex_request_from(handle, source_ip: str) -> tuple[int, bytes]:
    listen = urlsplit(handle.base_url)
    connection = HTTPConnection(
        listen.hostname, listen.port, timeout=3, source_address=(source_ip, 0))
    connection.request(
        "POST", RESPONSES_PATH,
        body=json.dumps({"model": CODEX_MODEL, "stream": True}).encode(),
        headers={"authorization": f"Bearer {handle.dummy_token}",
                 "content-type": "application/json"},
    )
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, payload


# --- R3: selection returns this adapter for the row-4 tuple and for no other ---


def test_selects_the_row_four_adapter_for_the_exact_key() -> None:
    adapter = select_adapter(ROW_FOUR_KEY)
    assert isinstance(adapter, OpenAICodexResponsesOAuthAdapter)
    assert adapter.adapter_id == ADAPTER_ID
    assert adapter.schema_version == PROXY_SCHEMA_VERSION


@pytest.mark.parametrize(
    "key",
    [
        CredentialCapabilityKey("pi", "openai-codex", "??", "oauth"),
        CredentialCapabilityKey("pi", "openai-codex", "openai-codex-responses", "api-key"),
        CredentialCapabilityKey("pi", "openai", "openai-codex-responses", "oauth"),
        CredentialCapabilityKey("pi", "openai-codex", "openai-responses", "oauth"),
        CredentialCapabilityKey("pi-cli", "openai-codex", "openai-codex-responses", "oauth"),
        CredentialCapabilityKey("codex-cli", "openai-codex", "openai-codex-responses", "oauth"),
    ],
)
def test_no_neighbouring_key_selects_the_row_four_adapter(
    key: CredentialCapabilityKey,
) -> None:
    with pytest.raises(AdapterUnavailable):
        select_adapter(key)


def test_row_four_key_under_another_schema_version_is_refused() -> None:
    key = CredentialCapabilityKey(
        "pi", "openai-codex", "openai-codex-responses", "oauth",
        "cortex-bench-trial-proxy/1",
    )
    with pytest.raises(AdapterVersionMismatch):
        select_adapter(key)


def test_row_one_key_still_selects_the_row_one_adapter() -> None:
    adapter = select_adapter(
        CredentialCapabilityKey("claude", "anthropic", "anthropic-messages", "api-key-bearer"))
    assert isinstance(adapter, AnthropicMessagesApiKeyAdapter)
    assert not isinstance(adapter, OpenAICodexResponsesOAuthAdapter)


# --- Hazard (i): the dummy credential's shape is a correctness input ---


def test_an_opaque_dummy_fails_the_client_side_account_claim_precondition() -> None:
    # The shipped opaque dummy shape. The client decodes the account id from the
    # token itself and throws before building any body or headers, so a proxy
    # armed with this dummy would observe zero traffic and could not tell that
    # apart from perfect containment.
    with pytest.raises(ValueError):
        extract_account_id(f"dummy-{secrets.token_urlsafe(24)}")


@pytest.mark.parametrize(
    "token",
    [
        "one.two",
        "one.two.three.four",
        codex_token(None),
        codex_token(""),
        ".".join(("aGVhZGVy", "bm90LWpzb24", "c2ln")),
    ],
)
def test_account_claim_extraction_refuses_malformed_tokens(token: str) -> None:
    with pytest.raises(ValueError):
        extract_account_id(token)


def test_this_row_arms_the_proxy_with_a_jwt_shaped_dummy(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            dummy = handle.dummy_token
        finally:
            handle.stop()
    assert len(dummy.split(".")) == 3
    payload = _payload_of(dummy)
    assert isinstance(payload[JWT_ACCOUNT_CLAIM]["chatgpt_account_id"], str)
    assert payload[JWT_ACCOUNT_CLAIM]["chatgpt_account_id"]
    assert extract_account_id(dummy) == payload[JWT_ACCOUNT_CLAIM]["chatgpt_account_id"]


def test_dummies_minted_for_this_row_are_unique_per_proxy(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        first = start_proxy(tmp_path, upstream.base_url)
        second = start_proxy(tmp_path, upstream.base_url)
        try:
            tokens = (first.dummy_token, second.dummy_token)
        finally:
            first.stop()
            second.stop()
    assert tokens[0] != tokens[1]


def test_a_row_without_that_requirement_keeps_the_shipped_opaque_dummy(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_trial_proxy(
            trial_id="trial-row-one", upstream_base_url=upstream.base_url,
            adapter=row_one_adapter(upstream.base_url, "synthetic-key"),
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            budget=ProxyBudget(
                Decimal("20"), Decimal("5"), Decimal("1"), Decimal("1")),
            log_path=tmp_path / "row-one.jsonl",
        )
        try:
            dummy = handle.dummy_token
        finally:
            handle.stop()
    assert dummy.startswith("dummy-")
    assert "." not in dummy


def test_containment_is_asserted_only_after_traffic_is_proven(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(tmp_path, upstream.base_url)
        dummy = handle.dummy_token
        try:
            # Precondition, not decoration: if the dummy failed this check the
            # client would emit nothing and every assertion below would hold
            # vacuously.
            assert extract_account_id(dummy)
            status, _ = codex_request(handle)
        finally:
            handle.stop()
    assert status == 200
    assert len(upstream.requests) == 1
    recorded = upstream.requests[0]
    assert recorded.headers["authorization"] == f"Bearer {HOST_ACCESS_TOKEN}"
    assert recorded.headers[ACCOUNT_ID_HEADER] == HOST_ACCOUNT_ID
    assert dummy not in json.dumps(recorded.headers)
    assert dummy.encode() not in recorded.body


# --- D1: request-route allow-list, failure branches ---


@pytest.mark.parametrize(
    "target",
    [
        "/v1/messages?beta=true",
        "/oauth/token",
        "/backend-api/codex/responses",
        "/codex/responses/stream",
        "/codex",
        "/",
    ],
)
def test_a_route_outside_the_allow_list_is_refused(
    tmp_path: Path, target: str,
) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, payload = codex_request(handle, target=target)
        finally:
            handle.stop()
    assert status == 403
    assert json.loads(payload) == {"error": "route_not_allowed"}
    assert upstream.requests == []


def test_the_allowed_route_refuses_a_query_string_and_a_non_post_method() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    assert adapter.validate_route("POST", f"{RESPONSES_PATH}?stream=true").allow is False
    assert adapter.validate_route("GET", RESPONSES_PATH).allow is False
    assert adapter.validate_route("POST", RESPONSES_PATH).route_id == RESPONSES_ROUTE


def test_a_refused_route_is_audited_without_touching_budget(tmp_path: Path) -> None:
    log_path = tmp_path / "codex.jsonl"
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            codex_request(handle, target="/oauth/token")
        finally:
            handle.stop()
    records = [json.loads(line) for line in log_path.read_text().splitlines()]
    assert [record["outcome"] for record in records] == ["route_denied_token_endpoint"]
    assert records[0]["cost_usd"] == "0"
    assert upstream.requests == []


# --- D2: request-body model validation, failure branches ---


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (b"{not json", "request_body_unparsable"),
        (b"[]", "request_body_unparsable"),
        (b'{"stream":true}', "request_model_absent"),
        (b'{"model":""}', "request_model_absent"),
        (b'{"model":123}', "request_model_absent"),
        (b'{"model":"some-other-model"}', "request_model_mismatch"),
    ],
)
def test_a_body_that_does_not_carry_the_frozen_model_is_refused(
    body: bytes, reason: str,
) -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    decision = adapter.validate_body(RESPONSES_ROUTE, body)
    assert (decision.allow, decision.reason) == (False, reason)


def test_an_unfrozen_model_is_a_refusal_not_a_pass_through() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, None)
    decision = adapter.validate_body(RESPONSES_ROUTE, b'{"model":"anything"}')
    assert (decision.allow, decision.reason) == (False, "request_model_unfrozen")


def test_a_body_offered_under_an_unknown_route_is_refused() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    decision = adapter.validate_body("token_endpoint", b'{"model":"' + CODEX_MODEL.encode() + b'"}')
    assert (decision.allow, decision.reason) == (False, "request_route_unknown")


def test_a_mismatched_model_is_refused_end_to_end(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, payload = codex_request(handle, model="some-other-model")
        finally:
            handle.stop()
    assert status == 400
    assert json.loads(payload) == {"error": "request_model_rejected"}
    assert upstream.requests == []


# --- Hazard (iii): the SSE request body may be zstd-compressed ---


def test_a_zstd_body_is_decoded_before_the_model_is_checked() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    compressed = _zstd(json.dumps({"model": CODEX_MODEL, "stream": True}).encode())
    assert compressed.startswith(ZSTD_MAGIC)
    decision = adapter.validate_body(RESPONSES_ROUTE, compressed)
    assert (decision.allow, decision.requested_model) == (True, CODEX_MODEL)


def test_a_zstd_body_carrying_another_model_is_still_refused() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    compressed = _zstd(json.dumps({"model": "some-other-model"}).encode())
    decision = adapter.validate_body(RESPONSES_ROUTE, compressed)
    assert (decision.allow, decision.reason) == (False, "request_model_mismatch")


def test_an_undecodable_zstd_body_is_refused_rather_than_forwarded() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    decision = adapter.validate_body(RESPONSES_ROUTE, ZSTD_MAGIC + b"not a frame")
    assert (decision.allow, decision.reason) == (False, "request_body_zstd_undecodable")


def test_a_compressed_body_reaches_the_upstream_unchanged(tmp_path: Path) -> None:
    compressed = _zstd(json.dumps({"model": CODEX_MODEL, "stream": True}).encode())
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, _ = codex_request(
                handle, body=compressed,
                extra_headers={"content-encoding": "zstd", "originator": "pi"})
        finally:
            handle.stop()
    assert status == 200
    assert len(upstream.requests) == 1
    assert upstream.requests[0].body == compressed
    assert upstream.requests[0].headers["content-encoding"] == "zstd"


def _zstd(payload: bytes) -> bytes:
    import zstandard

    return zstandard.ZstdCompressor(level=3).compress(payload)


# --- D3: provider-native auth injection, failure branches ---


def test_an_unbound_credential_refuses_instead_of_forwarding(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url, credential=None)
        try:
            status, payload = codex_request(handle)
        finally:
            handle.stop()
    assert status == 502
    assert json.loads(payload) == {"error": "auth_injection_unavailable"}
    assert upstream.requests == []


def test_auth_injection_refuses_a_route_that_carries_no_auth_form() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    with pytest.raises(AuthInjectionUnavailable):
        adapter.inject_auth({}, "token_endpoint")


def test_a_credential_without_the_account_claim_is_a_start_time_refusal() -> None:
    with pytest.raises(ValueError):
        OpenAICodexResponsesOAuthAdapter(
            "http://127.0.0.1:1", "sk-opaque-not-a-jwt", CODEX_MODEL)


def test_injection_replaces_the_container_account_id_and_keeps_client_headers() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    outbound = adapter.inject_auth(
        {
            # Header names are case-insensitive on the wire, so a container that
            # varies the casing would otherwise get its own account id forwarded
            # beside the host's.
            "Chatgpt-Account-Id": "acct-container-dummy",
            "Authorization": "Bearer container-dummy",
            "originator": "pi",
            "openai-beta": "responses=experimental",
            "session-id": "s-1",
            "x-client-request-id": "r-1",
            "content-encoding": "zstd",
        },
        RESPONSES_ROUTE,
    )
    account_headers = {
        key: value for key, value in outbound.items()
        if key.lower() == ACCOUNT_ID_HEADER
    }
    auth_headers = {
        key: value for key, value in outbound.items() if key.lower() == "authorization"
    }
    assert account_headers == {ACCOUNT_ID_HEADER: HOST_ACCOUNT_ID}
    assert auth_headers == {"authorization": f"Bearer {HOST_ACCESS_TOKEN}"}
    assert "acct-container-dummy" not in outbound.values()
    assert outbound["originator"] == "pi"
    assert outbound["openai-beta"] == "responses=experimental"
    assert outbound["session-id"] == "s-1"
    assert outbound["x-client-request-id"] == "r-1"
    assert outbound["content-encoding"] == "zstd"


def test_the_forwarded_request_keeps_the_headers_the_client_needs(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            codex_request(handle, extra_headers={
                "originator": "pi",
                "openai-beta": "responses=experimental",
                "session-id": "s-9",
                "x-client-request-id": "r-9",
                "Chatgpt-Account-Id": "acct-container-dummy",
            })
        finally:
            handle.stop()
    headers = upstream.requests[0].headers
    assert "acct-container-dummy" not in headers.values()
    assert headers["originator"] == "pi"
    assert headers["openai-beta"] == "responses=experimental"
    assert headers["session-id"] == "s-9"
    assert headers["x-client-request-id"] == "r-9"
    assert headers[ACCOUNT_ID_HEADER] == HOST_ACCOUNT_ID


# --- D4: usage extraction, keyed on the wire event name ---


def test_usage_is_read_from_the_wire_terminal_event(tmp_path: Path) -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    body = sse_stream([
        {"type": "response.created", "response": {"id": "resp_synthetic"}},
        {"type": "response.output_text.delta", "delta": "hi"},
        terminal_event(),
    ])
    usage = adapter.extract_usage(body, "text/event-stream")
    assert usage.accounted is True
    assert (usage.input_tokens, usage.output_tokens) == (3, 2)
    assert usage.upstream_model == CODEX_MODEL


def test_a_stream_whose_only_terminal_event_uses_the_normalized_name_is_metered() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    usage = adapter.extract_usage(
        sse_stream([terminal_event(name="response.completed")]), "text/event-stream")
    assert usage.accounted is True


def test_a_stream_that_never_reaches_a_terminal_event_is_unmetered_not_zero() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    usage = adapter.extract_usage(
        sse_stream([
            {"type": "response.created", "response": {"id": "resp_synthetic"}},
            {"type": "response.output_text.delta", "delta": "hi"},
        ], done=False),
        "text/event-stream",
    )
    assert usage.accounted is False
    assert (usage.input_tokens, usage.output_tokens) == (0, 0)


def test_a_terminal_event_without_a_usage_block_is_unmetered() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    usage = adapter.extract_usage(
        sse_stream([{"type": "response.done", "response": {"id": "resp_synthetic"}}]),
        "text/event-stream",
    )
    assert usage.accounted is False


@pytest.mark.parametrize(
    "event",
    [
        {"type": "response.failed", "response": {"error": {"code": "server_error"}}},
        {"type": "error", "code": "usage_limit_reached", "message": "limit"},
    ],
)
def test_an_error_terminated_stream_is_unmetered(event: dict[str, object]) -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    usage = adapter.extract_usage(sse_stream([event]), "text/event-stream")
    assert usage.accounted is False


@pytest.mark.parametrize(
    "body",
    [
        # A response object of the shape the terminal event carries, and the
        # terminal event's own bytes: neither is metered under a non-stream
        # content type, because this row emits no non-streaming call at all.
        json.dumps(terminal_event()["response"]).encode(),
        sse_stream([terminal_event()]),
    ],
)
def test_a_non_streaming_response_is_unmetered_because_this_row_has_no_such_shape(
    body: bytes,
) -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    usage = adapter.extract_usage(body, "application/json")
    assert usage.accounted is False


def test_an_unparsable_event_does_not_leave_a_partial_count_looking_complete() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    body = b"data: {not json\n\n" + sse_stream([terminal_event()])
    usage = adapter.extract_usage(body, "text/event-stream")
    assert usage.accounted is False


def test_a_cancelled_call_is_reported_unmetered_and_revokes_the_route(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / "codex.jsonl"
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([
            {"type": "response.created", "response": {"id": "resp_synthetic"}},
            {"type": "response.output_text.delta", "delta": "partial"},
        ], done=False))
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, payload = codex_request(handle)
            after, _ = codex_request(handle)
        finally:
            handle.stop()
    assert (status, after) == (502, 410)
    assert json.loads(payload) == {"error": "budget_accounting_unavailable"}
    records = [json.loads(line) for line in log_path.read_text().splitlines()]
    assert records[0]["outcome"] == "budget_accounting_unavailable"
    assert records[0]["tokens"] == {"input": 0, "output": 0, "total": 0}


# --- D5: billable quantities, and the enforcer that consumes them ---


def test_billable_never_discounts_cached_or_cache_write_input_tokens() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    usage = adapter.extract_usage(
        sse_stream([terminal_event()]), "text/event-stream")
    billable = adapter.billable(usage)
    # The client subtracts cached and cache-write tokens from the input count;
    # the proxy bills the whole count, because under-billing is the direction
    # that lets real spend outrun the limit.
    assert (billable.input_tokens, billable.output_tokens) == (3, 2)


def test_billable_refuses_an_unaccounted_usage() -> None:
    adapter = OpenAICodexResponsesOAuthAdapter(
        "http://127.0.0.1:1", HOST_ACCESS_TOKEN, CODEX_MODEL)
    usage = adapter.extract_usage(b"", "text/event-stream")
    with pytest.raises(ValueError):
        adapter.billable(usage)


def test_a_priced_call_beyond_the_per_request_limit_is_refused(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_trial_proxy(
            trial_id="trial-codex-limit", upstream_base_url=upstream.base_url,
            adapter=row_four_adapter(upstream.base_url),
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            budget=ProxyBudget(
                Decimal("20"), Decimal("0.000001"), Decimal("1000000"),
                Decimal("1000000")),
            log_path=tmp_path / "codex-limit.jsonl",
        )
        try:
            status, payload = codex_request(handle)
            after, _ = codex_request(handle)
        finally:
            handle.stop()
    assert (status, after) == (502, 410)
    assert json.loads(payload) == {"error": "budget_accounting_exceeded"}


# --- R5: H7 properties 1, 2, 3 and 6 re-executed against this adapter ---


def test_h7_property_1_source_binding_holds_for_this_adapter(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(tmp_path, upstream.base_url, bound_source_ip="127.0.0.9")
        try:
            bound = codex_request_from(handle, "127.0.0.9")
            unbound = codex_request(handle)
        finally:
            handle.stop()
    assert bound[0] == 200
    assert unbound[0] == 403
    assert json.loads(unbound[1]) == {"error": "source_rejected"}
    assert len(upstream.requests) == 1


def test_h7_property_2_budget_cutoff_holds_for_this_adapter(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(tmp_path, upstream.base_url, max_cost="5")
        try:
            first, _ = codex_request(handle)
            second, payload = codex_request(handle)
        finally:
            handle.stop()
    assert (first, second) == (200, 429)
    assert json.loads(payload) == {"error": "budget_exhausted"}
    assert len(upstream.requests) == 1


def test_h7_property_3_deadline_revocation_holds_for_this_adapter(
    tmp_path: Path,
) -> None:
    deadline = datetime.now(UTC) + timedelta(seconds=2)
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(tmp_path, upstream.base_url, deadline=deadline)
        try:
            before, _ = codex_request(handle)
            while datetime.now(UTC) <= deadline:
                pass
            after, payload = codex_request(handle)
        finally:
            handle.stop()
    assert (before, after) == (200, 410)
    assert json.loads(payload) == {"error": "deadline_expired"}
    assert len(upstream.requests) == 1


def test_h7_property_6_route_is_dead_after_stop_for_this_adapter(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(tmp_path, upstream.base_url)
        alive, _ = codex_request(handle)
        handle.stop()
        with pytest.raises(OSError):
            codex_request(handle)
    assert alive == 200
    assert len(upstream.requests) == 1


def test_the_manifest_records_this_adapter_and_no_credential(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            block = handle.manifest_block
        finally:
            handle.stop()
    assert block["adapter_id"] == ADAPTER_ID
    assert block["schema_version"] == PROXY_SCHEMA_VERSION
    assert HOST_ACCESS_TOKEN not in json.dumps(block)
    assert SYNTHETIC_MODEL not in json.dumps(block)
