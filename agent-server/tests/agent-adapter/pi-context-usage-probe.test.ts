// input:  PIContextUsageProbe with captured RPC writes and terminal events
// output: correlation, ordering, timeout, and cancellation regressions
// pos:    Unit specification for PI's optional end-of-turn context probe
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import {
  PI_CONTEXT_USAGE_TIMEOUT_MS,
  PIContextUsageProbe,
} from '../../src/agent-adapter/pi/session-support.js';

test('PIContextUsageProbe correlates one stats request and releases terminal only for its response', () => {
  const writes: Record<string, unknown>[] = [];
  const emitted: NormalizedEvent[] = [];
  const probe = new PIContextUsageProbe((command) => writes.push(command), (event) => emitted.push(event));
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
  probe.close();
});

test('PIContextUsageProbe releases terminal after the bounded timeout', () => {
  vi.useFakeTimers();
  const emitted: NormalizedEvent[] = [];
  const probe = new PIContextUsageProbe(() => {}, (event) => emitted.push(event));
  const terminal: NormalizedEvent = { type: 'turn_complete', numTurns: 1, totalCostUsd: null };

  probe.deferTerminal(terminal);
  vi.advanceTimersByTime(PI_CONTEXT_USAGE_TIMEOUT_MS - 1);
  assert.deepEqual(emitted, []);
  vi.advanceTimersByTime(1);
  assert.deepEqual(emitted, [terminal]);

  probe.close();
  vi.useRealTimers();
});

test('PIContextUsageProbe degrades immediately if the RPC write fails and close cancels a pending probe', () => {
  const terminal: NormalizedEvent = { type: 'turn_complete', numTurns: 1, totalCostUsd: null };
  const failed: NormalizedEvent[] = [];
  const broken = new PIContextUsageProbe(() => { throw new Error('stdin closed'); }, (event) => failed.push(event));
  broken.deferTerminal(terminal);
  assert.deepEqual(failed, [terminal]);

  vi.useFakeTimers();
  const cancelled: NormalizedEvent[] = [];
  const pending = new PIContextUsageProbe(() => {}, (event) => cancelled.push(event));
  pending.deferTerminal(terminal);
  pending.close();
  vi.advanceTimersByTime(PI_CONTEXT_USAGE_TIMEOUT_MS);
  assert.deepEqual(cancelled, [], 'closing the session cannot emit into a closed event queue');
  vi.useRealTimers();
});
