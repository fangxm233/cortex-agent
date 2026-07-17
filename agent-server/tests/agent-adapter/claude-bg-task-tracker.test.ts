// input:  Node test runner + agent-adapter/claude/bg-task-tracker module
// output: BgTaskTracker running/undelivered counts + continuation-detection spec
// pos:    CC backend background-task continuation tracking unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { BgTaskTracker, isContinuationResult, routeLine } from '../../src/agent-adapter/claude/bg-task-tracker.js';

// Real stream-json event shapes captured from `claude -p --input-format stream-json`
// when an agent launches a `run_in_background` Bash task (see /tmp/bg-capture.mjs).
const TASK_STARTED = { type: 'system', subtype: 'task_started', task_id: 'b6vp8rywx', task_type: 'local_bash', description: 'sleep' };
const TASK_UPDATED_DONE = { type: 'system', subtype: 'task_updated', task_id: 'b6vp8rywx', patch: { status: 'completed', end_time: 1781924971128 } };
const TASK_UPDATED_KILLED = { type: 'system', subtype: 'task_updated', task_id: 'b6vp8rywx', patch: { status: 'killed' } };
const TASK_NOTIFICATION = { type: 'system', subtype: 'task_notification', task_id: 'b6vp8rywx', status: 'completed', summary: 'done' };
const RESULT_FIRST = { type: 'result', subtype: 'success', is_error: false };
const RESULT_CONTINUATION = { type: 'result', subtype: 'success', is_error: false, origin: { kind: 'task-notification' } };

test('BgTaskTracker: task_started increments running (pendingCount) by task_id', () => {
  const t = new BgTaskTracker();
  assert.equal(t.pendingCount, 0);
  assert.equal(t.undeliveredCount, 0);
  t.observe(TASK_STARTED);
  assert.equal(t.pendingCount, 1);
  assert.equal(t.hasPending(), true);
});

test('BgTaskTracker: still running at first result, fully cleared after completion signals', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  t.observe(RESULT_FIRST);
  // First result fires while the background task is still running.
  assert.equal(t.pendingCount, 1, 'task still running at RESULT #1');
  t.observe(TASK_UPDATED_DONE);
  t.observe(TASK_NOTIFICATION);
  assert.equal(t.pendingCount, 0);
  assert.equal(t.undeliveredCount, 0, 'task fully cleared after completion + notification');
});

// 2026-07-10 investigation: on CC versions ≤ 07-05 a task that completes while its owning
// turn is still active gets task_updated{completed} and NEVER a task_notification (11 cases
// verified across 07-01..07-05 server logs; e.g. b594u926t completed 03:43:40, session lived
// to 04:15:28 incl. one more turn — zero notifications all day). pendingCount must therefore
// treat updated{completed} as "work done" (no longer running) while undeliveredCount keeps
// the task visible until the notification arrives (or a lifecycle watchdog gives up on it).
test('BgTaskTracker: task_updated{completed} moves the task running → undelivered', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  t.observe(TASK_UPDATED_DONE);
  assert.equal(t.pendingCount, 0, 'work finished — no longer counted as running');
  assert.equal(t.undeliveredCount, 1, 'notification not yet delivered');
  assert.equal(t.hasPending(), true, 'session must stay alive while a delivery may still come');
  t.observe(TASK_NOTIFICATION);
  assert.equal(t.undeliveredCount, 0, 'task_notification clears undelivered');
  assert.equal(t.hasPending(), false);
  // A duplicate notification for the same id must not drive any count negative.
  t.observe(TASK_NOTIFICATION);
  assert.equal(t.pendingCount, 0);
  assert.equal(t.undeliveredCount, 0);
});

test('BgTaskTracker: task_updated{failed} also counts as work done (undelivered)', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  t.observe({ type: 'system', subtype: 'task_updated', task_id: 'b6vp8rywx', patch: { status: 'failed' } });
  assert.equal(t.pendingCount, 0);
  assert.equal(t.undeliveredCount, 1);
});

// TaskStop-killed tasks NEVER get a task_notification (verified 07-04 abdfc0b1 status=killed,
// zero notifications). They must clear entirely, or the turn would wait forever.
test('BgTaskTracker: task_updated{killed} clears the task entirely (no notification will come)', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  t.observe(TASK_UPDATED_KILLED);
  assert.equal(t.pendingCount, 0);
  assert.equal(t.undeliveredCount, 0);
  assert.equal(t.hasPending(), false);
});

