# input:  a live trial proxy, its audit log, its lease record and unreadable counter stubs
# output: request-count fidelity, unavailable-not-zero proofs and the seam golden files
# pos:    Proxy accounting export tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.lease_bound import (
    TEARDOWN_GRACE_MS,
    provisional_lease_bound_ms,
)
from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from cortex_bench_harness.proxy.export import (
    PROXY_EXPORT_SCHEMA_VERSION,
    UNAVAILABLE_REASONS,
    build_proxy_export,
    render_proxy_export,
    unavailable,
)
from cortex_bench_harness.proxy.lease import LEASE_ECHO_SCHEMA_VERSION, LeaseTerms
from synthetic import SyntheticUpstream, proxy_request, row_one_adapter
from test_lease_echo import post_echo

GOLDEN_DIR = Path(__file__).parent / "golden"
REAL_CREDENTIAL = "sk-ant-SYNTHETIC-EXPORT-UNIQUE"
TRIAL_ID = "trial-export"
BUDGET_MS = 1_800_000
# Every value the golden files depend on is fixed here, so the bytes the TypeScript reconciliation
# parses are a function of this file alone and not of the wall clock the test ran under.
HOST_ORIGIN_MS = 1_800_000_000_000
CONTAINER_ORIGIN_MS = 1_700_000_000_000
SETUP_MS = 90_000
ELAPSED_MS = 120_000


class FixedClock:
    def __init__(self, epoch_ms: int) -> None:
        self.epoch_ms = epoch_ms

    def now_ms(self) -> int:
        return self.epoch_ms

    def advance(self, delta_ms: int) -> None:
        self.epoch_ms += delta_ms


def budget() -> ProxyBudget:
    return ProxyBudget(
        max_cost_usd=Decimal("10"),
        max_request_cost_usd=Decimal("1"),
        input_cost_per_million_usd=Decimal("3"),
        output_cost_per_million_usd=Decimal("15"),
    )


def start_export_proxy(tmp_path: Path, upstream: SyntheticUpstream, clock: FixedClock):
    bound_ms = provisional_lease_bound_ms(clock.now_ms(), BUDGET_MS)
    return start_trial_proxy(
        trial_id=TRIAL_ID,
        upstream_base_url=upstream.base_url,
        adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
        bound_source_ip="127.0.0.1",
        absolute_deadline=datetime.fromtimestamp(bound_ms / 1000, UTC),
        budget=budget(),
        log_path=tmp_path / "proxy.jsonl",
        lease_terms=LeaseTerms(BUDGET_MS, TEARDOWN_GRACE_MS),
        now_ms=clock.now_ms,
    )


def echoed_trial(tmp_path: Path, upstream: SyntheticUpstream, requests: int):
    """One trial that echoes its remaining budget back and then makes `requests` model calls."""
    clock = FixedClock(HOST_ORIGIN_MS)
    handle = start_export_proxy(tmp_path, upstream, clock)
    clock.advance(SETUP_MS)
    document = {
        "schema_version": LEASE_ECHO_SCHEMA_VERSION,
        "trial_id": TRIAL_ID,
        "compiled_at_epoch_ms": CONTAINER_ORIGIN_MS,
        "absolute_epoch_ms": CONTAINER_ORIGIN_MS + BUDGET_MS,
        "remaining_ms": BUDGET_MS - ELAPSED_MS,
    }
    post_echo(handle.base_url, handle.dummy_token, document)
    for index in range(requests):
        proxy_request(handle.base_url, handle.dummy_token, f"call-{index}")
    return handle


def silent_trial(tmp_path: Path, upstream: SyntheticUpstream, requests: int):
    """One trial that never echoes — the (15.3.5) case the record must carry as unavailable."""
    clock = FixedClock(HOST_ORIGIN_MS)
    handle = start_export_proxy(tmp_path, upstream, clock)
    for index in range(requests):
        proxy_request(handle.base_url, handle.dummy_token, f"call-{index}")
    return handle


class RaisingCounters:
    """A counter source whose cost is not readable. The export must not read it as zero."""

    request_count = 4
    input_tokens = 8
    output_tokens = 16

    @property
    def cost_usd(self) -> Decimal:
        raise OSError("counter register unavailable")


class DefaultInitialisedCounters:
    """The A5 hazard in its most ordinary form: an object whose fields were never filled."""

    request_count = None
    input_tokens = None
    output_tokens = None
    cost_usd = None


def zero_valued_slots(document: object, path: str = "") -> list[str]:
    """Every path in the document whose value is a zero of any shape."""
    if isinstance(document, dict):
        return [
            hit
            for key, value in document.items()
            for hit in zero_valued_slots(value, f"{path}.{key}")
        ]
    if document in (0, "0", 0.0) and not isinstance(document, bool):
        return [path]
    return []


