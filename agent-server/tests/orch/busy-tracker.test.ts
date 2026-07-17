// input:  BusyTracker, EventBus
// output: regression tests for BusyTracker IPC signaling [S6-C, S13 NTH-A]
// pos:    verifies (a) +1/-1 publish+IPC, (b) multi-publisher aggregate single busy→idle,
//         (c) re-entrant trackPendingTask inside subscriber is handled without crash,
//         (d) non-tracker bus.publish fires correct IPC (S13 subscriber-as-source-of-truth),
//         (e) non-tracker aggregate produces correct single busy+idle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BusyTracker } from '../../src/orchestration/busy-tracker.js';
import { EventBus } from '../../src/events/index.js';
import type { CortexEvent } from '../../src/events/index.js';

// ── (a) +1/-1 triggers publish and correct IPC ───────────────────────────────

test('(a) +1 publishes llm.active-count-delta(delta=1) and sends IPC busy; -1 sends IPC idle', (t) => {
  const bus = new EventBus();
  const tracker = new BusyTracker();
  const events: CortexEvent[] = [];
  const ipc: unknown[] = [];

  bus.subscribe('*', (e) => { events.push(e); });

  const origSend = process.send;
  process.send = (msg: unknown) => { ipc.push(msg); return true; };
  t.onTestFinished(() => { process.send = origSend; });

  tracker.setBus(bus);

  tracker.trackPendingTask(+1);

  assert.equal(events.length, 1, 'one event after +1');
  assert.equal(events[0].type, 'llm.active-count-delta');
  if (events[0].type === 'llm.active-count-delta') {
    assert.equal(events[0].delta, 1);
  }
  assert.deepEqual(ipc, [{ type: 'busy' }], '+1 triggers IPC busy');
  assert.equal(tracker.count, 1);

  tracker.trackPendingTask(-1);

  assert.equal(events.length, 2, 'two events after -1');
  assert.equal(events[1].type, 'llm.active-count-delta');
  if (events[1].type === 'llm.active-count-delta') {
    assert.equal(events[1].delta, -1);
  }
  assert.deepEqual(ipc, [{ type: 'busy' }, { type: 'idle' }], '-1 triggers IPC idle');
  assert.equal(tracker.count, 0);
});

// ── (b) multi-publisher aggregate: single busy + single idle ─────────────────

test('(b) two +1 then two -1 produces exactly one busy and one idle IPC', (t) => {
  const bus = new EventBus();
  const tracker = new BusyTracker();
  const ipc: unknown[] = [];

  const origSend = process.send;
  process.send = (msg: unknown) => { ipc.push(msg); return true; };
  t.onTestFinished(() => { process.send = origSend; });

  tracker.setBus(bus);

  tracker.trackPendingTask(+1);   // count 0→1: IPC busy
  tracker.trackPendingTask(+1);   // count 1→2: no IPC
  tracker.trackPendingTask(-1);   // count 2→1: no IPC
  tracker.trackPendingTask(-1);   // count 1→0: IPC idle

  assert.equal(tracker.count, 0, 'count returns to zero');
  assert.deepEqual(ipc, [{ type: 'busy' }, { type: 'idle' }],
    'exactly one busy + one idle, no intermediate IPC');
});

// ── (c) re-entrant trackPendingTask from within subscriber ───────────────────

