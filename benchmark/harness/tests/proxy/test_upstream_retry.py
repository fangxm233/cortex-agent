# input:  a synthetic upstream that answers with provider error statuses
# output: proof that a provider outage costs attempts, not the route
# pos:    Upstream error-status retry and non-revocation tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# On 2026-08-23 nineteen of forty-nine paid tasks scored zero without ever failing at their
# task: each took a single upstream 502, the error body failed usage extraction, and the route
# was revoked for the rest of the trial (EXP-091). These tests pin the two halves of the fix --
# an error status is a failed attempt that may be repeated, and a failed attempt does not end
# the route.

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cortex_bench_harness.proxy import ProxyLimits, start_trial_proxy
from synthetic import (
    LEASE_TERMS,
    SyntheticUpstream,
    proxy_request,
    row_one_adapter,
    streamed_proxy_request,
)

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-RETRY-UNIQUE"


def start_proxy(
    tmp_path: Path, upstream: SyntheticUpstream, *, max_requests: int = 4,
    max_attempts: int = 3,
):
    return start_trial_proxy(
        trial_id="trial-retry",
        upstream_base_url=upstream.base_url,
        adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
        bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        limits=ProxyLimits(max_requests=max_requests),
        log_path=tmp_path / "proxy.jsonl",
        lease_terms=LEASE_TERMS,
        max_upstream_attempts=max_attempts,
        upstream_retry_backoff_seconds=0,
    )


def audit_rows(tmp_path: Path) -> list[dict]:
    path = tmp_path / "proxy.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_a_provider_error_status_is_retried_until_the_answer_arrives(tmp_path: Path) -> None:
    """Two 502s and a 200 are one answered request, not three, and not a dead route."""
    with SyntheticUpstream() as upstream:
        upstream.server.status_sequence = [502, 502]
        handle = start_proxy(tmp_path, upstream)
        try:
            status, _ = proxy_request(handle.base_url, handle.dummy_token, "flaky")
        finally:
            handle.stop()
    rows = audit_rows(tmp_path)
    assert status == 200
    assert len(upstream.requests) == 3
    # One client request is one reservation and one audit row, however many attempts it took.
    assert [row["request_count"] for row in rows] == [1]
    assert "outcome" not in rows[0]


def test_exhausted_retries_refuse_the_request_and_leave_the_route_live(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.status_sequence = [503, 503, 503]
        handle = start_proxy(tmp_path, upstream)
        try:
            failed = streamed_proxy_request(handle.base_url, handle.dummy_token, "outage")
            recovered, _ = proxy_request(handle.base_url, handle.dummy_token, "after")
        finally:
            handle.stop()
    rows = audit_rows(tmp_path)
    assert failed.status == 502
    assert json.loads(failed.body) == {"error": "upstream_error_status"}
    assert dict(failed.headers).get("x-should-retry") == "true"
    assert rows[0]["outcome"] == "upstream_error_status"
    assert rows[0]["upstream_status"] == 503
    # The route survived the outage: the next request is answered rather than 410 route_revoked.
    assert recovered == 200
    assert len(upstream.requests) == 4


def test_an_unretryable_status_is_refused_once_without_revoking(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.status_sequence = [400]
        handle = start_proxy(tmp_path, upstream)
        try:
            refused, _ = proxy_request(handle.base_url, handle.dummy_token, "bad-request")
            recovered, _ = proxy_request(handle.base_url, handle.dummy_token, "after")
        finally:
            handle.stop()
    rows = audit_rows(tmp_path)
    assert (refused, recovered) == (502, 200)
    assert rows[0]["upstream_status"] == 400
    assert len(upstream.requests) == 2


def test_a_response_already_relayed_is_never_attempted_twice(tmp_path: Path) -> None:
    """Once a status line is on the client's wire, a retry would relay a second response."""
    with SyntheticUpstream() as upstream:
        upstream.server.truncate_after_bytes = 16
        handle = start_proxy(tmp_path, upstream)
        try:
            result = streamed_proxy_request(handle.base_url, handle.dummy_token, "cut")
        finally:
            handle.stop()
    assert result.complete is False
    assert len(upstream.requests) == 1
