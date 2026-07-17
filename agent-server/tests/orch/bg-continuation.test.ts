// input:  Node test runner + orchestration/bg-continuation builder
// output: buildContinuationSink dispatch spec (merge text / waiting vs complete)
// pos:    CC background-task continuation orchestration unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { buildContinuationSink, isBgContinuationEnabled, isInteractiveChannel, isWebChannel, shouldHoldForBg, shouldHoldWebForBg } from '../../src/orchestration/bg-continuation.js';

function makeStream() {
  const emitted: string[] = [];
  return { emitted, stream: { emitText: (t: string) => emitted.push(t) } as any };
}

test('buildContinuationSink: assistant text is appended to the same output stream (merge)', () => {
  const { emitted, stream } = makeStream();
  const sink = buildContinuationSink({ stream, onWaiting: () => {}, onComplete: () => {}, onRateLimited: () => {} });
  sink.onAssistantText('background result: DONE');
  assert.deepEqual(emitted, ['background result: DONE']);
});

test('buildContinuationSink: result with 0 pending → onComplete (seal)', () => {
  const { stream } = makeStream();
  let completed: any = null;
  let waited = -1;
  const sink = buildContinuationSink({ stream, onWaiting: (n) => { waited = n; }, onComplete: (r) => { completed = r; }, onRateLimited: () => {} });
  sink.onResult({ pendingBackgroundTasks: 0, total_cost_usd: 0.01 } as any);
  assert.ok(completed, 'onComplete fired');
  assert.equal(waited, -1, 'onWaiting not fired');
});

test('buildContinuationSink: result with >0 pending → onWaiting (chained background tasks)', () => {
  const { stream } = makeStream();
  let completed = false;
  let waited = -1;
  const sink = buildContinuationSink({ stream, onWaiting: (n) => { waited = n; }, onComplete: () => { completed = true; }, onRateLimited: () => {} });
  sink.onResult({ pendingBackgroundTasks: 2 } as any);
  assert.equal(waited, 2, 'onWaiting fired with remaining count');
  assert.equal(completed, false, 'onComplete not fired while tasks remain');
});

test('buildContinuationSink: missing pendingBackgroundTasks treated as 0 → onComplete', () => {
  const { stream } = makeStream();
  let completed = false;
  const sink = buildContinuationSink({ stream, onWaiting: () => {}, onComplete: () => { completed = true; }, onRateLimited: () => {} });
  sink.onResult({} as any);
  assert.equal(completed, true);
});

test('isBgContinuationEnabled: default ON, opt-out via CORTEX_BG_CONTINUATION=0/false', () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    assert.equal(isBgContinuationEnabled(), true, 'enabled by default when unset');
    process.env.CORTEX_BG_CONTINUATION = '0';
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "0"');
    process.env.CORTEX_BG_CONTINUATION = 'false';
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "false"');
    process.env.CORTEX_BG_CONTINUATION = 'off';
    assert.equal(isBgContinuationEnabled(), false, 'disabled by "off"');
    process.env.CORTEX_BG_CONTINUATION = '1';
    assert.equal(isBgContinuationEnabled(), true, 'explicitly enabled');
    process.env.CORTEX_BG_CONTINUATION = 'true';
    assert.equal(isBgContinuationEnabled(), true);
    process.env.CORTEX_BG_CONTINUATION = '';
    assert.equal(isBgContinuationEnabled(), true, 'empty string is not an opt-out');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
  }
});

test('buildContinuationSink: onToolUse is forwarded to the sink when provided', () => {
  const { stream } = makeStream();
  const toolCalls: Array<{ name: string; input: any }> = [];
  const sink = buildContinuationSink({
    stream,
    onToolUse: (name, input) => { toolCalls.push({ name, input }); },
    onWaiting: () => {},
    onComplete: () => {},
    onRateLimited: () => {},
  });
  assert.ok(sink.onToolUse, 'onToolUse is set on the sink');
  sink.onToolUse!('Bash', { command: 'echo hi' });
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'Bash');
});

