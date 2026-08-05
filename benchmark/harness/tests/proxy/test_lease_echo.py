# input:  a virtual host clock, a separate container clock, and the echo control route
# output: skew invariance, clamp, duplicate, no-echo, validation and revocation proofs
# pos:    Lease echo-back tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from cortex_bench_harness.launcher.lease_bound import (
    SETUP_TIMEOUT_MS,
    TEARDOWN_GRACE_MS,
    provisional_lease_bound_ms,
)
from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from cortex_bench_harness.proxy.adapters import ProviderAdapter
from cortex_bench_harness.proxy.adapters.openai_codex_responses import RESPONSES_PATH
from cortex_bench_harness.proxy.lease import (
    LEASE_ECHO_SCHEMA_VERSION,
    LEASE_ECHO_TARGET,
    LeaseRefused,
    LeaseTerms,
    lease_echo_terminal_check,
)
from synthetic import (
    MESSAGES_TARGET,
    SYNTHETIC_MODEL,
    SyntheticUpstream,
    proxy_request,
    row_one_adapter,
)
from test_openai_codex_adapter import (
    CODEX_MODEL,
    row_four_adapter,
    serve_stream,
    sse_stream,
    terminal_event,
)

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-LEASE-UNIQUE"
TRIAL_ID = "trial-lease"
DEADLINE_SECONDS = 1800
BUDGET_MS = DEADLINE_SECONDS * 1000
SETUP_MS = 90_000
ELAPSED_MS = 120_000
CONTAINER_ORIGIN_MS = 1_800_000_000_000
SKEWS = (-600_000, -1, 0, 1, 600_000)


@dataclass(frozen=True)
class TrialRow:
    """One capability row's binding: the adapter that carries it, the upstream shape that adapter
    needs to meter a call, and a model call it admits.

    The lease is adapter-independent by construction, which is exactly why a row proves it rather
    than inherits it: an adapter is the thing that could break the calls the lease assertions read.
    """

    name: str
    build_adapter: Callable[[str], ProviderAdapter]
    prepare_upstream: Callable[[SyntheticUpstream], None]
    target: str
    model: str


def _row_four_stream(upstream: SyntheticUpstream) -> None:
    # The Codex row meters off the wire terminal event, so an unaccounted reply would revoke the
    # route and every "the call still succeeds" assertion below would pass for the wrong reason.
    serve_stream(upstream, sse_stream([terminal_event(input_tokens=1, output_tokens=1)]))


ROW_ONE = TrialRow(
    "row_one", lambda upstream: row_one_adapter(upstream, REAL_CREDENTIAL),
    lambda _upstream: None, MESSAGES_TARGET, SYNTHETIC_MODEL,
)
ROW_FOUR = TrialRow(
    "row_four", row_four_adapter, _row_four_stream, RESPONSES_PATH, CODEX_MODEL,
)
ROWS = (ROW_ONE, ROW_FOUR)
ROW_IDS = [row.name for row in ROWS]


def row_request(row: TrialRow, base_url: str, token: str, prompt: str) -> tuple[int, bytes]:
    return proxy_request(base_url, token, prompt, target=row.target, model=row.model)


class VirtualClock:
    """One clock. The host and the container each get their own instance, so a value read on one
    is never the value read on the other."""

    def __init__(self, epoch_ms: int) -> None:
        self._epoch_ms = epoch_ms

    def now_ms(self) -> int:
        return self._epoch_ms

    def advance(self, delta_ms: int) -> None:
        self._epoch_ms += delta_ms


class TrialClocks:
    """Host clock H and container clock C, offset by `skew_ms` and advanced at the same rate."""

    def __init__(self, skew_ms: int) -> None:
        self.container = VirtualClock(CONTAINER_ORIGIN_MS)
        self.host = VirtualClock(CONTAINER_ORIGIN_MS + skew_ms)

    def advance(self, delta_ms: int) -> None:
        self.container.advance(delta_ms)
        self.host.advance(delta_ms)


