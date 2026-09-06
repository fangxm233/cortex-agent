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

// CC ≥ 2026-08-24 emits task_started{is_backgrounded:false} + task_notification for every
// FOREGROUND Bash call (captured 2026-09-05 23-56-35: 60 such pairs in one turn). Those
// complete as the turn's own tool_result and never re-invoke the model.
test('BgTaskTracker: foreground task (is_backgrounded:false) never counts as running nor arms', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_started', task_id: 'fg1', task_type: 'local_bash', is_backgrounded: false });
  assert.equal(t.pendingCount, 0, 'foreground work is not background work');
  t.observe({ type: 'system', subtype: 'task_updated', task_id: 'fg1', patch: { status: 'completed' } });
  assert.equal(t.undeliveredCount, 0, 'foreground completion owes no notification');
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'fg1', status: 'completed', summary: 'ls' });
  assert.equal(t.continuationArmed, false, 'delivered as tool_result — no continuation turn follows');
  assert.equal(t.hasPending(), false);
});

test('BgTaskTracker: task_started with is_backgrounded:true behaves as background', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_started', task_id: 'bg1', is_backgrounded: true });
  assert.equal(t.pendingCount, 1);
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed' });
  assert.equal(t.pendingCount, 0);
  assert.equal(t.continuationArmed, true);
});

// The CLI auto-backgrounds a long foreground command: task_updated{patch:{is_backgrounded:true}}
// (captured: bayw7ch6d "Typecheck agent-server" 2026-09-05 23-56-35 lines 249-277).
test('BgTaskTracker: task_updated{is_backgrounded:true} promotes a foreground task to background', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_started', task_id: 'auto1', is_backgrounded: false });
  t.observe({ type: 'system', subtype: 'task_updated', task_id: 'auto1', patch: { is_backgrounded: true } });
  assert.equal(t.pendingCount, 1, 'now running in the background');
  t.observe({ type: 'system', subtype: 'task_updated', task_id: 'auto1', patch: { status: 'failed', end_time: 1 } });
  assert.equal(t.undeliveredCount, 1);
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'auto1', status: 'failed' });
  assert.equal(t.undeliveredCount, 0);
  assert.equal(t.continuationArmed, true, 'a background completion re-invokes the model');
});

// On `--resume` the CLI reports background work orphaned by the previous process as
// task_notification{status:'stopped'} for tasks this process never started, then closes that
// notification turn with a 0-turn result and folds the notice into the next user turn
// (captured 2026-09-06 11-50-50). Nothing will re-invoke the model on its own.
test('BgTaskTracker: orphan notification (unknown task, status stopped) does not arm', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'bk8lu504b', status: 'stopped', summary: 'Orphaned by a previous Claude Code process exit and reported in an aggregate summary.' });
  assert.equal(t.continuationArmed, false);
  assert.equal(t.hasPending(), false);
});

test('BgTaskTracker: unknown task with a completed notification still arms (legacy safety)', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'late', status: 'completed' });
  assert.equal(t.continuationArmed, true);
});

// A notification the CLI folds into the ACTIVE turn (tool-result boundary) is echoed back as a
// `--replay-user-messages` user line; that notification will not open a turn of its own.
test('BgTaskTracker: replay echo of a folded <task-notification> un-arms that task only', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_started', task_id: 'a1' });
  t.observe({ type: 'system', subtype: 'task_started', task_id: 'a2' });
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'a2', status: 'completed' });
  assert.equal(t.continuationArmed, true);
  t.observe({ type: 'user', isReplay: true, message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' } });
  assert.equal(t.continuationArmed, true, 'a2 still owes a turn');
  t.observe({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>a2</task-id>\n</task-notification>' }] } });
  assert.equal(t.continuationArmed, false, 'both folded — no continuation turn is coming');
});

test('BgTaskTracker: non-notification replay echoes and non-replay user lines are ignored', () => {
  const t = new BgTaskTracker();
  t.observe({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
  t.observe({ type: 'user', isReplay: true, message: { role: 'user', content: 'hello' } });
  t.observe({ type: 'user', message: { role: 'user', content: '<task-notification><task-id>a1</task-id></task-notification>' } });
  assert.equal(t.continuationArmed, true);
});

test('isContinuationResult: true only for result with origin.kind=task-notification', () => {
  assert.equal(isContinuationResult(RESULT_CONTINUATION), true);
  assert.equal(isContinuationResult(RESULT_FIRST), false);
  assert.equal(isContinuationResult({ type: 'assistant', origin: { kind: 'task-notification' } }), false);
  assert.equal(isContinuationResult(null), false);
});
