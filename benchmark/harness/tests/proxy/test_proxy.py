# input:  trial proxy API and synthetic model upstream
# output: forwarding, budget, deadline, stop, and redaction proofs
# pos:    Core proxy behavior tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import socket
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest

import cortex_bench_harness.proxy.server as proxy_server
from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from synthetic import (
    MESSAGES_TARGET,
    SyntheticUpstream,
    proxy_request,
    row_one_adapter,
)

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-PROXY-UNIQUE"
PLANTED_PROMPT = "PROMPT-PLANT-2e47d8b8"


def budget(max_cost: str = "5", max_request_cost: str = "5") -> ProxyBudget:
    return ProxyBudget(
        max_cost_usd=Decimal(max_cost),
        max_request_cost_usd=Decimal(max_request_cost),
        input_cost_per_million_usd=Decimal("1000000"),
        output_cost_per_million_usd=Decimal("1000000"),
    )


def start_proxy(
    tmp_path: Path, upstream: SyntheticUpstream, *, deadline: datetime | None = None,
    max_cost: str = "5",
):
    return start_trial_proxy(
        trial_id="trial-synthetic",
        upstream_base_url=upstream.base_url,
        adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
        bound_source_ip="127.0.0.1",
        absolute_deadline=deadline or datetime.now(UTC) + timedelta(minutes=5),
        budget=budget(max_cost),
        log_path=tmp_path / "proxy.jsonl",
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


def test_rejects_request_without_enough_budget_for_maximum_call(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_trial_proxy(
            trial_id="trial-reservation", upstream_base_url=upstream.base_url,
            adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            budget=budget("4", "5"), log_path=tmp_path / "reservation.jsonl",
        )
        try:
            status, payload = proxy_request(handle.base_url, handle.dummy_token, "blocked")
        finally:
            handle.stop()
    assert status == 429
    assert json.loads(payload) == {"error": "budget_exhausted"}
    assert upstream.requests == []


def test_rejects_requests_after_budget_is_consumed(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream)
        try:
            first, _ = proxy_request(handle.base_url, handle.dummy_token, "first")
            second, payload = proxy_request(handle.base_url, handle.dummy_token, "second")
        finally:
            handle.stop()
    assert first == 200
    assert second == 429
    assert json.loads(payload) == {"error": "budget_exhausted"}
    assert len(upstream.requests) == 1


def test_connect_failure_releases_reservation_and_writes_audit(tmp_path: Path) -> None:
    port = _unused_port()
    log_path = tmp_path / "attempts.jsonl"
    handle = start_trial_proxy(
        trial_id="trial-attempt", upstream_base_url=f"http://127.0.0.1:{port}",
        adapter=row_one_adapter(f"http://127.0.0.1:{port}", REAL_CREDENTIAL),
        bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        budget=budget(), log_path=log_path,
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
        "cost_usd": "0", "outcome": "upstream_unavailable",
        "request_count": 1, "tokens": {"input": 0, "output": 0, "total": 0},
        "upstream_model": None,
    }
    assert records[1]["request_count"] == 2


def _unused_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def test_missing_upstream_usage_revokes_budget_route(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.response = {
            "model": "claude-synthetic-1", "usage": {}, "content": [],
        }
        handle = start_proxy(tmp_path, upstream, max_cost="20")
        try:
            first, payload = proxy_request(handle.base_url, handle.dummy_token, "unknown")
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "retry")
        finally:
            handle.stop()
    assert first == 502
    assert json.loads(payload) == {"error": "budget_accounting_unavailable"}
    assert second == 410
    assert len(upstream.requests) == 1


def test_sse_usage_allows_fields_split_across_events() -> None:
    body = _sse_body([
        {"message": {"model": "claude-synthetic-1",
                     "usage": {"input_tokens": 2}}},
        {"usage": {"output_tokens": 3}},
    ])
    usage = _adapter().extract_usage(body, "text/event-stream")
    assert usage.accounted is True
    assert (usage.input_tokens, usage.output_tokens) == (2, 3)


def test_sse_usage_rejects_later_malformed_token_field() -> None:
    body = _sse_body([
        {"message": {"model": "claude-synthetic-1",
                     "usage": {"input_tokens": 2, "output_tokens": 3}}},
        {"usage": {"output_tokens": -1}},
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
        handle = start_proxy(tmp_path, upstream, max_cost="20")
        try:
            first, payload = proxy_request(handle.base_url, handle.dummy_token, "unknown")
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "retry")
        finally:
            handle.stop()
    assert first == 502
    assert json.loads(payload) == {"error": "budget_accounting_unavailable"}
    assert second == 410
    assert len(upstream.requests) == 1


def test_revokes_request_that_crosses_absolute_deadline(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(milliseconds=250)
    with SyntheticUpstream() as upstream:
        upstream.server.response_delay_seconds = 5.0
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_cost="20")
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
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_cost="20")
        started = time.monotonic()
        try:
            status, payload = proxy_request(handle.base_url, handle.dummy_token, "trickle")
            response_elapsed = time.monotonic() - started
        finally:
            handle.stop()
    assert status == 410
    assert json.loads(payload) == {"error": "deadline_expired"}
    assert response_elapsed < 1.0
    assert len(upstream.requests) == 1


def test_body_finishing_after_deadline_never_reaches_upstream(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(milliseconds=200)
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_cost="20")
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
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_cost="20")
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
        handle = start_proxy(tmp_path, upstream, max_cost="20")
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
        handle = start_proxy(tmp_path, upstream, deadline=deadline, max_cost="20")
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
        handle = start_proxy(tmp_path, upstream, max_cost="20")
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
            budget=budget("20", "5"), log_path=log_path,
        )
        try:
            first, payload = proxy_request(handle.base_url, handle.dummy_token, "logged")
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "blocked")
        finally:
            handle.stop()
    assert first == 500
    assert json.loads(payload) == {"error": "audit_log_unavailable"}
    assert second == 410
    assert len(upstream.requests) == 1
    assert handle._server.state.request_count == 0
    assert handle._server.state.cost_usd == Decimal("0")
    assert handle._server.state.input_tokens == 0
    assert handle._server.state.output_tokens == 0


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
        "cost_usd": "5", "request_count": 1, "upstream_model": "claude-synthetic-1",
        "tokens": {"input": 2, "output": 3, "total": 5},
    }
    assert REAL_CREDENTIAL.encode() not in log_bytes
    assert PLANTED_PROMPT.encode() not in log_bytes
