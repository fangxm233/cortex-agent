# input:  a proxy carrying the row-1 adapter, loopback sources, and listeners
# output: offline H7 source, budget, deadline, revocation, and host-set proofs
# pos:    Offline containment proofs for the row-1 adapter
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import select
import socket
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.client import HTTPConnection, HTTPResponse
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from synthetic import (
    LEASE_TERMS,
    MESSAGES_TARGET,
    SYNTHETIC_MODEL,
    SyntheticUpstream,
    proxy_request,
    row_one_adapter,
)

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-CONTAINMENT-UNIQUE"
BOUND_SOURCE = "127.0.0.9"


def start_proxy(
    tmp_path: Path, upstream_base_url: str, *, bound_source_ip: str = "127.0.0.1",
    deadline: datetime | None = None, max_cost: str = "20",
):
    return start_trial_proxy(
        trial_id="trial-containment", upstream_base_url=upstream_base_url,
        adapter=row_one_adapter(upstream_base_url, REAL_CREDENTIAL, SYNTHETIC_MODEL),
        bound_source_ip=bound_source_ip,
        absolute_deadline=deadline or datetime.now(UTC) + timedelta(minutes=5),
        budget=ProxyBudget(
            Decimal(max_cost), Decimal("5"), Decimal("1000000"), Decimal("1000000"),
        ),
        log_path=tmp_path / "containment.jsonl",
        lease_terms=LEASE_TERMS,
    )


def test_h7_property_1_source_binding_holds_offline(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url, bound_source_ip=BOUND_SOURCE)
        try:
            bound = _request(handle.base_url, handle.dummy_token, source=BOUND_SOURCE)
            unbound = _request(handle.base_url, handle.dummy_token, source="127.0.0.1")
        finally:
            handle.stop()
    assert bound[0] == 200
    assert unbound[0] == 403
    assert json.loads(unbound[1]) == {"error": "source_rejected"}
    assert len(upstream.requests) == 1


def test_h7_property_2_budget_cutoff_holds_offline(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url, max_cost="5")
        try:
            first, _ = proxy_request(handle.base_url, handle.dummy_token, "first")
            second, payload = proxy_request(handle.base_url, handle.dummy_token, "second")
        finally:
            handle.stop()
    assert (first, second) == (200, 429)
    assert json.loads(payload) == {"error": "budget_exhausted"}
    assert len(upstream.requests) == 1


def test_h7_property_3_absolute_deadline_revocation_holds_offline(tmp_path: Path) -> None:
    deadline = datetime.now(UTC) + timedelta(seconds=2)
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url, deadline=deadline)
        try:
            before, _ = proxy_request(handle.base_url, handle.dummy_token, "before")
            while datetime.now(UTC) <= deadline:
                time.sleep(0.01)
            after, payload = proxy_request(handle.base_url, handle.dummy_token, "after")
        finally:
            handle.stop()
    assert (before, after) == (200, 410)
    assert json.loads(payload) == {"error": "deadline_expired"}
    assert len(upstream.requests) == 1


def test_h7_property_6_route_is_dead_after_stop_offline(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(tmp_path, upstream.base_url)
        alive, _ = proxy_request(handle.base_url, handle.dummy_token, "alive")
        handle.stop()
        with pytest.raises(OSError):
            proxy_request(handle.base_url, handle.dummy_token, "dead")
    assert alive == 200
    assert len(upstream.requests) == 1


def test_h7_property_6_stop_revokes_the_route_in_band_not_only_by_closing_the_socket(
    tmp_path: Path,
) -> None:
    # `stop()` also closes the listener, so an OSError on the next connection holds even
    # if the route was never revoked. This reads the admission state machine instead: the
    # answer a live listener would render is 410 route_revoked, and the deadline is far
    # enough out that it cannot be the deadline branch answering.
    with SyntheticUpstream() as upstream:
        handle = start_proxy(
            tmp_path, upstream.base_url,
            deadline=datetime.now(UTC) + timedelta(hours=1))
        state = handle._server.state
        alive, _ = proxy_request(handle.base_url, handle.dummy_token, "alive")
        assert state.lifecycle_error() is None
        handle.stop()
    assert alive == 200
    assert state.deadline_expired() is False
    assert state.lifecycle_error() == (410, "route_revoked")
    assert state.admission_error(
        "127.0.0.1", f"Bearer {handle.dummy_token}") == (410, "route_revoked")
    assert len(upstream.requests) == 1


def test_r7_upstream_host_set_is_one_frozen_member(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        adapter = row_one_adapter(upstream.base_url, REAL_CREDENTIAL)
        twin = row_one_adapter(upstream.base_url, "another-credential", "another-model")
        assert adapter.upstream_hosts == twin.upstream_hosts
        assert len(adapter.upstream_hosts) == 1
        assert adapter.upstream_hosts == (urlsplit(upstream.base_url).hostname,)


def test_r7_host_set_survives_a_container_request_and_an_upstream_document(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream, _learned_listener() as learned:
        learned_authority = _authority(learned)
        upstream.server.response["discovery"] = {"api_host": learned_authority}
        handle = start_proxy(tmp_path, upstream.base_url)
        declared = handle._server.adapter.upstream_hosts
        try:
            status, _ = proxy_request(
                handle.base_url, handle.dummy_token, "learn",
                extra_headers={"host": learned_authority,
                               "x-forwarded-host": learned_authority})
            after = handle._server.adapter.upstream_hosts
            attempts = _connection_attempts(learned)
        finally:
            handle.stop()
    assert status == 200
    assert after == declared
    assert len(after) == 1
    assert attempts == 0


def test_r7_upstream_redirect_is_relayed_and_never_followed(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, _learned_listener() as learned:
        redirect_url = f"http://{_authority(learned)}{MESSAGES_TARGET}"
        upstream.server.status = 302
        upstream.server.extra_headers = {"location": redirect_url}
        handle = start_proxy(tmp_path, upstream.base_url)
        try:
            response = _raw_response(handle.base_url, handle.dummy_token)
            status = response.status
            location = response.getheader("location")
            response.read()
            attempts = _connection_attempts(learned)
        finally:
            handle.stop()
    assert status == 302
    assert location == redirect_url
    assert len(upstream.requests) == 1
    assert attempts == 0


class _Listener:
    def __init__(self) -> None:
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen(1)

    @property
    def port(self) -> int:
        return self.socket.getsockname()[1]

    def __enter__(self) -> "_Listener":
        return self

    def __exit__(self, *_args: object) -> None:
        self.socket.close()


def _learned_listener() -> _Listener:
    return _Listener()


def _authority(listener: _Listener) -> str:
    return f"127.0.0.1:{listener.port}"


def _connection_attempts(listener: _Listener) -> int:
    ready, _, _ = select.select([listener.socket], [], [], 0)
    return len(ready)


def _connection(base_url: str, source: str | None = None) -> HTTPConnection:
    listen = urlsplit(base_url)
    return HTTPConnection(
        listen.hostname, listen.port, timeout=3,
        source_address=(source, 0) if source else None,
    )


def _request(
    base_url: str, token: str, *, source: str | None = None,
) -> tuple[int, bytes]:
    connection = _connection(base_url, source)
    connection.request(
        "POST", MESSAGES_TARGET,
        body=json.dumps({"model": SYNTHETIC_MODEL, "prompt": "bound"}).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, payload


def _raw_response(base_url: str, token: str) -> HTTPResponse:
    connection = _connection(base_url)
    connection.request(
        "POST", MESSAGES_TARGET,
        body=json.dumps({"model": SYNTHETIC_MODEL, "prompt": "redirect"}).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    return connection.getresponse()
