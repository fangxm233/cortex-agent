# input:  one trial proxy's live counters, its JSONL audit log and its lease record
# output: the proxy-authoritative accounting export, every figure tagged, never defaulted
# pos:    Proxy-authoritative accounting export
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from .models import decimal_text

PROXY_EXPORT_SCHEMA_VERSION = "cortex-bench-proxy-export/1"

# The closed set of reasons a figure may be missing. It is closed so that the reconciliation on the
# other side of the seam can refuse a document carrying a reason it does not know, and so that a new
# way of failing to read a counter cannot be smuggled in as free text.
UNAVAILABLE_REASONS = frozenset({
    "proxy_not_started",
    "counter_unreadable",
    "audit_log_unreadable",
    "no_echo_received",
})

COUNTER_SLOTS = ("requests", "input_tokens", "output_tokens", "cost_usd")


class ProxyCounters(Protocol):
    """The proxy's own running totals. `ProxyState` satisfies this structurally."""

    request_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal


def available(value: object) -> dict[str, object]:
    return {"status": "available", "value": value}


def unavailable(reason: str) -> dict[str, object]:
    if reason not in UNAVAILABLE_REASONS:
        raise ValueError(f"unknown unavailable reason: {reason!r}")
    return {"status": "unavailable", "reason": reason}


def build_proxy_export(
    *, trial_id: str, adapter_id: str, counters: ProxyCounters | None,
    log_path: Path | None, lease_echo: Mapping[str, object] | None,
) -> dict[str, object]:
    """The A1 side of the reconciliation: what the proxy itself observed.

    Nothing here is defaulted. A figure the proxy could not read is `unavailable` with a reason, so
    that missing telemetry cannot arrive downstream wearing the same shape as a real zero.
    """
    export: dict[str, object] = {
        "schema_version": PROXY_EXPORT_SCHEMA_VERSION,
        "trial_id": trial_id,
        "adapter_id": adapter_id,
        "source": "proxy_export",
    }
    export.update(_counter_slots(counters))
    export["audit_log"] = _audit_slot(log_path, counters)
    export["lease_echo"] = dict(lease_echo) if lease_echo else unavailable("proxy_not_started")
    return export


def render_proxy_export(export: Mapping[str, object]) -> str:
    """The bytes the reconciliation on the other side of the seam parses."""
    return json.dumps(export, indent=2, sort_keys=True) + "\n"


def _counter_slots(counters: ProxyCounters | None) -> dict[str, object]:
    if counters is None:
        return {slot: unavailable("proxy_not_started") for slot in COUNTER_SLOTS}
    return {
        "requests": _read(counters, "request_count", _count),
        "input_tokens": _read(counters, "input_tokens", _count),
        "output_tokens": _read(counters, "output_tokens", _count),
        "cost_usd": _read(counters, "cost_usd", _decimal),
    }


def _read(
    counters: ProxyCounters, name: str, shape: Callable[[object], object],
) -> dict[str, object]:
    """Read one counter. A read that raises, or a value of the wrong shape, is unavailable.

    The broad catch is the point: any failure to read a register must degrade to `unavailable`,
    never to the zero a default initialiser would have left behind.
    """
    try:
        return available(shape(getattr(counters, name)))
    except Exception:
        return unavailable("counter_unreadable")


def _count(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"not a counter value: {value!r}")
    return value


def _decimal(value: object) -> str:
    # Costs cross the seam as decimal strings on both sides: a binary float would make the
    # comparison against the journal depend on representation rather than on value.
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError(f"not a decimal cost: {value!r}")
    return decimal_text(value)


def _audit_slot(
    log_path: Path | None, counters: ProxyCounters | None,
) -> dict[str, object]:
    if log_path is None:
        return unavailable("proxy_not_started")
    try:
        entries = _read_audit_log(log_path)
    except (OSError, ValueError):
        return unavailable("audit_log_unreadable")
    return available(_durable_totals(entries, counters))


def _read_audit_log(log_path: Path) -> list[dict[str, Any]]:
    with log_path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _durable_totals(
    entries: list[dict[str, Any]], counters: ProxyCounters | None,
) -> dict[str, object]:
    """The totals the log itself carries, as a check on the live registers.

    Each request line records the running totals as of that request, so the last one carries the
    durable figures. Lease lines carry no counters and are skipped.
    """
    metered = [entry for entry in entries if "request_count" in entry]
    tail = metered[-1] if metered else None
    return {
        "entries": len(entries),
        "durable_requests": tail["request_count"] if tail else 0,
        "durable_cost_usd": tail["cost_usd"] if tail else "0",
        "agrees_with_counters": _agrees(tail, counters),
    }


def _agrees(tail: dict[str, Any] | None, counters: ProxyCounters | None) -> bool:
    if counters is None:
        return False
    try:
        durable = (tail["request_count"], Decimal(tail["cost_usd"])) if tail else (0, Decimal(0))
        return durable == (counters.request_count, counters.cost_usd)
    except Exception:
        return False