def budget(max_cost: str = "500") -> ProxyBudget:
    return ProxyBudget(
        max_cost_usd=Decimal(max_cost),
        max_request_cost_usd=Decimal("5"),
        input_cost_per_million_usd=Decimal("1000000"),
        output_cost_per_million_usd=Decimal("1000000"),
    )


def start_leased_proxy(
    tmp_path: Path, upstream: SyntheticUpstream, clocks: TrialClocks, *,
    bound_ms: int | None = None, terms: LeaseTerms | None = None,
    row: TrialRow = ROW_ONE,
):
    """The launcher's own step: read H0, arm the provisional bound, then create the container."""
    row.prepare_upstream(upstream)
    provisional = bound_ms if bound_ms is not None else provisional_lease_bound_ms(
        clocks.host.now_ms(), BUDGET_MS,
    )
    return start_trial_proxy(
        trial_id=TRIAL_ID,
        upstream_base_url=upstream.base_url,
        adapter=row.build_adapter(upstream.base_url),
        bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.fromtimestamp(provisional / 1000, UTC),
        budget=budget(),
        log_path=tmp_path / "lease.jsonl",
        lease_terms=terms or LeaseTerms(BUDGET_MS, TEARDOWN_GRACE_MS),
        now_ms=clocks.host.now_ms,
    )


def compile_deadline(clocks: TrialClocks) -> dict[str, int]:
    """Phase B, inside the container: the deadline is derived from clock C alone."""
    compiled = clocks.container.now_ms()
    return {"compiled_at_epoch_ms": compiled, "absolute_epoch_ms": compiled + BUDGET_MS}


def echo_document(deadline: dict[str, int], remaining_ms: int) -> dict[str, Any]:
    return {
        "schema_version": LEASE_ECHO_SCHEMA_VERSION,
        "trial_id": TRIAL_ID,
        **deadline,
        "remaining_ms": remaining_ms,
    }


def post_echo(
    base_url: str, token: str | None, document: Any, *,
    source_host: str | None = None,
) -> tuple[int, dict[str, Any]]:
    listener = urlsplit(base_url)
    payload = document if isinstance(document, bytes) else json.dumps(document).encode()
    connection = HTTPConnection(
        listener.hostname, listener.port, timeout=5, source_address=(
            (source_host, 0) if source_host else None
        ),
    )
    headers = {"content-type": "application/json"}
    if token is not None:
        headers["authorization"] = f"Bearer {token}"
    connection.request("POST", LEASE_ECHO_TARGET, body=payload, headers=headers)
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response.status, json.loads(body)


def run_trial(
    tmp_path: Path, clocks: TrialClocks, upstream: SyntheticUpstream,
    row: TrialRow = ROW_ONE,
):
    """H0 → arm P → setup → phase-B compile → some elapsed trial time."""
    handle = start_leased_proxy(tmp_path, upstream, clocks, row=row)
    clocks.advance(SETUP_MS)
    deadline = compile_deadline(clocks)
    clocks.advance(ELAPSED_MS)
    return handle, deadline


# ---------------------------------------------------------------- the OC-10 test


@pytest.mark.parametrize("row", ROWS, ids=ROW_IDS)
@pytest.mark.parametrize("skew_ms", SKEWS)
def test_lease_survives_host_clock_skew(
    tmp_path: Path, skew_ms: int, row: TrialRow,
) -> None:
    clocks = TrialClocks(skew_ms)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream, row)
        try:
            remaining_ms = BUDGET_MS - ELAPSED_MS
            status, echoed = post_echo(
                handle.base_url, handle.dummy_token, echo_document(deadline, remaining_ms),
            )

            # (a) one second before the container's own deadline, an admitted call still works.
            clocks.advance(remaining_ms - 1000)
            alive, _ = row_request(row, handle.base_url, handle.dummy_token, "before-deadline")

            # (b) past the deadline plus the teardown grace, the route is dead.
            clocks.advance(1000 + TEARDOWN_GRACE_MS + 1000)
            dead, payload = row_request(
                row, handle.base_url, handle.dummy_token, "after-deadline")
        finally:
            handle.stop()

    assert (status, echoed["lease_state"]) == (200, "reconciled")
    assert alive == 200
    assert dead == 410
    assert json.loads(payload) == {"error": "deadline_expired"}
    # (c) the discriminator: the armed remaining is the echoed duration, whatever the host clock says.
    assert echoed["armed_remaining_ms"] == remaining_ms