test('buildContinuationSink: onToolUse is undefined when not provided', () => {
  const { stream } = makeStream();
  const sink = buildContinuationSink({
    stream,
    onWaiting: () => {},
    onComplete: () => {},
    onRateLimited: () => {},
  });
  assert.equal(sink.onToolUse, undefined, 'onToolUse is undefined when not passed');
});

test('buildContinuationSink: rateLimited result → onRateLimited (not onComplete/onWaiting)', () => {
  const { stream } = makeStream();
  let limited: any = null;
  let completed = false;
  let waited = -1;
  const sink = buildContinuationSink({
    stream,
    onWaiting: (n) => { waited = n; },
    onComplete: () => { completed = true; },
    onRateLimited: (r) => { limited = r; },
  });
  sink.onResult({ rateLimited: true, pendingBackgroundTasks: 0, total_cost_usd: 0.01 } as any);
  assert.ok(limited, 'onRateLimited fired');
  assert.equal(completed, false, 'onComplete not fired for rate-limited result');
  assert.equal(waited, -1, 'onWaiting not fired for rate-limited result');
});

test('buildContinuationSink: rateLimited + pending > 0 → onRateLimited (takes priority)', () => {
  const { stream } = makeStream();
  let limited: any = null;
  let waited = -1;
  const sink = buildContinuationSink({
    stream,
    onWaiting: (n) => { waited = n; },
    onComplete: () => {},
    onRateLimited: (r) => { limited = r; },
  });
  sink.onResult({ rateLimited: true, pendingBackgroundTasks: 3 } as any);
  assert.ok(limited, 'onRateLimited fired even with pending tasks');
  assert.equal(waited, -1, 'onWaiting not fired — rate-limited takes priority over waiting');
});

// F2 routing (2026-07-10): a synthetic interrupted result (process died during the waiting
// window) must seal via onInterrupted, never as a normal "done".
test('buildContinuationSink: backgroundInterrupted → onInterrupted (not onComplete/onWaiting)', () => {
  const { stream } = makeStream();
  let interrupted: any = null;
  let completed = false;
  let waited = -1;
  const sink = buildContinuationSink({
    stream,
    onWaiting: (n) => { waited = n; },
    onComplete: () => { completed = true; },
    onRateLimited: () => {},
    onInterrupted: (r) => { interrupted = r; },
  });
  sink.onResult({ backgroundInterrupted: true, pendingBackgroundTasks: 0 } as any);
  assert.ok(interrupted, 'onInterrupted fired');
  assert.equal(completed, false);
  assert.equal(waited, -1);
});

test('buildContinuationSink: backgroundInterrupted falls back to onComplete when onInterrupted absent', () => {
  const { stream } = makeStream();
  let completed = false;
  const sink = buildContinuationSink({ stream, onWaiting: () => {}, onComplete: () => { completed = true; }, onRateLimited: () => {} });
  sink.onResult({ backgroundInterrupted: true } as any);
  assert.equal(completed, true, 'legacy callers without onInterrupted still seal');
});

// F5 routing (2026-07-10): work-done-but-unnotified tasks keep the turn in waiting (with a
// grace watchdog upstream), reported alongside truly-running ones with the split detail.
test('buildContinuationSink: undelivered-only result → onWaiting with combined count + split', () => {
  const { stream } = makeStream();
  let waited = -1;
  let split: any = null;
  const sink = buildContinuationSink({
    stream,
    onWaiting: (n, s) => { waited = n; split = s; },
    onComplete: () => {},
    onRateLimited: () => {},
  });
  sink.onResult({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 2 } as any);
  assert.equal(waited, 2, 'undelivered completions still count as remaining');
  assert.deepEqual(split, { running: 0, undelivered: 2 });
});

