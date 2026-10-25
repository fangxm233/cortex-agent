import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadTiming, ReconnectCounter } from './load-perf';

afterEach(() => vi.useRealTimers());

describe('load timing', () => {
  it('sends one load report when the page first connects', () => {
    const enqueue = vi.fn();
    const timing = new LoadTiming(enqueue, () => 42);
    timing.markFirstRender(120);
    timing.markInteractive(900);
    timing.markInteractive(1_500);
    timing.markFirstRender(2_000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ kind: 'load', ttfbMs: 42, firstRenderMs: 120, interactiveMs: 900 });
  });

  it('reports without an interactive time when the page never connects', () => {
    vi.useFakeTimers();
    const enqueue = vi.fn();
    new LoadTiming(enqueue, () => null).markFirstRender(80);
    vi.advanceTimersByTime(60_000);
    expect(enqueue).toHaveBeenCalledWith({ kind: 'load', ttfbMs: null, firstRenderMs: 80, interactiveMs: null });
  });
});

describe('SSE reconnect counter', () => {
  it('sums reconnects into one report per window', () => {
    vi.useFakeTimers();
    const enqueue = vi.fn();
    const counter = new ReconnectCounter(enqueue, 1_000);
    counter.record();
    counter.record();
    counter.record();
    expect(enqueue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(enqueue).toHaveBeenCalledWith({ kind: 'sse_reconnect', count: 3 });
    counter.record();
    vi.advanceTimersByTime(1_000);
    expect(enqueue).toHaveBeenLastCalledWith({ kind: 'sse_reconnect', count: 1 });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
