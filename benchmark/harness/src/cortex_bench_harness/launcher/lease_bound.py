# input:  the host instant at which the launcher arms the proxy and the arm's deadline budget
# output: the provisional credential-lease bound the proxy is armed with
# pos:    Provisional lease bound
# >>> If I am updated, update my header and folder CORTEX.md <<<

# The launcher arms the credential proxy before the container exists, so it cannot know the trial's
# own deadline: that instant is derived inside the container, from the container's clock, at policy
# compile. Only durations may cross that boundary. The launcher therefore arms a bound built out of
# host instants and durations alone, chosen so it can only ever be too long — never too short — and
# lets the container shorten it later by echoing back a duration.
#
#     P = H0 + SETUP_TIMEOUT_MS + deadline_budget_ms + TEARDOWN_GRACE_MS
#
# H0 is the host instant of the arming call. Phase B compiles at some host instant H_B >= H0, and the
# launcher abandons the trial when H_B - H0 exceeds SETUP_TIMEOUT_MS, so on every trial that proceeds
# H_B <= H0 + SETUP_TIMEOUT_MS. The trial's deadline as a host instant is H_B + deadline_budget_ms,
# because a duration is the same on both clocks; hence it is at most P - TEARDOWN_GRACE_MS < P. The
# slack is the unused setup budget plus the teardown grace.

# The maximum host-measured interval the launcher permits between arming the proxy and phase B
# reporting in: image pull, container create, package install and the CLI probe all live inside it.
# It is a bound the launcher enforces, not an estimate it hopes for.
SETUP_TIMEOUT_MS = 900_000

# The interval the trial needs between its own deadline and the proxy being stopped, because
# revocation happens after the trial's artifacts are inventoried and exported rather than at the
# deadline itself.
TEARDOWN_GRACE_MS = 120_000


def provisional_lease_bound_ms(h0_epoch_ms: int, deadline_budget_ms: int) -> int:
    """The provisional bound `P` for a proxy armed at host instant `h0_epoch_ms`."""
    if deadline_budget_ms <= 0:
        raise ValueError("deadline_budget_ms must be a positive duration")
    return h0_epoch_ms + SETUP_TIMEOUT_MS + deadline_budget_ms + TEARDOWN_GRACE_MS


def setup_within_bound(h0_epoch_ms: int, phase_b_epoch_ms: int) -> bool:
    """Whether phase B reported in inside `SETUP_TIMEOUT_MS`, the premise that makes `P` a bound.

    Both arguments are read on the host clock, so their difference is a host duration.
    """
    return 0 <= phase_b_epoch_ms - h0_epoch_ms <= SETUP_TIMEOUT_MS
