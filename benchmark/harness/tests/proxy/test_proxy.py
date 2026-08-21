# input:  trial proxy API and synthetic model upstream
# output: forwarding, the declared request count, deadline, stop, and redaction proofs
# pos:    Core proxy behavior tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import socket
import time
from datetime import UTC, datetime, timedelta
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest

import cortex_bench_harness.proxy.server as proxy_server
from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey
from cortex_bench_harness.proxy import ProxyLimits, start_trial_proxy
from cortex_bench_harness.proxy.adapters import select_adapter
from synthetic import (
    LEASE_TERMS,
    MESSAGES_TARGET,
    SyntheticUpstream,
    abandoned_proxy_request,
    proxy_request,
    row_one_adapter,
    streamed_proxy_request,
)

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-PROXY-UNIQUE"
PLANTED_PROMPT = "PROMPT-PLANT-2e47d8b8"


def limits(max_requests: int = 1) -> ProxyLimits:
    return ProxyLimits(max_requests=max_requests)


def start_proxy(
    tmp_path: Path, upstream: SyntheticUpstream, *, deadline: datetime | None = None,
    max_requests: int = 1,
):
    return start_trial_proxy(
        trial_id="trial-synthetic",
        upstream_base_url=upstream.base_url,
        adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
        bound_source_ip="127.0.0.1",
        absolute_deadline=deadline or datetime.now(UTC) + timedelta(minutes=5),
        limits=limits(max_requests),
        log_path=tmp_path / "proxy.jsonl",
        lease_terms=LEASE_TERMS,
    )


def test_injects_host_credential_without_forwarding_dummy(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream)
        try:
            status, _ = proxy_request(handle.base_url, handle.dummy_token, PLANTED_PROMPT)
        finally:
            handle.stop()
    headers = {key.lower(): value for key, value in upstream.requests[0].headers.items()}
    assert status == 200
    assert headers["x-api-key"] == REAL_CREDENTIAL
    assert "authorization" not in headers
    assert handle.dummy_token not in json.dumps(headers)
    assert REAL_CREDENTIAL not in repr(handle)


def test_claude_subscription_offline_contract_reaches_only_synthetic_upstream(
    tmp_path: Path,
) -> None:
    host_token = "sk-ant-oat01-SYNTHETIC-HOST-SUBSCRIPTION"
    beta = "claude-code-20250219,interleaved-thinking-2025-05-14"
    with SyntheticUpstream() as upstream:
        adapter = select_adapter(
            CredentialCapabilityKey(
                "claude-code", "anthropic", "anthropic-messages", "subscription-oauth",
            ),
            upstream_base_url=upstream.base_url, credential=host_token,
            frozen_model="claude-synthetic-1",
        )
        handle = start_trial_proxy(
            trial_id="trial-claude-subscription-synthetic",
            upstream_base_url=upstream.base_url, adapter=adapter,
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            limits=limits(), log_path=tmp_path / "claude-subscription.jsonl",
            lease_terms=LEASE_TERMS,
        )
        try:
            status, _ = proxy_request(
                handle.base_url, handle.dummy_token, PLANTED_PROMPT,
                extra_headers={
                    "anthropic-beta": beta,
                    "anthropic-version": "2023-06-01",
                },
            )
        finally:
            handle.stop()

    headers = {key.lower(): value for key, value in upstream.requests[0].headers.items()}
    assert status == 200
    assert upstream.base_url.startswith("http://127.0.0.1:")
    assert headers["authorization"] == f"Bearer {host_token}"
    assert headers["anthropic-beta"] == beta
    assert headers["anthropic-version"] == "2023-06-01"
    assert "x-api-key" not in headers
    assert handle.dummy_token not in json.dumps(headers)


