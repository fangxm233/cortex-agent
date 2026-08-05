# input:  a provisional bound, the arm's deadline budget, and the container's echoed durations
# output: the armed credential lease, its revocation timer, and the host-side echo record
# pos:    Credential lease and echo-back arithmetic
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import threading
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

LEASE_ECHO_TARGET = "/_cortex/lease-echo"
LEASE_ECHO_SCHEMA_VERSION = "cortex-bench-lease-echo/1"
LEASE_ECHO_MISSING_CHECK_ID = "lease_echo_missing"
TERMINAL_PREDICATE_UNMET = 41


@dataclass(frozen=True)
class LeaseTerms:
    """The two durations the host needs to read an echo. Both are durations, never instants."""

    #: The arm's `limits.deadline_seconds` in milliseconds — the trial's whole budget.
    budget_ms: int
    #: The interval the lease outlives the trial deadline by, so revocation follows inventory
    #: capture rather than racing it.
    teardown_grace_ms: int

    def __post_init__(self) -> None:
        if self.budget_ms <= 0:
            raise ValueError("budget_ms must be a positive duration")
        if self.teardown_grace_ms < 0:
            raise ValueError("teardown_grace_ms must not be negative")


class LeaseRefused(Exception):
    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


class LeaseHolder(Protocol):
    def set_deadline_ms(self, epoch_ms: int) -> None: ...
    def lifecycle_error(self) -> tuple[int, str] | None: ...
    def record_lease(self, entry: Mapping[str, object]) -> bool: ...


class ExpiryTarget(Protocol):
    def expire_route(self) -> None: ...


@dataclass(frozen=True)
class TerminalCheck:
    check_id: str
    passed: bool
    failure_code: int | None


def lease_echo_terminal_check(record: Mapping[str, object]) -> TerminalCheck:
    """A trial that never echoed is not a green trial. Its credential route stayed bounded, which
    is the route failing closed; the trial itself fails closed here instead."""
    if record.get("status") == "available":
        return TerminalCheck(LEASE_ECHO_MISSING_CHECK_ID, True, None)
    return TerminalCheck(LEASE_ECHO_MISSING_CHECK_ID, False, TERMINAL_PREDICATE_UNMET)


def _integer(document: Mapping[str, Any], key: str) -> int:
    value = document.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise LeaseRefused(400, "lease_echo_malformed")
    return value


def parse_lease_echo(body: bytes) -> dict[str, Any]:
    """Parse and shape-check the container's document. Nothing here is trusted."""
    try:
        document = json.loads(body)
    except (ValueError, UnicodeDecodeError) as error:
        raise LeaseRefused(400, "lease_echo_malformed") from error
    if not isinstance(document, dict):
        raise LeaseRefused(400, "lease_echo_malformed")
    if document.get("schema_version") != LEASE_ECHO_SCHEMA_VERSION:
        raise LeaseRefused(400, "lease_echo_malformed")
    if not isinstance(document.get("trial_id"), str):
        raise LeaseRefused(400, "lease_echo_malformed")
    return {
        "trial_id": document["trial_id"],
        "compiled_at_epoch_ms": _integer(document, "compiled_at_epoch_ms"),
        "absolute_epoch_ms": _integer(document, "absolute_epoch_ms"),
        "remaining_ms": _integer(document, "remaining_ms"),
    }


