// input:  vitest, cancel seams, foreground session start, runRegistry
// output: Stop / foreground-supersession background-hold regressions + subagent-run cancellation
// pos:    Background-hold cancellation and busy-release regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// The bug: holdWebForBg is installed AFTER teardownExecution removed the execution from
// runningExecutions, so the channel-keyed cancel path found zero executions, returned 0, and the
// click resolved ok while nothing happened. cancelBgHolds is the branch that closes the gap.

import './../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

import { cancelBgHolds, cancelSubagentRuns } from '../../src/orchestration/routing/commands/cancel.js';
import type { RunningExecution } from '../../src/core/run-registry.js';
import { beginForegroundSession } from '../../src/orchestration/agent-runner.js';
import { runRegistry } from '../../src/core/run-registry.js';

beforeEach(() => runRegistry.clear());

test('no hold on the channel → 0, and nothing is killed', () => {
  const kills: string[] = [];
  const n = cancelBgHolds('web:idle', {
    heldSessions: () => [],
    killPooled: (c) => { kills.push(c); return true; },
    stopHolds: () => true,
  });
  assert.equal(n, 0);
  assert.deepEqual(kills, [], 'a channel with no hold must not have its pooled session killed');
});

test('held session → kills the pooled process, then aborts the hold', () => {
  const order: string[] = [];
  const n = cancelBgHolds('web:s1', {
    heldSessions: () => ['sess-1'],
    killPooled: (c) => { order.push(`kill:${c}`); return true; },
    stopHolds: (s) => { order.push(`abort:${s}`); return true; },
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
    stopHolds: (s) => { aborted.push(s); return true; },
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
    stopHolds: (s) => { aborted.push(s); return true; },
  });
  assert.equal(n, 1);
  assert.deepEqual(aborted, ['sess-1']);
});

test('end-to-end against the real registry: held session is found by channel and sealed', () => {
  let sealed = 0;
  runRegistry.onSessionStatus({ sessionId: 'sess-1', channel: 'web:live', running: true, backgroundRunning: true });
  const seal = (): void => {
    sealed++;
    // The real seal publishes running:false, which flows back through the bus into the registry.
    runRegistry.onSessionStatus({ sessionId: 'sess-1', channel: 'web:live', running: false, backgroundRunning: false });
  };
  runRegistry.setHoldHandles('sess-1', 'web-bg-hold', { onSuperseded: seal, onStop: seal });

  const n = cancelBgHolds('web:live', { killPooled: () => true });
  assert.equal(n, 1);
  assert.equal(sealed, 1);
  assert.equal(runRegistry.has('sess-1'), false, 'hold cleared');
  assert.equal(cancelBgHolds('web:live', { killPooled: () => true }), 0, 'second Stop finds nothing');
});

test('new foreground turn releases the old hold before publishing running:true', () => {
  const order: string[] = [];
  runRegistry.onSessionStatus({
    sessionId: 'sess-1', channel: 'web:live', running: true, backgroundRunning: true,
  });
  const seal = (): void => {
    order.push('release-old-hold');
    runRegistry.onSessionStatus({
      sessionId: 'sess-1', channel: 'web:live', running: false, backgroundRunning: false,
    });
  };
  runRegistry.setHoldHandles('sess-1', 'web-bg-hold', { onSuperseded: seal, onStop: seal });

  beginForegroundSession('sess-1', 'web:live', {
    supersedeHolds: (sessionId) => runRegistry.supersedeHolds(sessionId),
    publishRunning: () => order.push('publish-running'),
  });

  assert.deepEqual(order, ['release-old-hold', 'publish-running']);
  assert.equal(runRegistry.has('sess-1'), false, 'superseded hold no longer owns busy state');

  beginForegroundSession('sess-1', 'web:live', {
    supersedeHolds: (sessionId) => runRegistry.supersedeHolds(sessionId),
    publishRunning: () => order.push('publish-running-again'),
  });
  assert.deepEqual(order, ['release-old-hold', 'publish-running', 'publish-running-again'],
    'the old hold releases exactly once');
});

// --- cancelSubagentRuns: Stop must also reach delegated `agent` runs ---------------------------
//
// Subagent runs are keyed by Cortex session, this path by channel, so the bridge is the executions'
// track ids plus the channel's bg holds. Everything below drives that bridge through injected
// seams — the registry itself is covered by tests/subagent-background.test.ts.

/** A live execution, reduced to the two fields the session bridge reads. */
function exec(fields: Partial<RunningExecution>): RunningExecution {
  return {
    threadId: null, channel: 'web:live', registryKey: 'k', agentSlotId: null, executionId: null,
    kind: null, kill: () => true, startTime: 0, backend: 'claude', ...fields,
  } as RunningExecution;
}

test('stops the runs of every session on the channel — executions and holds together', () => {
  const asked: string[] = [];
  const n = cancelSubagentRuns('web:live', {
    liveExecutions: () => [exec({ trackSessionId: 'sess-fg' })],
    heldSessions: () => ['sess-bg'],
    stopForSession: (s) => { asked.push(s); return 1; },
  });
  assert.deepEqual(asked.sort(), ['sess-bg', 'sess-fg'],
    'a foreground turn and a background hold can own runs at the same time');
  assert.equal(n, 2, 'reports what the registry stopped, for the log');
});

test('one session reached once, however many executions it has live', () => {
  const asked: string[] = [];
  cancelSubagentRuns('web:live', {
    liveExecutions: () => [
      exec({ trackSessionId: 'sess-1', registryKey: 'a' }),
      exec({ trackSessionId: 'sess-1', registryKey: 'b' }),
    ],
    heldSessions: () => ['sess-1'],
    stopForSession: (s) => { asked.push(s); return 0; },
  });
  assert.deepEqual(asked, ['sess-1'], 'deduped — a thread step beside its parent is still one session');
});

test('falls back to the legacy session id when there is no track id', () => {
  const asked: string[] = [];
  cancelSubagentRuns('web:live', {
    liveExecutions: () => [exec({ trackSessionId: null, sessionId: 'legacy-1' })],
    heldSessions: () => [],
    stopForSession: (s) => { asked.push(s); return 0; },
  });
  assert.deepEqual(asked, ['legacy-1']);
});

test('an execution with no session at all is skipped, not asked about as ""', () => {
  const asked: string[] = [];
  const n = cancelSubagentRuns('web:live', {
    liveExecutions: () => [exec({ trackSessionId: null, sessionId: null })],
    heldSessions: () => [],
    stopForSession: (s) => { asked.push(s); return 1; },
  });
  assert.deepEqual(asked, []);
  assert.equal(n, 0);
});

test('a throwing registry does not abort the sweep — the other sessions still get stopped', () => {
  const asked: string[] = [];
  const n = cancelSubagentRuns('web:live', {
    liveExecutions: () => [exec({ trackSessionId: 'sess-bad' }), exec({ trackSessionId: 'sess-ok', registryKey: 'b' })],
    heldSessions: () => [],
    stopForSession: (s) => {
      asked.push(s);
      if (s === 'sess-bad') throw new Error('registry exploded');
      return 1;
    },
  });
  assert.deepEqual(asked, ['sess-bad', 'sess-ok']);
  assert.equal(n, 1, 'the surviving stop is still counted');
});

test('Stop on a channel with nothing running never touches the registry', () => {
  let calls = 0;
  const n = cancelSubagentRuns('web:idle', {
    liveExecutions: () => [],
    heldSessions: () => [],
    stopForSession: () => { calls++; return 0; },
  });
  assert.equal(n, 0);
  assert.equal(calls, 0);
});