@pytest.mark.parametrize("row", ROWS, ids=ROW_IDS)
def test_armed_remaining_does_not_vary_with_host_clock_skew(
    tmp_path: Path, row: TrialRow,
) -> None:
    armed: dict[int, int] = {}
    for skew_ms in SKEWS:
        clocks = TrialClocks(skew_ms)
        with SyntheticUpstream() as upstream:
            handle, deadline = run_trial(tmp_path, clocks, upstream, row)
            try:
                _, echoed = post_echo(
                    handle.base_url, handle.dummy_token,
                    echo_document(deadline, BUDGET_MS - ELAPSED_MS),
                )
            finally:
                handle.stop()
        armed[skew_ms] = echoed["armed_remaining_ms"]

    assert set(armed.values()) == {BUDGET_MS - ELAPSED_MS}


# ---------------------------------------------------------------- the three companions


@pytest.mark.parametrize("row", ROWS, ids=ROW_IDS)
def test_echo_cannot_extend_lease_beyond_provisional_bound(
    tmp_path: Path, row: TrialRow,
) -> None:
    """A container that echoes a whole unspent budget later than the setup timeout would allow is
    asking for a lease past `P`. It gets `P`, and the overreach is recorded as an anomaly."""
    overrun_ms = 60_000
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        bound_ms = provisional_lease_bound_ms(clocks.host.now_ms(), BUDGET_MS)
        handle = start_leased_proxy(tmp_path, upstream, clocks, bound_ms=bound_ms, row=row)
        clocks.advance(SETUP_TIMEOUT_MS + overrun_ms)
        deadline = compile_deadline(clocks)
        try:
            status, echoed = post_echo(
                handle.base_url, handle.dummy_token, echo_document(deadline, BUDGET_MS),
            )
            before, _ = row_request(row, handle.base_url, handle.dummy_token, "still-live")
            clocks.host.advance(bound_ms - clocks.host.now_ms() + 1000)
            after, payload = row_request(row, handle.base_url, handle.dummy_token, "past-bound")
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert status == 200
    assert echoed["lease_state"] == "clamped"
    # The lease is `P` exactly: the granted remaining is the request minus the overrun.
    assert echoed["armed_remaining_ms"] == BUDGET_MS - overrun_ms
    assert record["value"]["lease_state"] == "clamped"
    assert before == 200
    assert (after, json.loads(payload)) == (410, {"error": "deadline_expired"})


def test_remaining_beyond_the_budget_is_refused_rather_than_clamped(tmp_path: Path) -> None:
    """The clamp is not a sanitiser: a document whose own durations do not agree is refused before
    any arming, so an over-large `remaining_ms` never reaches the clamp."""
    document = echo_document(
        {"compiled_at_epoch_ms": CONTAINER_ORIGIN_MS,
         "absolute_epoch_ms": CONTAINER_ORIGIN_MS + BUDGET_MS}, BUDGET_MS + 3_600_000,
    )
    echo_refusal_leaves_the_bound(tmp_path, document, (400, "lease_echo_inconsistent"))


