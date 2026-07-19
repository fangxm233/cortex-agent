import { describe, it, expect, vi } from 'vitest';
import { armBackGuard, type BackGuardHost } from './use-back-dismiss';

// A fake history/event host so the guard contract is unit-testable without a DOM (this repo's test
// env has no jsdom; the window/popstate wiring is proven in the live harness).
function fakeHost() {
  const listeners = new Set<() => void>();
  const calls = { push: 0, pop: 0 };
  const host: BackGuardHost = {
    pushSentinel: () => { calls.push += 1; },
    popSentinel: () => { calls.pop += 1; },
    addPopListener: (fn) => { listeners.add(fn); },
    removePopListener: (fn) => { listeners.delete(fn); },
  };
  const dispatchBack = (): void => { for (const fn of [...listeners]) fn(); };
  return { host, calls, listeners, dispatchBack };
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

  it('skips sentinel pop on teardown when isSentinelCurrent returns false (parent already navigated away)', () => {
    // When the parent navigates away with { replace: true } before unmount, the sentinel is no
    // longer the current history entry. Popping now would undo the parent's navigation and cause
    // the overlay to flicker back open.
    const { host, calls, listeners } = fakeHost();
    host.isSentinelCurrent = () => false;
    const onDismiss = vi.fn();
    const teardown = armBackGuard(host, onDismiss);
    teardown();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(calls.pop).toBe(0); // sentinel NOT popped — parent already navigated past it
    expect(listeners.size).toBe(0);
  });

  it('still pops sentinel on teardown when isSentinelCurrent returns true', () => {
    // When the sentinel is still current (e.g. in-place overlay closed by tap-away), the
    // teardown must pop it so the history stack stays balanced.
    const { host, calls } = fakeHost();
    host.isSentinelCurrent = () => true;
    const onDismiss = vi.fn();
    const teardown = armBackGuard(host, onDismiss);
    teardown();
    expect(calls.pop).toBe(1);
  });
});
