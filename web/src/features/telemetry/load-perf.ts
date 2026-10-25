import { telemetryQueue, type WebTelemetryReport } from './report-queue';

// One `load` report per page load: time to first byte, the root's first commit, and the first
// live connection (the point the workbench is usable). Times are ms since navigation start.

/** A page that never connects still reports its first two numbers after this long. */
const INTERACTIVE_WAIT_MS = 60_000;
/** SSE reconnects are summed and sent at most this often. */
const RECONNECT_FLUSH_MS = 5 * 60_000;

type Enqueue = (report: WebTelemetryReport) => void;

function now(): number | null {
  return typeof performance === 'undefined' ? null : Math.round(performance.now());
}

function navigationTtfb(): number | null {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return null;
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return nav && nav.responseStart > 0 ? Math.round(nav.responseStart) : null;
}

export class LoadTiming {
  private firstRenderMs: number | null = null;
  private sent = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly enqueue: Enqueue, private readonly ttfb = navigationTtfb) {}

  markFirstRender(at = now()): void {
    if (this.firstRenderMs !== null || this.sent) return;
    this.firstRenderMs = at;
    this.timer = setTimeout(() => this.send(null), INTERACTIVE_WAIT_MS);
  }

  markInteractive(at = now()): void {
    this.send(at);
  }

  private send(interactiveMs: number | null): void {
    if (this.sent) return;
    this.sent = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.enqueue({ kind: 'load', ttfbMs: this.ttfb(), firstRenderMs: this.firstRenderMs, interactiveMs });
  }
}

export class ReconnectCounter {
  private count = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly enqueue: Enqueue, private readonly flushMs = RECONNECT_FLUSH_MS) {}

  record(): void {
    this.count += 1;
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  private flush(): void {
    this.timer = null;
    const count = Math.min(this.count, 1_000);
    this.count = 0;
    if (count > 0) this.enqueue({ kind: 'sse_reconnect', count });
  }
}

const enqueue: Enqueue = (report) => telemetryQueue.enqueue(report);
export const loadTiming = new LoadTiming(enqueue);
export const sseReconnects = new ReconnectCounter(enqueue);
