// input:  Node test runner + dispatch-utils processAbortOutcome
// output: aborted-thread → block-task escalation tests
// pos:    Verify worker [ABORT] escalation path (DR-0014 §8 Phase C — also fixes the
//         pre-existing bug where aborted dispatch threads were finalized as successes)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { processAbortOutcome, formatWorkerAbortReason } from '../src/domain/tasks/dispatch-utils.js';

function makeDeps(status: string, abortReason: string | null = null) {
  const blocked: Array<{ taskId: string; reason: string }> = [];
  return {
    blocked,
    deps: {
      getThread: (_id: string) => ({ status, abortReason }) as any,
      block: async (taskId: string, reason: string) => { blocked.push({ taskId, reason }); return { success: true, message: 'ok' }; },
    },
  };
}

test('processAbortOutcome blocks the task with the abort reason', async () => {
  const { blocked, deps } = makeDeps('aborted', 'too-big — needs 3 independent units');
  const r = await processAbortOutcome({ threadId: 'thr_x', taskId: 't111', project: 'proj' }, deps);
  assert.equal(r.handled, true);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].taskId, 't111');
  assert.match(blocked[0].reason, /worker-abort/);
  assert.match(blocked[0].reason, /too-big/);
  assert.match(r.note || '', /abort/i);
});

test('processAbortOutcome handles a missing abort reason', async () => {
  const { blocked, deps } = makeDeps('aborted', null);
  const r = await processAbortOutcome({ threadId: 'thr_x', taskId: 't222', project: 'proj' }, deps);
  assert.equal(r.handled, true);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /worker-abort/);
});

test('processAbortOutcome is a no-op for non-aborted threads', async () => {
  for (const status of ['completed', 'failed', 'waiting', 'running']) {
    const { blocked, deps } = makeDeps(status);
    const r = await processAbortOutcome({ threadId: 'thr_x', taskId: 't333', project: 'proj' }, deps);
    assert.equal(r.handled, false, `status=${status}`);
    assert.equal(blocked.length, 0);
  }
});

test('processAbortOutcome ignores aborted threads without an associated task', async () => {
  const { blocked, deps } = makeDeps('aborted', 'reason');
  const r = await processAbortOutcome({ threadId: 'thr_x', taskId: null, project: 'proj' }, deps);
  assert.equal(r.handled, false);
  assert.equal(blocked.length, 0);
});

test('processAbortOutcome surfaces block failures', async () => {
  const { deps } = makeDeps('aborted', 'r');
  deps.block = async () => ({ success: false, message: 'lock held' });
  const r = await processAbortOutcome({ threadId: 'thr_x', taskId: 't444', project: 'proj' }, deps);
  assert.equal(r.handled, true);
  assert.match(r.error || '', /lock held/);
});

test('processAbortOutcome truncates very long abort reasons in the block reason', async () => {
  const { blocked, deps } = makeDeps('aborted', 'x'.repeat(500));
  await processAbortOutcome({ threadId: 'thr_x', taskId: 't555', project: 'proj' }, deps);
  assert.ok(blocked[0].reason.length <= 300, `reason too long: ${blocked[0].reason.length}`);
});

// --- formatWorkerAbortReason (DR-0015: shared by runner onAbort + processAbortOutcome) ---

test('formatWorkerAbortReason prefixes worker-abort and defaults a null reason', () => {
  assert.equal(formatWorkerAbortReason(null), 'worker-abort: no reason given');
  assert.equal(formatWorkerAbortReason(''), 'worker-abort: no reason given');
});

test('formatWorkerAbortReason collapses internal whitespace/newlines', () => {
  assert.equal(formatWorkerAbortReason('too-big\n  needs   split'), 'worker-abort: too-big needs split');
});

test('formatWorkerAbortReason caps total length at 280', () => {
  assert.ok(formatWorkerAbortReason('x'.repeat(500)).length <= 280);
});
