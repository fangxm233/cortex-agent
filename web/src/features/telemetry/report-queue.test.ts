import { describe, expect, it, vi } from 'vitest';
import { ReportQueue, type WebTelemetryReport } from './report-queue';

function crash(message: string, frame = '    at render (index.js:1:2)'): WebTelemetryReport {
  return {
    kind: 'crash', crashKind: 'windowError', errorName: 'TypeError', message,
    stack: `TypeError: ${message}\n${frame}`, route: '/workbench', buildStamp: 'dev', uptimeS: 3,
  };
}
const load: WebTelemetryReport = { kind: 'load', ttfbMs: 10, firstRenderMs: 20, interactiveMs: 30 };

describe('ReportQueue', () => {
  it('holds reports until a sink is attached, then flushes them in order', () => {
    const queue = new ReportQueue();
    const sink = vi.fn(async (_report: WebTelemetryReport) => undefined);
    queue.enqueue(load);
    queue.enqueue(crash('a'));
    expect(sink).not.toHaveBeenCalled();
    queue.attach(sink);
    expect(sink.mock.calls.map(([r]) => r.kind)).toEqual(['load', 'crash']);
    queue.enqueue({ kind: 'sse_reconnect', count: 2 });
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it('sends a repeated crash once', () => {
    const queue = new ReportQueue();
    const sink = vi.fn(async () => undefined);
    queue.attach(sink);
    queue.enqueue(crash('same'));
    queue.enqueue(crash('same'));
    queue.enqueue(crash('same', '    at other (index.js:9:9)'));
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('caps the distinct crashes of one page load', () => {
    const queue = new ReportQueue();
    const sink = vi.fn(async () => undefined);
    queue.attach(sink);
    for (let i = 0; i < 25; i += 1) queue.enqueue(crash(`boom ${i}`));
    expect(sink).toHaveBeenCalledTimes(10);
  });

  it('drops what it holds when telemetry is off, and everything once disabled', () => {
    const queue = new ReportQueue();
    const sink = vi.fn(async () => undefined);
    queue.enqueue(load);
    queue.detach();
    queue.attach(sink);
    expect(sink).not.toHaveBeenCalled();
    queue.disable();
    queue.attach(sink);
    queue.enqueue(load);
    expect(sink).not.toHaveBeenCalled();
  });

  it('bounds what it holds before the server answers', () => {
    const queue = new ReportQueue();
    for (let i = 0; i < 40; i += 1) queue.enqueue({ kind: 'sse_reconnect', count: 1 });
    const sink = vi.fn(async () => undefined);
    queue.attach(sink);
    expect(sink).toHaveBeenCalledTimes(20);
  });

  it('swallows a failed send', async () => {
    const queue = new ReportQueue();
    queue.attach(async () => { throw new Error('offline'); });
    expect(() => queue.enqueue(load)).not.toThrow();
    await Promise.resolve();
  });
});
