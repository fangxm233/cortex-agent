# input:  a live proxy carrying the row-1 adapter and a synthetic upstream
# output: duty-order, refusal, audit, and auth-form proofs on the request path
# pos:    Provider adapter seam integration tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import socket
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from synthetic import SYNTHETIC_MODEL, SyntheticUpstream, proxy_request, row_one_adapter

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-SEAM-UNIQUE"
DENIED_TARGETS = [
    ("/v1/messages", "route_denied_messages_non_beta"),
    ("/v1/messages?beta=false", "route_denied_messages_non_beta"),
    ("/v1/messages/count_tokens?beta=true", "route_denied_count_tokens"),
    ("/v1/messages/batches?beta=true", "route_denied_batches"),
    ("/v1/messages/batches/batch_1?beta=true", "route_denied_batches"),
    ("/v1/complete", "route_not_allowed"),
]


def budget(max_cost: str = "5") -> ProxyBudget:
    return ProxyBudget(
        max_cost_usd=Decimal(max_cost), max_request_cost_usd=Decimal("5"),
        input_cost_per_million_usd=Decimal("1000000"),
        output_cost_per_million_usd=Decimal("1000000"),
    )


def start_proxy(
    tmp_path: Path, upstream_base_url: str, *, credential: str | None = REAL_CREDENTIAL,
    frozen_model: str | None = SYNTHETIC_MODEL, max_cost: str = "20",
):
    return start_trial_proxy(
        trial_id="trial-seam", upstream_base_url=upstream_base_url,
        adapter=row_one_adapter(upstream_base_url, credential, frozen_model),
        bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        budget=budget(max_cost), log_path=tmp_path / "seam.jsonl",
    )


def records(log_path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in log_path.read_text().splitlines()]


