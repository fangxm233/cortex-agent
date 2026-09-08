// input:  Vitest fake timers and an injected delay histogram
// output: sampling, reset, and stop assertions for the event-loop monitor
// pos:    Verify event-loop lag recording and monitor lifecycle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

import {
  getEventLoopLagReading,
  sampleEventLoopLagOnce,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  type EventLoopDelayHistogram,
} from '../src/domain/monitor/event-loop-monitor.js';

const MS = 1e6; // histogram values are nanoseconds

/** Fixed-value histogram: every window reports the same percentiles until it is reset. */
function fakeHistogram(): EventLoopDelayHistogram & { enabled: boolean; resets: number } {
  return {
    enabled: false,
    resets: 0,
    max: 40 * MS,
    enable() { this.enabled = true; return true; },
    disable() { this.enabled = false; return true; },
    reset() { this.resets += 1; },
    percentile(p: number) { return (p >= 99 ? 12 : 3) * MS; },
  };
}

afterEach(() => {
  stopEventLoopMonitor();
  vi.useRealTimers();
});

test('an interval tick records p50/p99/max in ms and resets the window', () => {
  vi.useFakeTimers();
  const histogram = fakeHistogram();
  startEventLoopMonitor({ intervalMs: 1000, createHistogram: () => histogram });

  assert.equal(histogram.enabled, true);
  assert.equal(getEventLoopLagReading(), null);

  vi.advanceTimersByTime(1000);

  const reading = getEventLoopLagReading();
  assert.ok(reading, 'a tick must record a reading');
  assert.equal(typeof reading.p50Ms, 'number');
  assert.equal(typeof reading.p99Ms, 'number');
  assert.equal(typeof reading.maxMs, 'number');
  assert.equal(reading.p50Ms, 3);
  assert.equal(reading.p99Ms, 12);
  assert.equal(reading.maxMs, 40);
  assert.equal(reading.windowMs, 1000);
  assert.equal(histogram.resets, 1, 'each window resets the histogram');

  vi.advanceTimersByTime(2000);
  assert.equal(histogram.resets, 3, 'sampling continues every interval');
});

test('stop disables sampling and further ticks record nothing', () => {
  vi.useFakeTimers();
  const histogram = fakeHistogram();
  startEventLoopMonitor({ intervalMs: 1000, createHistogram: () => histogram });
  vi.advanceTimersByTime(1000);

  stopEventLoopMonitor();

  assert.equal(histogram.enabled, false, 'stop disables the histogram');
  assert.equal(getEventLoopLagReading(), null);
  assert.equal(sampleEventLoopLagOnce(), null);
  vi.advanceTimersByTime(5000);
  assert.equal(histogram.resets, 1, 'the interval no longer fires after stop');
  assert.equal(getEventLoopLagReading(), null);
});

test('the real perf_hooks histogram yields numeric percentiles', () => {
  startEventLoopMonitor({ intervalMs: 60_000 });

  const reading = sampleEventLoopLagOnce();

  assert.ok(reading, 'a manual tick must record a reading');
  for (const value of [reading.p50Ms, reading.p99Ms, reading.maxMs]) {
    assert.equal(Number.isFinite(value), true);
    assert.ok(value >= 0);
  }
  assert.deepEqual(getEventLoopLagReading(), reading);
});

test('a second start is ignored while one monitor is running', () => {
  const first = fakeHistogram();
  const second = fakeHistogram();
  startEventLoopMonitor({ intervalMs: 60_000, createHistogram: () => first });
  startEventLoopMonitor({ intervalMs: 60_000, createHistogram: () => second });

  assert.equal(first.enabled, true);
  assert.equal(second.enabled, false, 'the second histogram is never enabled');
});