def test_export_reports_exactly_the_requests_the_trial_made(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = echoed_trial(tmp_path, upstream, requests=3)
        try:
            export = handle.accounting_export
        finally:
            handle.stop()

    assert export["schema_version"] == PROXY_EXPORT_SCHEMA_VERSION
    assert export["trial_id"] == TRIAL_ID
    assert export["requests"] == {"status": "available", "value": 3}
    assert export["input_tokens"] == {"status": "available", "value": 6}
    assert export["output_tokens"] == {"status": "available", "value": 9}
    assert export["cost_usd"] == {"status": "available", "value": "0.000153"}
    assert export["audit_log"]["value"]["durable_requests"] == 3
    assert export["audit_log"]["value"]["agrees_with_counters"] is True


def test_a_counter_that_could_not_be_read_is_unavailable_not_zero(tmp_path: Path) -> None:
    export = build_proxy_export(
        trial_id=TRIAL_ID, adapter_id="row-1", counters=RaisingCounters(),
        log_path=tmp_path / "absent.jsonl", lease_echo=None,
    )

    assert export["cost_usd"] == {"status": "unavailable", "reason": "counter_unreadable"}
    assert export["requests"] == {"status": "available", "value": 4}
    assert zero_valued_slots(export) == []


def test_default_initialised_counters_never_yield_zeros(tmp_path: Path) -> None:
    export = build_proxy_export(
        trial_id=TRIAL_ID, adapter_id="row-1", counters=DefaultInitialisedCounters(),
        log_path=tmp_path / "absent.jsonl", lease_echo=None,
    )

    for slot in ("requests", "input_tokens", "output_tokens", "cost_usd"):
        assert export[slot] == {"status": "unavailable", "reason": "counter_unreadable"}
    assert zero_valued_slots(export) == []


def test_an_unstarted_proxy_is_unavailable_rather_than_a_zero_total(tmp_path: Path) -> None:
    export = build_proxy_export(
        trial_id=TRIAL_ID, adapter_id="row-1", counters=None,
        log_path=None, lease_echo=None,
    )

    for slot in ("requests", "input_tokens", "output_tokens", "cost_usd", "lease_echo"):
        assert export[slot] == {"status": "unavailable", "reason": "proxy_not_started"}
    assert zero_valued_slots(export) == []


def test_an_unreadable_audit_log_is_unavailable(tmp_path: Path) -> None:
    unreadable = tmp_path / "log-is-a-directory.jsonl"
    unreadable.mkdir()

    export = build_proxy_export(
        trial_id=TRIAL_ID, adapter_id="row-1", counters=RaisingCounters(),
        log_path=unreadable, lease_echo=None,
    )

    assert export["audit_log"] == {"status": "unavailable", "reason": "audit_log_unreadable"}


def test_a_corrupt_audit_line_makes_the_durable_totals_unavailable(tmp_path: Path) -> None:
    log_path = tmp_path / "proxy.jsonl"
    log_path.write_text('{"request_count": 1}\nnot json\n', encoding="utf-8")

    export = build_proxy_export(
        trial_id=TRIAL_ID, adapter_id="row-1", counters=RaisingCounters(),
        log_path=log_path, lease_echo=None,
    )

    assert export["audit_log"] == {"status": "unavailable", "reason": "audit_log_unreadable"}


def test_a_trial_that_made_no_calls_reports_a_read_zero(tmp_path: Path) -> None:
    """R-A5-1's other half: 0 is legal when the counter was read and really was zero."""
    with SyntheticUpstream() as upstream:
        handle = silent_trial(tmp_path, upstream, requests=0)
        try:
            export = handle.accounting_export
        finally:
            handle.stop()

    assert export["requests"] == {"status": "available", "value": 0}
    assert export["cost_usd"] == {"status": "available", "value": "0"}
    # The proxy writes its first audit line on its first request, so a trial that made none has no
    # log to read. That is an unread source, not a durable zero.
    assert export["audit_log"] == {"status": "unavailable", "reason": "audit_log_unreadable"}


def test_a_trial_with_no_echo_carries_the_lease_record_as_unavailable(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = silent_trial(tmp_path, upstream, requests=1)
        try:
            export = handle.accounting_export
        finally:
            handle.stop()

    assert export["lease_echo"] == {"status": "unavailable", "reason": "no_echo_received"}


def test_an_unavailable_reason_outside_the_closed_set_is_refused() -> None:
    with pytest.raises(ValueError):
        unavailable("looked_fine_to_me")
    assert "no_echo_received" in UNAVAILABLE_REASONS


# ------------------------------------------------------- the cross-language seam
#
# The TypeScript reconciliation parses these files byte for byte. The two tests below are what makes
# them evidence rather than decoration: each rebuilds the export from a real proxy and fails unless
# the committed bytes are exactly what this side emits. Regenerate with
# CORTEX_BENCH_WRITE_GOLDEN=1.


def assert_golden(name: str, export: dict) -> None:
    rendered = render_proxy_export(export)
    path = GOLDEN_DIR / name
    if os.environ.get("CORTEX_BENCH_WRITE_GOLDEN") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
    assert path.read_text(encoding="utf-8") == rendered


def test_seam_golden_of_an_echoed_trial_is_the_bytes_this_side_emits(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = echoed_trial(tmp_path, upstream, requests=3)
        try:
            export = handle.accounting_export
        finally:
            handle.stop()

    assert_golden("proxy-export-echoed.json", export)


def test_seam_golden_of_a_silent_trial_is_the_bytes_this_side_emits(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        handle = silent_trial(tmp_path, upstream, requests=2)
        try:
            export = handle.accounting_export
        finally:
            handle.stop()

    assert_golden("proxy-export-no-echo.json", export)
