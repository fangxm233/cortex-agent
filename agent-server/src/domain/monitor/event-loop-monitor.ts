// input:  node:perf_hooks event-loop delay histogram, sample interval, optional histogram seam
// output: start/stop, a manual sample tick, and the last recorded lag reading
// pos:    Records event-loop lag percentiles for the daemon process
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createLogger } from '@core/log.js';

const log = createLogger('event-loop-monitor');

/** Sampling granularity of the delay histogram. */
const RESOLUTION_MS = 20;
const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000;

/** The slice of `IntervalHistogram` this monitor uses; narrowed so tests can supply a fake. */
export interface EventLoopDelayHistogram {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(percentile: number): number;
  readonly max: number;
}

/** One closed sampling window, in milliseconds. */
export interface EventLoopLagReading {
  /** Wall clock at which the window closed. */
  at: number;
  /** Length of the window that produced these percentiles. */
  windowMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface EventLoopMonitorOptions {
  intervalMs?: number;
  /** Test seam: supplies the histogram instead of `monitorEventLoopDelay`. */
  createHistogram?: () => EventLoopDelayHistogram;
}

let _histogram: EventLoopDelayHistogram | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
let _intervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
let _last: EventLoopLagReading | null = null;

/** Histogram values are nanoseconds; an empty window can report a non-finite sentinel. */
function toMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return 0;
  return Number((nanoseconds / 1e6).toFixed(3));
}

/**
 * Close the current window: read the percentiles, record them, and reset the histogram.
 * Exported as the manual tick used by the interval and by tests. Returns null when stopped.
 */
export function sampleEventLoopLagOnce(): EventLoopLagReading | null {
  if (!_histogram) return null;
  const reading: EventLoopLagReading = {
    at: Date.now(),
    windowMs: _intervalMs,
    p50Ms: toMs(_histogram.percentile(50)),
    p99Ms: toMs(_histogram.percentile(99)),
    maxMs: toMs(_histogram.max),
  };
  _histogram.reset();
  _last = reading;
  log.info(`lag p50=${reading.p50Ms}ms p99=${reading.p99Ms}ms max=${reading.maxMs}ms window=${Math.round(reading.windowMs / 1000)}s`);
  return reading;
}

/** Last closed window, or null before the first sample and after stop. */
export function getEventLoopLagReading(): EventLoopLagReading | null {
  return _last;
}

/**
 * Begin recording event-loop lag. Agent sessions run inside this process, so a stalled loop
 * degrades every one of them at once — the p99 of each window goes on record for that reason.
 * Recording only: nothing here alerts or changes behaviour.
 */
export function startEventLoopMonitor(options: EventLoopMonitorOptions = {}): void {
  if (_histogram) {
    log.info('Already initialized, skipping');
    return;
  }
  _intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  _histogram = (options.createHistogram ?? (() => monitorEventLoopDelay({ resolution: RESOLUTION_MS })))();
  _histogram.enable();
  _timer = setInterval(() => { sampleEventLoopLagOnce(); }, _intervalMs);
  // The daemon's lifetime is owned by its servers, never by this metric timer.
  if (typeof _timer.unref === 'function') _timer.unref();
  log.info(`Initialized (resolution=${RESOLUTION_MS}ms, interval=${Math.round(_intervalMs / 1000)}s)`);
}

export function stopEventLoopMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _histogram?.disable();
  _histogram = null;
  _intervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
  _last = null;
}
