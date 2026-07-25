// input:  vitest + orchestration/routing/commands/cancel (cancelBgHolds seams) + bgHeldSessions
// output: Stop-during-background-hold spec — kill the pooled process, then seal the hold
// pos:    regression for "Stop button does nothing while the session shows Background"
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// The bug: holdWebForBg is installed AFTER teardownExecution removed the execution from
// runningExecutions, so the channel-keyed cancel path found zero executions, returned 0, and the
// click resolved ok while nothing happened. cancelBgHolds is the branch that closes the gap.

import './../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

import { cancelBgHolds } from '../../src/orchestration/routing/commands/cancel.js';
import { bgHeldSessions } from '../../src/core/bg-held-sessions.js';

beforeEach(() => bgHeldSessions.clear());

test('no hold on the channel → 0, and nothing is killed', () => {
  const kills: string[] = [];
  const n = cancelBgHolds('web:idle', {
    heldSessions: () => [],
    killPooled: (c) => { kills.push(c); return true; },
    abortHold: () => true,
  });
  assert.equal(n, 0);
  assert.deepEqual(kills, [], 'a channel with no hold must not have its pooled session killed');
});

test('held session → kills the pooled process, then aborts the hold', () => {
  const order: string[] = [];
  const n = cancelBgHolds('web:s1', {
    heldSessions: () => ['sess-1'],
    killPooled: (c) => { order.push(`kill:${c}`); return true; },
    abortHold: (s) => { order.push(`abort:${s}`); return true; },
  });
  assert.equal(n, 1, 'reported as cancelled so the UI gets cancelled:true');
  assert.deepEqual(order, ['kill:web:s1', 'abort:sess-1'],
    'kill the background work first, then seal the UI');
});

test('multiple held sessions on one channel → one kill, every hold aborted', () => {
  const kills: string[] = [];
  const aborted: string[] = [];
  const n = cancelBgHolds('web:s1', {
    heldSessions: () => ['a', 'b'],
    killPooled: (c) => { kills.push(c); return true; },
    abortHold: (s) => { aborted.push(s); return true; },
  });
  assert.equal(n, 2);
  assert.deepEqual(kills, ['web:s1'], 'the pooled session is per-channel — killed once');
  assert.deepEqual(aborted, ['a', 'b']);
});

test('a kill failure still seals the hold (never leave the UI stuck running)', () => {
  const aborted: string[] = [];
  const n = cancelBgHolds('web:s1', {
    heldSessions: () => ['sess-1'],
    killPooled: () => { throw new Error('process already gone'); },
    abortHold: (s) => { aborted.push(s); return true; },
  });
  assert.equal(n, 1);
  assert.deepEqual(aborted, ['sess-1']);
});

test('end-to-end against the real registry: held session is found by channel and sealed', () => {
  let sealed = 0;
  bgHeldSessions.onSessionStatus({ sessionId: 'sess-1', channel: 'web:live', running: true, backgroundRunning: true });
  bgHeldSessions.setAbort('sess-1', () => {
    sealed++;
    // The real seal publishes running:false, which flows back through the bus into the registry.
    bgHeldSessions.onSessionStatus({ sessionId: 'sess-1', channel: 'web:live', running: false, backgroundRunning: false });
  });

  const n = cancelBgHolds('web:live', { killPooled: () => true });
  assert.equal(n, 1);
  assert.equal(sealed, 1);
  assert.equal(bgHeldSessions.has('sess-1'), false, 'hold cleared');
  assert.equal(cancelBgHolds('web:live', { killPooled: () => true }), 0, 'second Stop finds nothing');
});