// Premature-seal protection (the reason task_updated used to be a no-op): with 5 parallel
// tasks the CLI can emit task_updated{completed} SECONDS before the matching notification.
// The tasks leave `running` but stay visible via `undeliveredCount` — a result snapshotting
// in the gap still sees remaining work, so the turn is not sealed early.
test('BgTaskTracker: undelivered keeps tasks visible until the LAST notification', () => {
  const t = new BgTaskTracker();
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];
  for (const id of ids) t.observe({ type: 'system', subtype: 'task_started', task_id: id });
  assert.equal(t.pendingCount, 5);

  for (const id of ids) {
    t.observe({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'completed' } });
  }
  assert.equal(t.pendingCount, 0, 'no task is still running');
  assert.equal(t.undeliveredCount, 5, 'all five notifications still undelivered');
  assert.equal(t.hasPending(), true);

  for (let i = 0; i < ids.length; i++) {
    t.observe({ type: 'system', subtype: 'task_notification', task_id: ids[i], status: 'completed' });
    assert.equal(t.undeliveredCount, ids.length - (i + 1));
  }
  assert.equal(t.hasPending(), false, 'cleared only after the final notification');
});

test('BgTaskTracker: task_notification without a prior task_updated clears running directly', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  t.observe(TASK_NOTIFICATION);
  assert.equal(t.pendingCount, 0);
  assert.equal(t.undeliveredCount, 0);
});

test('BgTaskTracker: task_updated with non-terminal status keeps the task running', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  t.observe({ type: 'system', subtype: 'task_updated', task_id: 'b6vp8rywx', patch: { status: 'running' } });
  assert.equal(t.pendingCount, 1);
  assert.equal(t.undeliveredCount, 0);
  // Patch without a status field (e.g. output updates) is also a no-op.
  t.observe({ type: 'system', subtype: 'task_updated', task_id: 'b6vp8rywx', patch: { output: 'partial' } });
  assert.equal(t.pendingCount, 1);
});

test('BgTaskTracker: task_notification arms continuation; disarm clears it', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  assert.equal(t.continuationArmed, false);
  t.observe(TASK_NOTIFICATION);
  assert.equal(t.continuationArmed, true);
  t.disarmContinuation();
  assert.equal(t.continuationArmed, false);
});

test('BgTaskTracker: multiple concurrent tasks counted independently', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_started', task_id: 'a1' });
  t.observe({ type: 'system', subtype: 'task_started', task_id: 'a2' });
  assert.equal(t.pendingCount, 2);
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
  assert.equal(t.pendingCount, 1);
  assert.equal(t.hasPending(), true);
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'a2', status: 'completed' });
  assert.equal(t.pendingCount, 0);
});

test('BgTaskTracker: ignores non-system events and malformed payloads', () => {
  const t = new BgTaskTracker();
  t.observe(null);
  t.observe(undefined);
  t.observe({ type: 'assistant' });
  t.observe({ type: 'system', subtype: 'init', model: 'x' });
  t.observe({ type: 'system', subtype: 'task_started' }); // no task_id
  assert.equal(t.pendingCount, 0);
  assert.equal(t.undeliveredCount, 0);
});

test('routeLine: any line during an active turn routes normally', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_NOTIFICATION); // armed, but a turn is active
  assert.equal(routeLine(t, { type: 'assistant' }, true), 'normal');
  assert.equal(routeLine(t, RESULT_FIRST, true), 'normal');
});

test('routeLine: assistant with no active turn + armed → open-continuation', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_STARTED);
  t.observe(TASK_NOTIFICATION);
  assert.equal(routeLine(t, { type: 'assistant', message: {} }, false), 'open-continuation');
});

test('routeLine: assistant with no active turn but NOT armed → ignore (preserve current drop behavior)', () => {
  const t = new BgTaskTracker();
  assert.equal(routeLine(t, { type: 'assistant', message: {} }, false), 'ignore');
});

test('routeLine: non-assistant lines with no active turn → ignore', () => {
  const t = new BgTaskTracker();
  t.observe(TASK_NOTIFICATION);
  assert.equal(routeLine(t, { type: 'system', subtype: 'init' }, false), 'ignore');
  assert.equal(routeLine(t, RESULT_CONTINUATION, false), 'ignore');
});

test('isContinuationResult: true only for result with origin.kind=task-notification', () => {
  assert.equal(isContinuationResult(RESULT_CONTINUATION), true);
  assert.equal(isContinuationResult(RESULT_FIRST), false);
  assert.equal(isContinuationResult({ type: 'assistant', origin: { kind: 'task-notification' } }), false);
  assert.equal(isContinuationResult(null), false);
});