def audit_rows(tmp_path: Path) -> list[dict]:
    path = tmp_path / "proxy.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def await_delivery_row(tmp_path: Path, timeout: float = 10) -> list[dict]:
    """The proxy keeps draining the upstream after the client leaves — the request was already
    counted and its usage still has to be read — so the delivery row lands after the last byte,
    not at the moment the client vanished."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rows = [row for row in audit_rows(tmp_path) if row.get("event") == "delivery"]
        if rows:
            return rows
        time.sleep(0.05)
    raise AssertionError("no delivery row was recorded")


def test_a_response_the_client_never_received_is_still_recorded_as_billed_and_lost(
    tmp_path: Path,
) -> None:
    """Reconciling to the cent says nothing about whether the trial got what it paid for.

    The 2026-08-13 paid trial's proxy record and the provider's bill agreed exactly while 42.5%
    of the spend bought responses the client had already stopped waiting for. Streaming removed
    that cause; without this row the proxy would still have no way to say it had happened.
    """
    with SyntheticUpstream() as upstream:
        upstream.server.raw_body = json.dumps(upstream.server.response).encode()
        upstream.server.response_chunk_delay_seconds = 0.01
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        try:
            status = abandoned_proxy_request(handle.base_url, handle.dummy_token, "abandoned")
            delivery = await_delivery_row(tmp_path)
            export = handle.accounting_export
        finally:
            handle.stop()

    assert status == 200
    assert delivery == [{
        "event": "delivery", "outcome": "client_gone_after_accounting", "request_count_at": 1,
    }]
    assert export["audit_log"]["value"]["outcomes"] == {"client_gone_after_accounting": 1}
    # The lost response is NOT a second request, and the money is counted exactly once.
    assert export["requests"]["value"] == 1
    assert export["audit_log"]["value"]["durable_requests"] == 1
    assert export["audit_log"]["value"]["agrees_with_counters"] is True


def test_a_client_that_gave_up_on_one_turn_may_still_ask_for_the_next(
    tmp_path: Path,
) -> None:
    """Losing a response is not a lifecycle event.

    Revoking the route here would turn one abandoned turn into the end of the run — which is the
    opposite of what the observation is for.
    """
    with SyntheticUpstream() as upstream:
        upstream.server.raw_body = json.dumps(upstream.server.response).encode()
        upstream.server.response_chunk_delay_seconds = 0.01
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        try:
            abandoned_proxy_request(handle.base_url, handle.dummy_token, "abandoned")
            await_delivery_row(tmp_path)
            upstream.server.response_chunk_delay_seconds = 0
            result = streamed_proxy_request(handle.base_url, handle.dummy_token, "next")
        finally:
            handle.stop()

    assert (result.status, result.complete) == (200, True)


def test_slow_response_reaches_the_client_while_it_is_still_being_produced(
    tmp_path: Path,
) -> None:
    """A response must not be withheld until the upstream has finished producing it.

    The 2026-08-13 paid trial lost 7 of 16 billed responses to this: every admitted route
    requires `stream: true`, the proxy read the whole stream before writing anything, and the
    client's read deadline fired mid-generation. Each abandoned turn was generated and billed
    in full, then retried against an unchanged prompt.
    """
    with SyntheticUpstream() as upstream:
        upstream.server.raw_body = json.dumps(upstream.server.response).encode()
        upstream.server.response_chunk_delay_seconds = 0.004
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        try:
            result = streamed_proxy_request(
                handle.base_url, handle.dummy_token, "slow", timeout=30)
        finally:
            handle.stop()
    assert result.complete is True
    assert result.body == upstream.server.raw_body
    assert result.total_seconds > 0.3
    # The client is reading long before the upstream is done, so an idle deadline anywhere in
    # the client cannot expire on a response that is in fact arriving.
    assert result.first_byte_seconds < result.total_seconds / 2


def test_rejects_requests_after_the_request_count_is_consumed(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream)
        try:
            first, _ = proxy_request(handle.base_url, handle.dummy_token, "first")
            second, payload = proxy_request(handle.base_url, handle.dummy_token, "second")
        finally:
            handle.stop()
    assert first == 200
    assert second == 429
    assert json.loads(payload) == {"error": "requests_exhausted"}
    assert len(upstream.requests) == 1


def test_connect_failure_releases_reservation_and_writes_audit(tmp_path: Path) -> None:
    port = _unused_port()
    log_path = tmp_path / "attempts.jsonl"
    handle = start_trial_proxy(
        trial_id="trial-attempt", upstream_base_url=f"http://127.0.0.1:{port}",
        adapter=row_one_adapter(f"http://127.0.0.1:{port}", REAL_CREDENTIAL),
        bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        limits=limits(), log_path=log_path, lease_terms=LEASE_TERMS,
    )
    try:
        first, _ = proxy_request(handle.base_url, handle.dummy_token, "connect-fail")
        with SyntheticUpstream(bind_port=port):
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "retry")
    finally:
        handle.stop()
    records = [json.loads(line) for line in log_path.read_text().splitlines()]
    assert (first, second) == (502, 200)
    assert records[0] == {
        "outcome": "upstream_unavailable",
        "request_count": 1, "tokens": {"input": 0, "output": 0, "total": 0, "cached": 0},
        "upstream_model": None,
    }
    assert records[1]["request_count"] == 2


def test_interrupted_upstream_stream_keeps_route_retryable(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.truncate_after_bytes = 16
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        try:
            first = streamed_proxy_request(handle.base_url, handle.dummy_token, "interrupted")
            upstream.server.truncate_after_bytes = None
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "retry")
        finally:
            handle.stop()

    rows = audit_rows(tmp_path)
    assert (first.complete, second) == (False, 200)
    assert rows[0]["outcome"] == "upstream_unavailable"
    assert rows[1]["request_count"] == 2
    assert len(upstream.requests) == 2


def _unused_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def test_missing_upstream_usage_revokes_budget_route(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.response = {
            "model": "claude-synthetic-1", "usage": {}, "content": [],
        }
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        try:
            first = streamed_proxy_request(
                handle.base_url, handle.dummy_token, "unknown")
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "retry")
        finally:
            handle.stop()
    # The refusal is decided only after the body has been read for usage, by which time the
    # response is already on the wire, so it is delivered as a truncated stream rather than
    # as a status the client can no longer be sent.
    assert first.complete is False
    assert second == 410
    assert len(upstream.requests) == 1


def test_sse_usage_allows_fields_split_across_events() -> None:
    body = _sse_body([
        {"type": "message_start",
         "message": {"model": "claude-synthetic-1",
                     "usage": {"input_tokens": 2}}},
        {"type": "message_delta", "usage": {"output_tokens": 3}},
    ])
    usage = _adapter().extract_usage(body, "text/event-stream")
    assert usage.accounted is True
    assert (usage.input_tokens, usage.output_tokens) == (2, 3)


def test_sse_usage_rejects_later_malformed_token_field() -> None:
    body = _sse_body([
        {"type": "message_start",
         "message": {"model": "claude-synthetic-1",
                     "usage": {"input_tokens": 2, "output_tokens": 3}}},
        {"type": "message_delta", "usage": {"output_tokens": -1}},
    ])
    assert _adapter().extract_usage(body, "text/event-stream").accounted is False


def _adapter():
    return row_one_adapter("http://127.0.0.1:9000", REAL_CREDENTIAL)


def _sse_body(documents: list[dict[str, object]]) -> bytes:
    lines = [f"data: {json.dumps(document)}" for document in documents]
    return ("\n\n".join(lines) + "\n\n").encode()


def test_empty_upstream_model_identity_revokes_budget_route(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.response["model"] = "  "
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        try:
            first = streamed_proxy_request(
                handle.base_url, handle.dummy_token, "unknown")
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "retry")
        finally:
            handle.stop()
    assert first.complete is False
    assert second == 410
    assert len(upstream.requests) == 1


def test_revokes_request_that_crosses_absolute_deadline(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(milliseconds=250)
    with SyntheticUpstream() as upstream:
        upstream.server.response_delay_seconds = 5.0
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_requests=4)
        started = time.monotonic()
        try:
            status, payload = proxy_request(handle.base_url, handle.dummy_token, "slow")
            response_elapsed = time.monotonic() - started
        finally:
            handle.stop()
    assert status == 410
    assert json.loads(payload) == {"error": "deadline_expired"}
    assert response_elapsed < 1.5
    assert len(upstream.requests) == 1


def test_trickled_upstream_is_cut_at_absolute_deadline(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(milliseconds=250)
    with SyntheticUpstream() as upstream:
        upstream.server.response_chunk_delay_seconds = 0.02
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_requests=4)
        try:
            result = streamed_proxy_request(
                handle.base_url, handle.dummy_token, "trickle")
            retry, _ = proxy_request(handle.base_url, handle.dummy_token, "retry")
        finally:
            handle.stop()
    # A trickle is relayed as it arrives, so the deadline now cuts a stream the client has
    # already begun reading: it ends unterminated, and the route is dead behind it.
    assert result.complete is False
    assert result.total_seconds < 1.0
    assert retry == 410
    assert len(upstream.requests) == 1


def test_body_finishing_after_deadline_never_reaches_upstream(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(milliseconds=200)
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_requests=4)
        try:
            status, payload = _slow_body_request(handle.base_url, handle.dummy_token, deadline)
        finally:
            handle.stop()
    assert status == 410
    assert json.loads(payload) == {"error": "deadline_expired"}
    assert upstream.requests == []


def _slow_body_request(base_url: str, token: str, deadline: datetime) -> tuple[int, bytes]:
    target = urlsplit(base_url)
    connection = HTTPConnection(target.hostname, target.port, timeout=3)
    body = b'{"prompt":"slow-body"}'
    connection.putrequest("POST", MESSAGES_TARGET)
    connection.putheader("authorization", f"Bearer {token}")
    connection.putheader("content-length", str(len(body)))
    connection.endheaders(body[:1])
    while datetime.now(UTC) <= deadline:
        time.sleep(0.01)
    connection.send(body[1:])
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, payload


def test_rejects_requests_after_absolute_deadline(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(seconds=2)
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_requests=4)
        try:
            before, _ = proxy_request(handle.base_url, handle.dummy_token, "before")
            while datetime.now(UTC) <= deadline:
                time.sleep(0.01)
            after, payload = proxy_request(handle.base_url, handle.dummy_token, "after")
        finally:
            handle.stop()
    assert before == 200
    assert after == 410
    assert json.loads(payload) == {"error": "deadline_expired"}
    assert len(upstream.requests) == 1


def test_permanently_stalled_body_does_not_block_another_request(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        stalled = _stalled_body_socket(handle.base_url, handle.dummy_token)
        try:
            _wait_for_body_client(handle)
            status, _ = proxy_request(handle.base_url, handle.dummy_token, "independent")
        finally:
            stalled.close()
            handle.stop()
    assert status == 200
    assert len(upstream.requests) == 1


def test_deadline_rejects_permanently_stalled_body(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(milliseconds=250)
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_requests=4)
        stalled = _stalled_body_socket(handle.base_url, handle.dummy_token)
        try:
            stalled.settimeout(2)
            response = stalled.recv(4096)
            _wait_for_no_clients(handle)
        finally:
            stalled.close()
            handle.stop()
    assert b" 410 " in response
    assert upstream.requests == []


def test_stop_closes_permanently_stalled_body_handler(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream, max_requests=4)
        stalled = _stalled_body_socket(handle.base_url, handle.dummy_token)
        try:
            _wait_for_body_client(handle)
            handle.stop()
            stalled.settimeout(2)
            assert stalled.recv(1024) == b""
            assert handle._server.active_client_count == 0
        finally:
            stalled.close()
            handle.stop()


def _stalled_body_socket(base_url: str, token: str) -> socket.socket:
    target = urlsplit(base_url)
    client = socket.create_connection((target.hostname or "", target.port or 80), timeout=3)
    headers = (
        f"POST {MESSAGES_TARGET} HTTP/1.1\r\nHost: proxy\r\n"
        f"Authorization: Bearer {token}\r\nContent-Length: 100\r\n\r\nX"
    )
    client.sendall(headers.encode())
    return client


def _wait_for_body_client(handle) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if handle._server.body_client_count == 1:
            return
        time.sleep(0.01)
    raise AssertionError("proxy did not enter the body-read state")


def _wait_for_no_clients(handle) -> None:
    _wait_for_client_count(handle, 0)


def _wait_for_client_count(handle, expected: int) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if handle._server.active_client_count == expected:
            return
        time.sleep(0.01)
    raise AssertionError(f"proxy client count did not reach {expected}")


def test_route_is_dead_after_trial_stop(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream)
        assert proxy_request(handle.base_url, handle.dummy_token, "live")[0] == 200
        handle.stop()
        with pytest.raises(OSError):
            proxy_request(handle.base_url, handle.dummy_token, "dead")
    assert len(upstream.requests) == 1


@pytest.mark.parametrize("phase", ["open", "write", "fsync"])
def test_log_persistence_failure_revokes_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str,
) -> None:
    log_path = _failing_log_path(tmp_path, monkeypatch, phase)
    with SyntheticUpstream() as upstream:
        handle = start_trial_proxy(
            trial_id="trial-log-failure", upstream_base_url=upstream.base_url,
            adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            limits=limits(4), log_path=log_path, lease_terms=LEASE_TERMS,
        )
        try:
            first = streamed_proxy_request(
                handle.base_url, handle.dummy_token, "logged")
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "blocked")
        finally:
            handle.stop()
    assert first.complete is False
    assert second == 410
    assert len(upstream.requests) == 1
    assert handle._server.state.request_count == 0
    assert handle._server.state.input_tokens == 0
    assert handle._server.state.output_tokens == 0
    # The reservation is not handed back. A request whose audit row could not be persisted is a
    # request this side cannot account for, so its slot stays spent — the error is resolved
    # against the ceiling, never in favour of admitting one more call.
    assert handle._server.state.reserved_requests == 1


def _failing_log_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str,
) -> Path:
    if phase == "open":
        path = tmp_path / "log-directory"
        path.mkdir()
        return path
    if phase == "write":
        return Path("/dev/full")
    monkeypatch.setattr(proxy_server.os, "fsync", _raise_fsync)
    return tmp_path / "fsync.jsonl"


def _raise_fsync(_file_descriptor: int) -> None:
    raise OSError("synthetic fsync failure")


def test_logs_only_aggregate_usage_and_model_identity(tmp_path: Path) -> None:
    log_path = tmp_path / "proxy.jsonl"
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream)
        try:
            assert proxy_request(handle.base_url, handle.dummy_token, PLANTED_PROMPT)[0] == 200
        finally:
            handle.stop()
    log_bytes = log_path.read_bytes()
    record = json.loads(log_bytes)
    assert record == {
        "request_count": 1, "upstream_model": "claude-synthetic-1",
        "tokens": {"input": 2, "output": 3, "total": 5, "cached": None},
    }
    assert REAL_CREDENTIAL.encode() not in log_bytes
    assert PLANTED_PROMPT.encode() not in log_bytes


# --- how many turns the declared bound actually buys ---------------------------------------------
#
# The 2026-08-13 paid attempt declared `max_cost_usd: 2.00` against `max_request_cost_usd: 0.50`
# and stopped after four requests with `429 budget_exhausted`, because admission reserved one whole
# `max_request_cost_usd` per request and never reconciled it: the pair was `floor(2.00 / 0.50)`, a
# request counter written in dollars. It is now written as a count, so the bound is the count, and
# this run is that bound, offline.


def drive_turns(tmp_path: Path, max_requests: int, turns: int) -> list[int]:
    with SyntheticUpstream() as upstream:
        handle = start_trial_proxy(
            trial_id="trial-turns", upstream_base_url=upstream.base_url,
            adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            limits=ProxyLimits(max_requests=max_requests),
            log_path=tmp_path / f"turns-{max_requests}.jsonl",
            lease_terms=LEASE_TERMS,
        )
        try:
            return [
                proxy_request(handle.base_url, handle.dummy_token, f"turn-{turn}")[0]
                for turn in range(turns)
            ]
        finally:
            handle.stop()


def test_the_declared_count_is_exactly_the_number_of_turns_admitted(tmp_path: Path) -> None:
    assert drive_turns(tmp_path, 4, 5) == [200, 200, 200, 200, 429]


def test_a_larger_count_admits_a_longer_conversation(tmp_path: Path) -> None:
    """Turn depth is now raised by declaring more turns, not by re-deriving a quotient."""
    assert drive_turns(tmp_path, 12, 12) == [200] * 12
