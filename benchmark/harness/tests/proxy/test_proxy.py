# input:  trial proxy API and synthetic model upstream
# output: forwarding, budget, deadline, stop, and redaction proofs
# pos:    Core proxy behavior tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from synthetic import SyntheticUpstream, proxy_request

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
        real_credential=REAL_CREDENTIAL,
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
    assert headers["authorization"] == f"Bearer {REAL_CREDENTIAL}"
    assert handle.dummy_token not in json.dumps(headers)
    assert REAL_CREDENTIAL not in repr(handle)


def test_rejects_request_without_enough_budget_for_maximum_call(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_trial_proxy(
            trial_id="trial-reservation", upstream_base_url=upstream.base_url,
            real_credential=REAL_CREDENTIAL, bound_source_ip="127.0.0.1",
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
    connection.putrequest("POST", "/v1/messages")
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


def test_route_is_dead_after_trial_stop(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream)
        assert proxy_request(handle.base_url, handle.dummy_token, "live")[0] == 200
        handle.stop()
        with pytest.raises(OSError):
            proxy_request(handle.base_url, handle.dummy_token, "dead")
    assert len(upstream.requests) == 1


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
