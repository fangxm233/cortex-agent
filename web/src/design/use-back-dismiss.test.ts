import { describe, it, expect, vi } from 'vitest';
import { armBackGuard, type BackGuardHost } from './use-back-dismiss';

// A fake history/event host so the guard contract is unit-testable without a DOM (this repo's test
// env has no jsdom; the window/popstate wiring is proven in the live harness).
function fakeHost() {
  const listeners = new Set<() => void>();
  const calls = { push: 0, pop: 0 };
  let depth = 0;
  const host: BackGuardHost = {
    pushSentinel: () => { calls.push += 1; depth += 1; return depth; },
    popSentinel: () => { calls.pop += 1; dispatchBack(); },
    isSentinelActive: (ownDepth) => depth === ownDepth,
    currentDepth: () => depth,
    addPopListener: (fn) => { listeners.add(fn); },
    removePopListener: (fn) => { listeners.delete(fn); },
  };
  const dispatchBack = (): void => {
    depth = Math.max(0, depth - 1);
    for (const fn of [...listeners]) fn();
  };
  const replaceSentinel = (): void => { depth = 0; };
  return { host, calls, listeners, dispatchBack, replaceSentinel };
}

describe('armBackGuard', () => {
  it('pushes exactly one sentinel history entry and registers a pop listener when armed', () => {
    const { host, calls, listeners } = fakeHost();
    armBackGuard(host, () => {});
    expect(calls.push).toBe(1);
    expect(listeners.size).toBe(1);
  });

  it('dismisses on a back press (popstate) and does NOT re-pop on teardown', () => {
    // The Android back / browser back already popped the sentinel, so tearing down must not
    // history.back() again (that would eat a second, real navigation).
    const { host, calls, listeners, dispatchBack } = fakeHost();
    const onDismiss = vi.fn();
    const teardown = armBackGuard(host, onDismiss);
    dispatchBack();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    teardown();
    expect(calls.pop).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('pops the sentinel on teardown when the overlay is closed by other means (tap-away / pick)', () => {
    // No back press happened, so the sentinel is still on the stack — teardown must remove it so the
    // next hardware back isn't wasted swallowing a stale entry.
    const { host, calls, listeners } = fakeHost();
    const onDismiss = vi.fn();
    const teardown = armBackGuard(host, onDismiss);
    teardown();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(calls.pop).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it('dismisses only once even if multiple popstate events arrive', () => {
    const { host, dispatchBack } = fakeHost();
    const onDismiss = vi.fn();
    armBackGuard(host, onDismiss);
    dispatchBack();
    dispatchBack();
    // The listener stays registered until teardown, but a second stray popstate must not double-fire
    // the dismiss into a route navigation.
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not pop the destination after route navigation replaced the sentinel', () => {
    const { host, calls, replaceSentinel } = fakeHost();
    const teardown = armBackGuard(host, vi.fn());
    replaceSentinel();
    teardown();
    expect(calls.pop).toBe(0);
  });
});


describe('nested back guards', () => {
  it('does not dismiss the outer sheet when picking tears down the inner sheet', () => {
    const { host, dispatchBack } = fakeHost();
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();
    const closeOuter = armBackGuard(host, outerDismiss);
    const closeInner = armBackGuard(host, innerDismiss);
    closeInner();
    expect(innerDismiss).not.toHaveBeenCalled();
    expect(outerDismiss).not.toHaveBeenCalled();
    dispatchBack();
    expect(outerDismiss).toHaveBeenCalledOnce();
    closeOuter();
  });

  it('dismisses only the top sheet on back and the outer sheet on the next back', () => {
    const { host, calls, dispatchBack } = fakeHost();
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();
    const closeOuter = armBackGuard(host, outerDismiss);
    const closeInner = armBackGuard(host, innerDismiss);
    dispatchBack();
    expect(innerDismiss).toHaveBeenCalledOnce();
    expect(outerDismiss).not.toHaveBeenCalled();
    closeInner();
    expect(calls.pop).toBe(0);
    dispatchBack();
    expect(outerDismiss).toHaveBeenCalledOnce();
    closeOuter();
    expect(calls.pop).toBe(0);
  });
});