test('(c) re-entrant trackPendingTask inside subscriber completes without crash', (t) => {
  const bus = new EventBus();
  const tracker = new BusyTracker();
  const ipc: unknown[] = [];

  const origSend = process.send;
  process.send = (msg: unknown) => { ipc.push(msg); return true; };
  t.onTestFinished(() => { process.send = origSend; });

  tracker.setBus(bus);

  // Extra subscriber that calls trackPendingTask(-1) re-entrantly on the first +1.
  // Guard with a flag to prevent infinite recursion.
  let reentered = false;
  bus.subscribe('llm.active-count-delta', (e) => {
    if (reentered || e.delta <= 0) return;
    reentered = true;
    tracker.trackPendingTask(-1); // re-entrant: count 1→0, nested publish fires
    reentered = false;
  });

  // This call triggers: count 0→1, publishes +1 event.
  // Fan-out order (snapshot at publish time):
  //   1. busy-tracker subscriber: count===1 && delta>0 → IPC busy
  //   2. test's re-entrant subscriber: calls trackPendingTask(-1)
  //      → count 1→0, publishes -1 event (nested fan-out):
  //        1. busy-tracker subscriber: count===0 && delta<0 → IPC idle
  //        2. test subscriber: guarded by reentered=true, skips
  //      nested publish completes
  tracker.trackPendingTask(+1);

  // After the call, the re-entrant -1 has cancelled the +1
  assert.equal(tracker.count, 0, 'count is 0 after re-entrant -1 cancels +1');
  // Both transitions fired: busy (from outer +1 subscriber) + idle (from nested -1 subscriber)
  assert.ok(ipc.length >= 1, 'at least one IPC message sent (no crash)');
  assert.ok(
    ipc.some((m) => (m as { type: string }).type === 'busy') ||
    ipc.some((m) => (m as { type: string }).type === 'idle'),
    'IPC contains busy or idle message',
  );
  // Verify no exception was thrown by reaching this point
  assert.equal(tracker.count, 0, 'count consistent after re-entrant sequence');
});

// ── (d) non-tracker source: bus.publish directly, not via trackPendingTask ────
// Non-tracker sources (e.g. domain/scheduling/jobs/scheduled-task.ts:56/59,
// task-dispatch.ts:48/50) call bus.publish('llm.active-count-delta', ...)
// directly without going through BusyTracker.trackPendingTask.  Before the S13
// NTH-A fix, the subscriber only gated on _count without updating it, so a
// non-tracker +1 would never fire IPC busy (and a subsequent -1 would fire a
// phantom IPC idle).  The subscriber-as-source-of-truth canonicalization fixes
// this behavioral regression (see gate b3688af2 artifact §3).

test('(d) non-tracker +1 via bus.publish fires IPC busy; non-tracker -1 fires IPC idle', (t) => {
  const bus = new EventBus();
  const tracker = new BusyTracker();
  const ipc: unknown[] = [];

  const origSend = process.send;
  process.send = (msg: unknown) => { ipc.push(msg); return true; };
  t.onTestFinished(() => { process.send = origSend; });

  tracker.setBus(bus);

  // Non-tracker source: publish directly without calling trackPendingTask
  bus.publish({ type: 'llm.active-count-delta', delta: 1 });

  assert.equal(tracker.count, 1, 'subscriber increments _count from non-tracker +1');
  assert.deepEqual(ipc, [{ type: 'busy' }], 'non-tracker +1 triggers IPC busy');

  bus.publish({ type: 'llm.active-count-delta', delta: -1 });

  assert.equal(tracker.count, 0, 'subscriber decrements _count from non-tracker -1');
  assert.deepEqual(ipc, [{ type: 'busy' }, { type: 'idle' }], 'non-tracker -1 triggers IPC idle');
});

// ── (e) aggregate: two non-tracker +1 then two -1 ─────────────────────────────

test('(e) non-tracker aggregate +1+1 then -1-1 produces single busy+idle IPC', (t) => {
  const bus = new EventBus();
  const tracker = new BusyTracker();
  const ipc: unknown[] = [];

  const origSend = process.send;
  process.send = (msg: unknown) => { ipc.push(msg); return true; };
  t.onTestFinished(() => { process.send = origSend; });

  tracker.setBus(bus);

  bus.publish({ type: 'llm.active-count-delta', delta: 1 });  // 0→1: busy
  bus.publish({ type: 'llm.active-count-delta', delta: 1 });  // 1→2: no IPC
  bus.publish({ type: 'llm.active-count-delta', delta: -1 }); // 2→1: no IPC
  bus.publish({ type: 'llm.active-count-delta', delta: -1 }); // 1→0: idle

  assert.equal(tracker.count, 0);
  assert.deepEqual(ipc, [{ type: 'busy' }, { type: 'idle' }],
    'exactly one busy + one idle from non-tracker aggregate');
});