class TrialLease:
    """The proxy's own expiry instant and the timer that revokes it.

    The bound armed at start is provisional and can only be too long, so the container is allowed to
    shorten it — and only to shorten it. Every value the container sends is a duration or an instant
    on the container's own clock; neither is ever an operand of a comparison against a host instant.
    """

    def __init__(
        self, *, trial_id: str, state: LeaseHolder, server: ExpiryTarget,
        provisional_bound_ms: int, terms: LeaseTerms, now_ms: Callable[[], int],
    ) -> None:
        self.trial_id = trial_id
        self.provisional_bound_ms = provisional_bound_ms
        self.terms = terms
        # One lock for the timer, the echo latch and the stop, so a re-arm racing a stop cannot
        # resurrect a route the stop already revoked.
        self.lock = threading.RLock()
        self._state = state
        self._server = server
        self._now_ms = now_ms
        self._timer: threading.Timer | None = None
        self._stopped = False
        self._echo: dict[str, object] | None = None

    def arm_provisional_bound(self) -> None:
        with self.lock:
            self._arm(self.provisional_bound_ms)

    def stop(self) -> None:
        """Cancel the revocation timer. The caller holds `self.lock` for the whole stop."""
        self._stopped = True
        self._cancel_timer()

    def timer_is_armed(self) -> bool:
        with self.lock:
            return self._timer is not None

    @property
    def record(self) -> dict[str, object]:
        """The §9.6 A5 tagged union. An echo that never arrived is unavailable, never zero."""
        with self.lock:
            if self._echo is None:
                return {"status": "unavailable", "reason": "no_echo_received"}
            return {"status": "available", "value": dict(self._echo)}

    def apply_echo(self, body: bytes) -> dict[str, object]:
        document = parse_lease_echo(body)
        with self.lock:
            self._refuse_if_terminal()
            if self._echo is not None:
                self._audit({"outcome": "lease_echo_duplicate"})
                raise LeaseRefused(409, "lease_echo_duplicate")
            durations = self._validated_durations(document)
            return self._reconcile(document, durations)

    # `budget_ms` and `consumed_ms` are differences of two readings of the container's own clock,
    # so a constant offset between the two clocks cancels out of both.
    def _validated_durations(self, document: Mapping[str, Any]) -> tuple[int, int]:
        if document["trial_id"] != self.trial_id:
            self._audit({"outcome": "lease_echo_foreign"})
            raise LeaseRefused(403, "lease_echo_foreign")
        budget_ms = document["absolute_epoch_ms"] - document["compiled_at_epoch_ms"]
        consumed_ms = budget_ms - document["remaining_ms"]
        if budget_ms != self.terms.budget_ms or not 0 <= consumed_ms <= budget_ms:
            self._audit({"outcome": "lease_echo_inconsistent"})
            raise LeaseRefused(400, "lease_echo_inconsistent")
        return budget_ms, consumed_ms

    def _reconcile(
        self, document: Mapping[str, Any], durations: tuple[int, int],
    ) -> dict[str, object]:
        budget_ms, consumed_ms = durations
        now = self._now_ms()
        # The only arithmetic that mixes the two sides, and it adds durations to a host instant.
        requested = now + document["remaining_ms"] + self.terms.teardown_grace_ms
        armed = min(requested, self.provisional_bound_ms)
        lease_state = "clamped" if armed < requested else "reconciled"
        echo = {
            "absolute_epoch_ms": document["absolute_epoch_ms"],
            "compiled_at_epoch_ms": document["compiled_at_epoch_ms"],
            "budget_ms": budget_ms,
            "consumed_ms": consumed_ms,
            "lease_state": lease_state,
            "armed_remaining_ms": armed - self.terms.teardown_grace_ms - now,
        }
        self._audit(echo)
        self._echo = echo
        self._arm(armed)
        return {
            "ok": True, "lease_state": lease_state,
            "armed_remaining_ms": echo["armed_remaining_ms"],
        }

    def _refuse_if_terminal(self) -> None:
        # An expired or stopped route is never re-armed.
        if self._stopped or self._state.lifecycle_error() is not None:
            raise LeaseRefused(410, "lease_echo_after_terminal")

    def _audit(self, entry: Mapping[str, object]) -> None:
        if not self._state.record_lease({"event": "lease_echo", **entry}):
            raise LeaseRefused(500, "audit_log_unavailable")

    def _arm(self, epoch_ms: int) -> None:
        """Point the lease at `epoch_ms`. The caller holds `self.lock`."""
        self._cancel_timer()
        self._state.set_deadline_ms(epoch_ms)
        timer = threading.Timer(self._delay_seconds(epoch_ms), self._server.expire_route)
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _cancel_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _delay_seconds(self, epoch_ms: int) -> float:
        return max((epoch_ms - self._now_ms()) / 1000, 0)
