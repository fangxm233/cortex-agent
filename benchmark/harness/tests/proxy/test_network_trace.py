# input:  synthetic upstream, per-trial proxy, planted secrets
# output: phase ordering, route isolation and content-free trace proofs
# pos:    Network phase trace regression tests
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

import cortex_bench_harness.proxy.network_trace as network_trace
from cortex_bench_harness.proxy import ProxyLimits, SharedRequestLimit, start_trial_proxy
from cortex_bench_harness.proxy.network_trace import NetworkTrace
from cortex_bench_harness.proxy.server import RelaySink
from synthetic import (
    LEASE_TERMS,
    SyntheticUpstream,
    proxy_request,
    row_one_adapter,
    streamed_proxy_request,
)

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-TRACE-UNIQUE"
PLANTED_PROMPT = "PROMPT-TRACE-PLANT-7fd841"


def start_traced_proxy(
    tmp_path: Path, upstream: SyntheticUpstream, name: str,
    shared_limit: SharedRequestLimit | None = None,
):
    return start_trial_proxy(
        trial_id=name,
        upstream_base_url=upstream.base_url,
        adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
        bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        limits=ProxyLimits(max_requests=4),
        log_path=tmp_path / f"{name}-audit.jsonl",
        network_trace_path=tmp_path / f"{name}-network.jsonl",
        lease_terms=LEASE_TERMS,
        network_trace_progress_interval_seconds=0.01,
        shared_request_limit=shared_limit,
    )


def trace_rows(tmp_path: Path, name: str) -> list[dict[str, object]]:
    path = tmp_path / f"{name}-network.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()]


def wait_for_phase(tmp_path: Path, name: str, phase: str) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if any(row["phase"] == phase for row in trace_rows(tmp_path, name)):
            return
        time.sleep(0.005)
    raise AssertionError(f"phase did not appear: {phase}")


def test_successful_trace_is_ordered_and_content_free(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_traced_proxy(tmp_path, upstream, "trace-success")
        try:
            status, _ = proxy_request(
                handle.base_url, handle.dummy_token, PLANTED_PROMPT)
        finally:
            handle.stop()

    rows = trace_rows(tmp_path, "trace-success")
    phases = [row["phase"] for row in rows]
    assert status == 200
    assert phases == [
        "proxy_started", "model_post_observed", "upstream_connect_started",
        "upstream_connect_returned", "request_socket_write_started",
        "request_socket_write_returned", "response_headers_wait_started",
        "response_headers_received", "response_stream_wait_started",
        "response_stream_first", "response_stream_eof",
        "downstream_socket_write_returned", "request_terminal", "proxy_finalized",
    ]
    request_rows = [row for row in rows if "request_id" in row]
    assert {row["request_id"] for row in request_rows} == {1}
    assert [row["sequence"] for row in rows] == list(range(1, len(rows) + 1))
    payload = (tmp_path / "trace-success-network.jsonl").read_text()
    for planted in (REAL_CREDENTIAL, handle.dummy_token, PLANTED_PROMPT, "/v1/messages"):
        assert planted not in payload
    assert handle.network_trace_complete is True


def test_headers_wait_marker_is_durable_while_request_is_blocked(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.response_delay_seconds = 0.2
        handle = start_traced_proxy(tmp_path, upstream, "trace-headers")
        result: list[tuple[int, bytes]] = []
        worker = threading.Thread(
            target=lambda: result.append(proxy_request(
                handle.base_url, handle.dummy_token, "blocked")))
        try:
            worker.start()
            wait_for_phase(tmp_path, "trace-headers", "response_headers_wait_started")
            phases = [row["phase"] for row in trace_rows(tmp_path, "trace-headers")]
            assert "response_headers_received" not in phases
            worker.join(timeout=2)
        finally:
            handle.stop()
    assert result[0][0] == 200


def test_mid_stream_trace_reports_progress_before_eof(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.raw_body = json.dumps(upstream.server.response).encode()
        upstream.server.response_chunk_delay_seconds = 0.01
        handle = start_traced_proxy(tmp_path, upstream, "trace-stream")
        result = []
        worker = threading.Thread(target=lambda: result.append(streamed_proxy_request(
            handle.base_url, handle.dummy_token, "slow", timeout=5)))
        try:
            worker.start()
            wait_for_phase(tmp_path, "trace-stream", "response_stream_progress")
            phases = [row["phase"] for row in trace_rows(tmp_path, "trace-stream")]
            assert "response_stream_eof" not in phases
            worker.join(timeout=5)
        finally:
            handle.stop()
    assert result[0].complete is True


def test_downstream_header_failure_is_traced(tmp_path: Path) -> None:
    class FailedHandler:
        def send_response(self, *_args: object) -> None:
            raise OSError("client closed")

    trace = NetworkTrace(tmp_path / "headers-failed.jsonl", "headers-failed")
    request = trace.start_request()
    RelaySink(FailedHandler(), request).begin(200, "OK", ())  # type: ignore[arg-type]
    trace.finalize()
    rows = [json.loads(line) for line in (tmp_path / "headers-failed.jsonl").read_text().splitlines()]
    assert "downstream_socket_write_failed" in [row["phase"] for row in rows]


def test_trace_write_failure_is_sticky_but_does_not_change_response(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_traced_proxy(tmp_path, upstream, "trace-write-failure")
        monkeypatch.setattr(
            network_trace, "append_json_line",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("trace failed")),
        )
        try:
            status = proxy_request(handle.base_url, handle.dummy_token, "still-runs")[0]
        finally:
            handle.stop()
    assert status == 200
    assert handle.network_trace_complete is False


def test_suite_request_limit_is_shared_without_sharing_route_state(tmp_path: Path) -> None:
    limit = SharedRequestLimit(1)
    with SyntheticUpstream() as first_upstream, SyntheticUpstream() as second_upstream:
        first = start_traced_proxy(tmp_path, first_upstream, "trace-budget-one", limit)
        second = start_traced_proxy(tmp_path, second_upstream, "trace-budget-two", limit)
        try:
            first_status = proxy_request(first.base_url, first.dummy_token, "spent")[0]
            second_status = proxy_request(second.base_url, second.dummy_token, "blocked")[0]
        finally:
            first.stop()
            second.stop()
    assert (first_status, second_status, limit.used) == (200, 429, 1)
    assert len(second_upstream.requests) == 0


def test_unaccounted_route_does_not_revoke_sibling_route(tmp_path: Path) -> None:
    with SyntheticUpstream() as failing, SyntheticUpstream() as sibling:
        failing.server.response = {
            "model": "claude-synthetic-1", "usage": {}, "content": [],
        }
        first = start_traced_proxy(tmp_path, failing, "trace-failing")
        second = start_traced_proxy(tmp_path, sibling, "trace-sibling")
        try:
            refused = streamed_proxy_request(
                first.base_url, first.dummy_token, "unaccounted")
            own_retry = proxy_request(first.base_url, first.dummy_token, "retry")[0]
            sibling_status = proxy_request(
                second.base_url, second.dummy_token, "unaffected")[0]
        finally:
            first.stop()
            second.stop()

    assert (refused.complete, own_retry, sibling_status) == (False, 410, 200)
    assert first.network_trace_complete is True
    assert second.network_trace_complete is True