test('buildContinuationSink: running + undelivered are summed for the waiting count', () => {
  const { stream } = makeStream();
  let waited = -1;
  let split: any = null;
  const sink = buildContinuationSink({
    stream,
    onWaiting: (n, s) => { waited = n; split = s; },
    onComplete: () => {},
    onRateLimited: () => {},
  });
  sink.onResult({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 1 } as any);
  assert.equal(waited, 2);
  assert.deepEqual(split, { running: 1, undelivered: 1 });
});

test('shouldHoldForBg: hold gates — remaining count, rate limit, channel scope, sink capability, feature flag', () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    const base = { pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0, rateLimited: false };
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', true), true, 'running task holds');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 } as any, 'slack:D1', true), true, 'undelivered completion holds (grace watchdog upstream)');
    assert.equal(shouldHoldForBg({ ...base, pendingBackgroundTasks: 0 } as any, 'slack:D1', true), false, 'nothing remaining → no hold');
    assert.equal(shouldHoldForBg({ ...base, rateLimited: true } as any, 'slack:D1', true), false, 'rate-limited turn never holds');
    assert.equal(shouldHoldForBg(base as any, 'thread-abc', true), false, 'non-interactive channel never holds');
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', false), false, 'no sink capability → no hold');
    assert.equal(shouldHoldForBg(null, 'slack:D1', true), false, 'null result → no hold');
    process.env.CORTEX_BG_CONTINUATION = '0';
    assert.equal(shouldHoldForBg(base as any, 'slack:D1', true), false, 'feature flag off → no hold');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
  }
});

test('isInteractiveChannel: only slack/feishu interactive conduits, not thread/dispatch/web', () => {
  assert.equal(isInteractiveChannel('slack:D123'), true);
  assert.equal(isInteractiveChannel('feishu:oc_abc'), true);
  assert.equal(isInteractiveChannel('thread-abc123'), false);
  assert.equal(isInteractiveChannel('dispatch:task-1'), false);
  assert.equal(isInteractiveChannel('web:cortex-abcd'), false, 'web is NOT slack/feishu — held separately');
  assert.equal(isInteractiveChannel(''), false);
});

test('isWebChannel: only the web: conduit', () => {
  assert.equal(isWebChannel('web:cortex-abcd'), true);
  assert.equal(isWebChannel('slack:D123'), false);
  assert.equal(isWebChannel('feishu:oc_abc'), false);
  assert.equal(isWebChannel('thread-abc123'), false);
  assert.equal(isWebChannel(''), false);
});

test('shouldHoldWebForBg: hold gates mirror shouldHoldForBg but scoped to web:', () => {
  const prev = process.env.CORTEX_BG_CONTINUATION;
  try {
    delete process.env.CORTEX_BG_CONTINUATION;
    const base = { pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0, rateLimited: false };
    assert.equal(shouldHoldWebForBg(base as any, 'web:cortex-abcd', true), true, 'running task on web holds');
    assert.equal(shouldHoldWebForBg({ ...base, pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 } as any, 'web:cortex-abcd', true), true, 'undelivered completion holds');
    assert.equal(shouldHoldWebForBg({ ...base, pendingBackgroundTasks: 0 } as any, 'web:cortex-abcd', true), false, 'nothing remaining → no hold');
    assert.equal(shouldHoldWebForBg({ ...base, rateLimited: true } as any, 'web:cortex-abcd', true), false, 'rate-limited turn never holds');
    assert.equal(shouldHoldWebForBg(base as any, 'slack:D1', true), false, 'slack channel is NOT the web hold');
    assert.equal(shouldHoldWebForBg(base as any, 'web:cortex-abcd', false), false, 'no sink capability → no hold');
    assert.equal(shouldHoldWebForBg(null, 'web:cortex-abcd', true), false, 'null result → no hold');
    process.env.CORTEX_BG_CONTINUATION = '0';
    assert.equal(shouldHoldWebForBg(base as any, 'web:cortex-abcd', true), false, 'feature flag off → no hold');
  } finally {
    if (prev === undefined) delete process.env.CORTEX_BG_CONTINUATION;
    else process.env.CORTEX_BG_CONTINUATION = prev;
  }
});
