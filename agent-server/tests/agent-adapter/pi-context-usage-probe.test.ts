// input:  PIContextUsageProbe with captured RPC writes and terminal events
// output: live sampling throttle plus terminal correlation/timeout regressions
// pos:    Unit specification for PI's optional end-of-turn context probe
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import {
  PI_CONTEXT_USAGE_SAMPLE_MS,
  PI_CONTEXT_USAGE_TIMEOUT_MS,
  PIContextUsageProbe,
} from '../../src/agent-adapter/pi/session-support.js';

test('PIContextUsageProbe throttles live snapshots and permits another after response + interval', (t) => {
  vi.useFakeTimers();
  const writes: Record<string, unknown>[] = [];
  const probe = new PIContextUsageProbe((command) => writes.push(command), () => {});
  t.onTestFinished(() => { probe.close(); vi.useRealTimers(); });

  probe.requestSnapshot();
  probe.requestSnapshot();
  assert.equal(writes.length, 1, 'one live request may be in flight');
  assert.equal(writes[0].type, 'get_session_stats');

  probe.observe({ type: 'response', id: writes[0].id, command: 'get_session_stats', success: true });
  probe.requestSnapshot();
  assert.equal(writes.length, 1, 'response clears in-flight state but the sample interval still applies');

  vi.advanceTimersByTime(PI_CONTEXT_USAGE_SAMPLE_MS);
  probe.requestSnapshot();
  assert.equal(writes.length, 2);
  assert.notEqual(writes[1].id, writes[0].id);
});

test('PIContextUsageProbe live timeout restores sampling without emitting a terminal', (t) => {
  vi.useFakeTimers();
  const writes: Record<string, unknown>[] = [];
  const emitted: NormalizedEvent[] = [];
  const probe = new PIContextUsageProbe((command) => writes.push(command), (event) => emitted.push(event));
  t.onTestFinished(() => { probe.close(); vi.useRealTimers(); });

  probe.requestSnapshot();
  vi.advanceTimersByTime(PI_CONTEXT_USAGE_SAMPLE_MS);
  probe.requestSnapshot();

  assert.equal(writes.length, 2, 'the timed-out live request cannot block later samples');
  assert.deepEqual(emitted, []);
});

test('PIContextUsageProbe keeps live and final requests independently correlated', (t) => {
  const writes: Record<string, unknown>[] = [];
  const emitted: NormalizedEvent[] = [];
  const probe = new PIContextUsageProbe((command) => writes.push(command), (event) => emitted.push(event));
  t.onTestFinished(() => probe.close());
  const terminal: NormalizedEvent = { type: 'turn_complete', numTurns: 2, totalCostUsd: 0.01 };

  probe.requestSnapshot();
  probe.deferTerminal(terminal);
  assert.equal(writes.length, 2);

  probe.observe({ type: 'response', id: writes[0].id, command: 'get_session_stats', success: true });
  assert.deepEqual(emitted, [], 'live response cannot release the final terminal');
  probe.observe({ type: 'response', id: writes[1].id, command: 'get_session_stats', success: true });
  assert.deepEqual(emitted, [terminal]);
});

test('PIContextUsageProbe correlates one stats request and releases terminal only for its response', (t) => {
  const writes: Record<string, unknown>[] = [];
  const emitted: NormalizedEvent[] = [];
  const probe = new PIContextUsageProbe((command) => writes.push(command), (event) => emitted.push(event));
  t.onTestFinished(() => probe.close());
  const terminal: NormalizedEvent = { type: 'turn_complete', numTurns: 2, totalCostUsd: 0.01 };

  probe.deferTerminal(terminal);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, 'get_session_stats');
  assert.equal(typeof writes[0].id, 'string');
  assert.deepEqual(emitted, [], 'terminal waits while the optional stats response is in flight');

  probe.observe({ type: 'response', id: 'unrelated', command: 'get_session_stats', success: true });
  assert.deepEqual(emitted, [], 'an unrelated response cannot release the terminal');

  probe.observe({ type: 'response', id: writes[0].id, command: 'get_session_stats', success: true });
  assert.deepEqual(emitted, [terminal]);
});

test('PIContextUsageProbe releases terminal after the bounded timeout', (t) => {
  vi.useFakeTimers();
  const emitted: NormalizedEvent[] = [];
  const probe = new PIContextUsageProbe(() => {}, (event) => emitted.push(event));
  t.onTestFinished(() => { probe.close(); vi.useRealTimers(); });
  const terminal: NormalizedEvent = { type: 'turn_complete', numTurns: 1, totalCostUsd: null };

  probe.deferTerminal(terminal);
  vi.advanceTimersByTime(PI_CONTEXT_USAGE_TIMEOUT_MS - 1);
  assert.deepEqual(emitted, []);
  vi.advanceTimersByTime(1);
  assert.deepEqual(emitted, [terminal]);
});

test('PIContextUsageProbe degrades immediately if the RPC write fails and close cancels a pending probe', (t) => {
  const terminal: NormalizedEvent = { type: 'turn_complete', numTurns: 1, totalCostUsd: null };
  const failed: NormalizedEvent[] = [];
  const broken = new PIContextUsageProbe(() => { throw new Error('stdin closed'); }, (event) => failed.push(event));
  broken.deferTerminal(terminal);
  assert.deepEqual(failed, [terminal]);

  vi.useFakeTimers();
  const cancelled: NormalizedEvent[] = [];
  const pending = new PIContextUsageProbe(() => {}, (event) => cancelled.push(event));
  t.onTestFinished(() => { pending.close(); vi.useRealTimers(); });
  pending.deferTerminal(terminal);
  pending.close();
  vi.advanceTimersByTime(PI_CONTEXT_USAGE_TIMEOUT_MS);
  assert.deepEqual(cancelled, [], 'closing the session cannot emit into a closed event queue');
});
