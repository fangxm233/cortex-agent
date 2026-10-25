import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_STAMP } from '@/lib/build-info';
import { crashReport, installGlobalErrorCapture, isIgnoredError, reportRenderError } from './crash-capture';
import { telemetryQueue } from './report-queue';

afterEach(() => vi.restoreAllMocks());

describe('crash capture', () => {
  it('builds a crash report from an Error, cut to the wire limits', () => {
    const error = new TypeError('x'.repeat(3_000));
    const report = crashReport('windowError', error);
    expect(report).toMatchObject({ kind: 'crash', crashKind: 'windowError', errorName: 'TypeError', buildStamp: BUILD_STAMP });
    if (report.kind !== 'crash') throw new Error('unreachable');
    expect(report.message).toHaveLength(2_000);
    expect(report.stack.length).toBeLessThanOrEqual(20_000);
    expect(typeof report.uptimeS).toBe('number');
  });

  it('describes a rejection that is not an Error', () => {
    const report = crashReport('unhandledRejection', 'plain reason');
    expect(report).toMatchObject({ errorName: 'NonError:string', message: 'plain reason', stack: '' });
  });

  it('ignores browser noise', () => {
    expect(isIgnoredError('Script error.')).toBe(true);
    expect(isIgnoredError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isIgnoredError('Cannot read properties of undefined')).toBe(false);
  });

  it('feeds window errors and rejections into the queue', () => {
    const enqueue = vi.spyOn(telemetryQueue, 'enqueue').mockImplementation(() => undefined);
    const target = new EventTarget() as unknown as Window;
    const remove = installGlobalErrorCapture(target);
    const error = Object.assign(new Event('error'), { message: 'boom', error: new Error('boom') });
    target.dispatchEvent(error);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('late') }));
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.', error: null }));
    remove();
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'after', error: new Error('after') }));
    expect(enqueue.mock.calls.map(([r]) => r.kind === 'crash' && r.crashKind)).toEqual(['windowError', 'unhandledRejection']);
  });

  it('appends the component stack to a render error', () => {
    const enqueue = vi.spyOn(telemetryQueue, 'enqueue').mockImplementation(() => undefined);
    reportRenderError(new Error('render'), '\n    at Panel\n    at App');
    const report = enqueue.mock.calls[0]![0];
    expect(report.kind === 'crash' && report.stack).toContain('--- component stack ---\n    at Panel');
  });
});