@pytest.mark.parametrize("row", ROWS, ids=ROW_IDS)
def test_second_echo_does_not_move_the_lease(tmp_path: Path, row: TrialRow) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream, row)
        try:
            first, accepted = post_echo(
                handle.base_url, handle.dummy_token,
                echo_document(deadline, BUDGET_MS - ELAPSED_MS),
            )
            second, refusal = post_echo(
                handle.base_url, handle.dummy_token, echo_document(deadline, 60_000),
            )
            # Read at the route, not only in the record: the second echo asked for a minute, so a
            # lease that moved would already be dead here.
            clocks.advance(BUDGET_MS - ELAPSED_MS - 1000)
            alive, _ = row_request(row, handle.base_url, handle.dummy_token, "after-duplicate")
            clocks.advance(2000 + TEARDOWN_GRACE_MS)
            dead, _ = row_request(row, handle.base_url, handle.dummy_token, "past-first-lease")
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert first == 200
    assert (second, refusal) == (409, {"error": "lease_echo_duplicate"})
    assert (alive, dead) == (200, 410)
    assert record["value"]["armed_remaining_ms"] == accepted["armed_remaining_ms"]


@pytest.mark.parametrize("row", ROWS, ids=ROW_IDS)
def test_missing_echo_leaves_bound_and_marks_unavailable(
    tmp_path: Path, row: TrialRow,
) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        bound_ms = provisional_lease_bound_ms(clocks.host.now_ms(), BUDGET_MS)
        handle = start_leased_proxy(tmp_path, upstream, clocks, bound_ms=bound_ms, row=row)
        clocks.advance(SETUP_MS + BUDGET_MS - 1000)
        try:
            alive, _ = row_request(row, handle.base_url, handle.dummy_token, "no-echo-yet")
            clocks.host.advance(bound_ms - clocks.host.now_ms() + 1000)
            dead, payload = row_request(row, handle.base_url, handle.dummy_token, "past-bound")
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert alive == 200
    assert (dead, json.loads(payload)) == (410, {"error": "deadline_expired"})
    assert record == {"status": "unavailable", "reason": "no_echo_received"}
    check = lease_echo_terminal_check(record)
    assert (check.check_id, check.passed, check.failure_code) == ("lease_echo_missing", False, 41)