def test_forwards_the_api_key_and_never_a_bearer(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, _ = proxy_request(
                handle.base_url, handle.dummy_token, "call",
                extra_headers={"x-api-key": "container-supplied-key"})
        finally:
            handle.stop()
    headers = {key.lower(): value for key, value in upstream.requests[0].headers.items()}
    assert status == 200
    assert headers["x-api-key"] == REAL_CREDENTIAL
    assert "authorization" not in headers
    assert handle.dummy_token not in json.dumps(headers)
    assert "container-supplied-key" not in json.dumps(headers)


def test_forwarded_target_keeps_the_beta_query(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, _ = proxy_request(handle.base_url, handle.dummy_token, "call")
        finally:
            handle.stop()
    assert status == 200
    assert upstream.requests[0].path == "/v1/messages?beta=true"
    assert upstream.requests[0].method == "POST"


@pytest.mark.parametrize(("target", "outcome"), DENIED_TARGETS)
def test_route_outside_the_allow_list_is_refused_before_any_upstream_or_budget(
    tmp_path: Path, target: str, outcome: str,
) -> None:
    log_path = tmp_path / "seam.jsonl"
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, payload = proxy_request(
                handle.base_url, handle.dummy_token, "denied", target=target)
        finally:
            handle.stop()
    assert status == 403
    assert json.loads(payload) == {"error": "route_not_allowed"}
    assert upstream.requests == []
    assert handle._server.state.budget_consumed_usd == Decimal("0")
    assert records(log_path) == [{
        "cost_usd": "0", "outcome": outcome, "request_count": 1,
        "tokens": {"input": 0, "output": 0, "total": 0}, "upstream_model": None,
    }]


def test_denied_route_opens_no_upstream_connection(tmp_path: Path) -> None:
    dead_upstream = f"http://127.0.0.1:{_unused_port()}"
    handle = start_proxy(tmp_path, dead_upstream)
    try:
        denied, _ = proxy_request(
            handle.base_url, handle.dummy_token, "denied", target="/v1/messages")
        forwarded, _ = proxy_request(handle.base_url, handle.dummy_token, "forwarded")
    finally:
        handle.stop()
    assert denied == 403
    assert forwarded == 502


def test_body_model_mismatch_is_refused_without_upstream_or_budget(tmp_path: Path) -> None:
    log_path = tmp_path / "seam.jsonl"
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, payload = proxy_request(
                handle.base_url, handle.dummy_token, "mismatch", model="claude-other-9")
        finally:
            handle.stop()
    assert status == 400
    assert json.loads(payload) == {"error": "request_model_rejected"}
    assert upstream.requests == []
    assert handle._server.state.budget_consumed_usd == Decimal("0")
    assert records(log_path)[0]["outcome"] == "request_model_mismatch"


@pytest.mark.parametrize(
    ("body", "outcome"),
    [
        (b'{"prompt":"no model here"}', "request_model_absent"),
        (b"not-json-at-all", "request_body_unparsable"),
    ],
)
def test_body_without_a_locatable_model_is_refused_never_passed_through(
    tmp_path: Path, body: bytes, outcome: str,
) -> None:
    log_path = tmp_path / "seam.jsonl"
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            status, payload = proxy_request(
                handle.base_url, handle.dummy_token, "unused", body=body)
        finally:
            handle.stop()
    assert status == 400
    assert json.loads(payload) == {"error": "request_model_rejected"}
    assert upstream.requests == []
    assert records(log_path)[0]["outcome"] == outcome


def test_rejections_are_audited_without_touching_budget_arithmetic(tmp_path: Path) -> None:
    log_path = tmp_path / "seam.jsonl"
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            first, _ = proxy_request(
                handle.base_url, handle.dummy_token, "denied", target="/v1/messages")
            second, _ = proxy_request(
                handle.base_url, handle.dummy_token, "denied", model="claude-other-9")
            state = handle._server.state
        finally:
            handle.stop()
    assert (first, second) == (403, 400)
    assert state.request_count == 2
    assert state.budget_consumed_usd == Decimal("0")
    assert state.budget_consumed_usd >= Decimal("0")
    assert [record["request_count"] for record in records(log_path)] == [1, 2]
    assert [record["cost_usd"] for record in records(log_path)] == ["0", "0"]


def test_refused_requests_leave_the_whole_budget_for_an_admitted_one(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url, max_cost="5")
        try:
            proxy_request(handle.base_url, handle.dummy_token, "denied", target="/v1/messages")
            proxy_request(handle.base_url, handle.dummy_token, "denied", model="claude-other-9")
            admitted, _ = proxy_request(handle.base_url, handle.dummy_token, "admitted")
            state = handle._server.state
        finally:
            handle.stop()
    assert admitted == 200
    assert state.budget_consumed_usd == Decimal("5")
    assert len(upstream.requests) == 1


def test_missing_auth_form_refuses_and_forwards_nothing(tmp_path: Path) -> None:
    log_path = tmp_path / "seam.jsonl"
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url, credential=None)
        try:
            status, payload = proxy_request(handle.base_url, handle.dummy_token, "no-auth")
            state = handle._server.state
        finally:
            handle.stop()
    assert status == 502
    assert json.loads(payload) == {"error": "auth_injection_unavailable"}
    assert upstream.requests == []
    assert state.budget_consumed_usd == Decimal("0")
    assert records(log_path)[0]["outcome"] == "auth_injection_unavailable"


def test_unparsable_usage_leaves_accounting_unavailable_and_revokes(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        upstream.server.raw_body = b"<html>upstream gateway error</html>"
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            first, payload = proxy_request(handle.base_url, handle.dummy_token, "garbled")
            second, _ = proxy_request(handle.base_url, handle.dummy_token, "after")
        finally:
            handle.stop()
    assert first == 502
    assert json.loads(payload) == {"error": "budget_accounting_unavailable"}
    assert second == 410
    assert len(upstream.requests) == 1


def test_proxy_refuses_to_start_for_an_upstream_the_adapter_does_not_declare(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="upstream"):
        start_trial_proxy(
            trial_id="trial-seam", upstream_base_url="http://127.0.0.1:9000",
            adapter=row_one_adapter("http://other.host.test", REAL_CREDENTIAL),
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            budget=budget(), log_path=tmp_path / "unstarted.jsonl",
        )


def test_manifest_records_the_adapter_that_carried_the_trial(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        adapter = row_one_adapter(upstream.base_url, REAL_CREDENTIAL)
        handle = start_trial_proxy(
            trial_id="trial-seam", upstream_base_url=upstream.base_url, adapter=adapter,
            bound_source_ip="127.0.0.1",
            absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
            budget=budget("20"), log_path=tmp_path / "seam.jsonl",
        )
        try:
            proxy_request(handle.base_url, handle.dummy_token, "one")
            proxy_request(handle.base_url, handle.dummy_token, "two")
            in_force = handle._server.adapter
        finally:
            handle.stop()
    assert handle.manifest_block["adapter_id"] == adapter.adapter_id
    assert in_force is adapter


def _unused_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]