def test_terminal_check_passes_once_an_echo_arrived(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        try:
            post_echo(
                handle.base_url, handle.dummy_token,
                echo_document(deadline, BUDGET_MS - ELAPSED_MS),
            )
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert record["status"] == "available"
    assert record["value"]["absolute_epoch_ms"] == deadline["absolute_epoch_ms"]
    assert lease_echo_terminal_check(record).passed is True


# ---------------------------------------------------------------- authentication


def test_echo_from_an_unbound_source_is_refused(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle = start_leased_proxy(tmp_path, upstream, clocks)
        deadline = compile_deadline(clocks)
        try:
            status, payload = post_echo(
                handle.base_url, handle.dummy_token,
                echo_document(deadline, BUDGET_MS), source_host="127.0.0.2",
            )
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert (status, payload) == (403, {"error": "source_rejected"})
    assert record == {"status": "unavailable", "reason": "no_echo_received"}


def test_echo_with_a_wrong_token_is_refused(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle = start_leased_proxy(tmp_path, upstream, clocks)
        deadline = compile_deadline(clocks)
        try:
            wrong, payload = post_echo(
                handle.base_url, "dummy-wrong-token", echo_document(deadline, BUDGET_MS),
            )
            absent, absent_payload = post_echo(
                handle.base_url, None, echo_document(deadline, BUDGET_MS),
            )
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert (wrong, payload) == (401, {"error": "dummy_token_rejected"})
    assert (absent, absent_payload) == (401, {"error": "dummy_token_rejected"})
    assert record == {"status": "unavailable", "reason": "no_echo_received"}


def test_echo_is_never_forwarded_upstream(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        try:
            status, _ = post_echo(
                handle.base_url, handle.dummy_token,
                echo_document(deadline, BUDGET_MS - ELAPSED_MS),
            )
        finally:
            handle.stop()

    assert status == 200
    assert upstream.requests == []


def test_echo_route_is_matched_before_the_adapter_allow_list(tmp_path: Path) -> None:
    """The adapter refuses every target but its own messages route; the control route is matched
    first, so it never reaches that allow-list."""
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        try:
            refused, refusal = proxy_request(
                handle.base_url, handle.dummy_token, "x", target="/v1/not-allowed",
            )
            echoed, _ = post_echo(
                handle.base_url, handle.dummy_token,
                echo_document(deadline, BUDGET_MS - ELAPSED_MS),
            )
        finally:
            handle.stop()

    assert (refused, json.loads(refusal)) == (403, {"error": "route_not_allowed"})
    assert echoed == 200


def test_echo_response_carries_no_host_absolute_instant(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        try:
            _, echoed = post_echo(
                handle.base_url, handle.dummy_token,
                echo_document(deadline, BUDGET_MS - ELAPSED_MS),
            )
        finally:
            handle.stop()

    assert set(echoed) == {"ok", "lease_state", "armed_remaining_ms"}
    host_now = clocks.host.now_ms()
    assert all(
        not isinstance(value, int) or abs(value - host_now) > BUDGET_MS
        for value in echoed.values() if not isinstance(value, bool)
    )


# ---------------------------------------------------------------- the four validations


def echo_refusal_leaves_the_bound(
    tmp_path: Path, document: Any, expected: tuple[int, str],
) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        bound_ms = provisional_lease_bound_ms(clocks.host.now_ms(), BUDGET_MS)
        handle = start_leased_proxy(tmp_path, upstream, clocks, bound_ms=bound_ms)
        clocks.advance(SETUP_MS)
        try:
            status, payload = post_echo(handle.base_url, handle.dummy_token, document)
            clocks.host.advance(bound_ms - clocks.host.now_ms() - 1000)
            alive, _ = proxy_request(handle.base_url, handle.dummy_token, "still-at-p")
            clocks.host.advance(2000)
            dead, _ = proxy_request(handle.base_url, handle.dummy_token, "past-p")
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert (status, payload["error"]) == expected
    assert (alive, dead) == (200, 410)
    assert record == {"status": "unavailable", "reason": "no_echo_received"}


def test_foreign_trial_id_is_refused_and_leaves_the_bound(tmp_path: Path) -> None:
    document = echo_document(
        {"compiled_at_epoch_ms": CONTAINER_ORIGIN_MS,
         "absolute_epoch_ms": CONTAINER_ORIGIN_MS + BUDGET_MS}, BUDGET_MS,
    )
    document["trial_id"] = "trial-somebody-else"
    echo_refusal_leaves_the_bound(tmp_path, document, (403, "lease_echo_foreign"))


def test_inconsistent_budget_is_refused_and_leaves_the_bound(tmp_path: Path) -> None:
    document = echo_document(
        {"compiled_at_epoch_ms": CONTAINER_ORIGIN_MS,
         "absolute_epoch_ms": CONTAINER_ORIGIN_MS + BUDGET_MS + 1}, BUDGET_MS,
    )
    echo_refusal_leaves_the_bound(tmp_path, document, (400, "lease_echo_inconsistent"))


@pytest.mark.parametrize("remaining_ms", [-1, BUDGET_MS + 1])
def test_consumed_out_of_range_is_refused_and_leaves_the_bound(
    tmp_path: Path, remaining_ms: int,
) -> None:
    document = echo_document(
        {"compiled_at_epoch_ms": CONTAINER_ORIGIN_MS,
         "absolute_epoch_ms": CONTAINER_ORIGIN_MS + BUDGET_MS}, remaining_ms,
    )
    echo_refusal_leaves_the_bound(tmp_path, document, (400, "lease_echo_inconsistent"))


def test_malformed_echo_is_refused_and_leaves_the_bound(tmp_path: Path) -> None:
    echo_refusal_leaves_the_bound(tmp_path, b"{not json", (400, "lease_echo_malformed"))


def test_unknown_schema_version_is_refused_and_leaves_the_bound(tmp_path: Path) -> None:
    document = echo_document(
        {"compiled_at_epoch_ms": CONTAINER_ORIGIN_MS,
         "absolute_epoch_ms": CONTAINER_ORIGIN_MS + BUDGET_MS}, BUDGET_MS,
    )
    document["schema_version"] = "cortex-bench-lease-echo/99"
    echo_refusal_leaves_the_bound(tmp_path, document, (400, "lease_echo_malformed"))


def test_echo_after_the_deadline_expired_never_rearms(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        bound_ms = provisional_lease_bound_ms(clocks.host.now_ms(), BUDGET_MS)
        handle = start_leased_proxy(tmp_path, upstream, clocks, bound_ms=bound_ms)
        clocks.advance(SETUP_MS)
        deadline = compile_deadline(clocks)
        clocks.host.advance(bound_ms - clocks.host.now_ms() + 1)
        try:
            status, payload = post_echo(
                handle.base_url, handle.dummy_token, echo_document(deadline, BUDGET_MS),
            )
            after, dead_payload = proxy_request(handle.base_url, handle.dummy_token, "after")
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert (status, payload) == (410, {"error": "lease_echo_after_terminal"})
    assert (after, json.loads(dead_payload)) == (410, {"error": "deadline_expired"})
    assert record == {"status": "unavailable", "reason": "no_echo_received"}


def test_echo_after_stop_cannot_resurrect_the_route(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, _ = run_trial(tmp_path, clocks, upstream)
        handle.stop()
        with pytest.raises(OSError):
            post_echo(handle.base_url, handle.dummy_token, {"schema_version": "x"})

    assert handle.lease_echo_record == {"status": "unavailable", "reason": "no_echo_received"}


def test_rearm_racing_stop_is_serialised_by_the_stop_lock(tmp_path: Path) -> None:
    """The echo path and `stop()` contend for one lock, so a re-arm can never interleave with a
    stop. Here the re-arm wins the race and still leaves no live timer behind: the stop that was
    queued on the same lock cancels it."""
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        document = echo_document(deadline, BUDGET_MS - ELAPSED_MS)
        entered = threading.Event()
        release = threading.Event()
        original = handle._lease._arm

        def slow_arm(epoch_ms: int) -> None:
            entered.set()
            release.wait(2)
            original(epoch_ms)

        def echo_ignoring_a_cut_response() -> None:
            try:
                post_echo(handle.base_url, handle.dummy_token, document)
            except (OSError, HTTPException, ValueError):
                pass

        handle._lease._arm = slow_arm  # type: ignore[method-assign]
        echo = threading.Thread(target=echo_ignoring_a_cut_response)
        echo.start()
        assert entered.wait(3)
        stopper = threading.Thread(target=handle.stop)
        stopper.start()
        release.set()
        echo.join(5)
        stopper.join(5)

        # The re-arm ran — and the stop still won the route.
        assert handle.lease_echo_record["status"] == "available"
        assert handle._lease.timer_is_armed() is False
        with pytest.raises(OSError):
            proxy_request(handle.base_url, handle.dummy_token, "after-race")


def test_echo_that_loses_the_race_to_stop_is_refused_as_terminal(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        # `stop()` releases the lock only after the route is already revoked, so an echo that
        # arrives behind it sees a terminal route rather than re-arming one.
        handle.stop()
        with pytest.raises(LeaseRefused) as refusal:
            handle._lease.apply_echo(
                json.dumps(echo_document(deadline, BUDGET_MS - ELAPSED_MS)).encode(),
            )

    assert (refusal.value.status, refusal.value.reason) == (410, "lease_echo_after_terminal")
    assert handle._lease.timer_is_armed() is False
    assert handle.lease_echo_record == {"status": "unavailable", "reason": "no_echo_received"}


# ---------------------------------------------------------------- revocation, both routes


def test_route_fails_closed_after_stop(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        post_echo(
            handle.base_url, handle.dummy_token, echo_document(deadline, BUDGET_MS - ELAPSED_MS),
        )
        assert proxy_request(handle.base_url, handle.dummy_token, "live")[0] == 200
        handle.stop()
        with pytest.raises(OSError):
            proxy_request(handle.base_url, handle.dummy_token, "dead")


def test_route_fails_closed_after_the_armed_deadline(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        try:
            remaining_ms = BUDGET_MS - ELAPSED_MS
            _, echoed = post_echo(
                handle.base_url, handle.dummy_token, echo_document(deadline, remaining_ms),
            )
            clocks.host.advance(remaining_ms + TEARDOWN_GRACE_MS + 1)
            status, payload = proxy_request(handle.base_url, handle.dummy_token, "dead")
        finally:
            handle.stop()

    assert echoed["ok"] is True
    assert (status, json.loads(payload)) == (410, {"error": "deadline_expired"})


# ---------------------------------------------------------------- the provisional bound


def test_provisional_bound_is_the_named_setup_and_teardown_budget() -> None:
    assert provisional_lease_bound_ms(1_000, BUDGET_MS) == (
        1_000 + SETUP_TIMEOUT_MS + BUDGET_MS + TEARDOWN_GRACE_MS
    )
    assert SETUP_TIMEOUT_MS > 0 and TEARDOWN_GRACE_MS > 0


# ---------------------------------------------------------------- writer to reader


WRITER_SCRIPT = """
const policy = JSON.parse(process.env.LEASE_ECHO_POLICY);
policy.deadline.monotonic_origin_ns = BigInt(policy.deadline.monotonic_origin_ns);
const module = await import(process.env.LEASE_ECHO_MODULE);
const result = await module.publishLeaseEcho(policy, {
  monotonic_ns: () => BigInt(process.env.LEASE_ECHO_MONOTONIC_NS),
});
process.stdout.write(JSON.stringify(result));
"""


def repository_root() -> Path:
    return Path(__file__).resolve().parents[4]


def test_container_writer_document_arms_the_host_lease(tmp_path: Path) -> None:
    """The far side of the seam: the shipped container-side writer composes and posts the echo,
    and the shipped host-side reader arms the lease from it."""
    clocks = TrialClocks(600_000)
    server = repository_root() / "agent-server"
    with SyntheticUpstream() as upstream:
        handle, deadline = run_trial(tmp_path, clocks, upstream)
        try:
            remaining_ms = BUDGET_MS - ELAPSED_MS
            policy = {
                "trial_id": TRIAL_ID,
                "deadline": {**deadline, "monotonic_origin_ns": "0"},
                "credential": {
                    "proxy_base_url": handle.base_url,
                    "dummy_token_ref": handle.dummy_token,
                },
            }
            written = subprocess.run(
                ["node", "--import", "tsx", "--input-type=module", "-e", WRITER_SCRIPT],
                cwd=server, capture_output=True, text=True, timeout=120,
                env={
                    **os.environ,
                    "LEASE_ECHO_POLICY": json.dumps(policy),
                    "LEASE_ECHO_MODULE": (
                        server / "src/domain/benchmark/lease-echo.ts"
                    ).as_uri(),
                    "LEASE_ECHO_MONOTONIC_NS": str(ELAPSED_MS * 1_000_000),
                },
            )
            record = handle.lease_echo_record
        finally:
            handle.stop()

    assert written.returncode == 0, written.stderr
    assert json.loads(written.stdout) == {
        "ok": True, "lease_state": "reconciled", "armed_remaining_ms": remaining_ms,
    }
    assert record["status"] == "available"
    assert record["value"]["absolute_epoch_ms"] == deadline["absolute_epoch_ms"]
    assert upstream.requests == []


def test_model_route_still_reaches_upstream_under_the_lease(tmp_path: Path) -> None:
    clocks = TrialClocks(0)
    with SyntheticUpstream() as upstream:
        handle, _ = run_trial(tmp_path, clocks, upstream)
        try:
            status, _ = proxy_request(
                handle.base_url, handle.dummy_token, "model", target=MESSAGES_TARGET,
            )
        finally:
            handle.stop()

    assert status == 200
    assert len(upstream.requests) == 1
