import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PlanApprovals } from '../../src/orchestration/interactions/plan-approvals.js';
import { EventBus } from '../../src/events/index.js';
import type { CortexEvent } from '../../src/events/index.js';

function collectEvents(bus: EventBus): CortexEvent[] {
  const events: CortexEvent[] = [];
  bus.subscribe('*', (e) => { events.push(e); });
  return events;
}

test('register + lookup + resolve roundtrip publishes plan.approved', () => {
  const bus = new EventBus();
  const approvals = new PlanApprovals(bus);
  approvals.register('req-1', { channel: 'C123' });

  assert.equal(approvals.has('req-1'), true);
  const looked = approvals.lookup('req-1');
  assert.equal(looked?.channel, 'C123');
  assert.equal(approvals.has('req-1'), true, 'lookup must not remove');

  const events = collectEvents(bus);
  const resolved = approvals.resolve('req-1');

  assert.equal(resolved?.channel, 'C123');
  assert.equal(approvals.has('req-1'), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'plan.approved');
  if (events[0].type === 'plan.approved') {
    assert.equal(events[0].channel, 'C123');
  }
});

test('pending plans are keyed by requestId; resolving one leaves the others', () => {
  const bus = new EventBus();
  const approvals = new PlanApprovals(bus);

  approvals.register('req-a', { channel: 'C-a' });
  approvals.register('req-b', { channel: 'C-b' });

  assert.equal(approvals.lookup('req-a')?.channel, 'C-a');
  assert.equal(approvals.lookup('req-b')?.channel, 'C-b');

  // Resolve one: only that requestId is removed.
  const events = collectEvents(bus);
  approvals.resolve('req-a');
  assert.equal(approvals.has('req-a'), false);
  assert.equal(approvals.has('req-b'), true);
  assert.equal(events.filter(e => e.type === 'plan.approved').length, 1);
});

test('reject removes entry but does NOT publish plan.approved', () => {
  const bus = new EventBus();
  const approvals = new PlanApprovals(bus);
  approvals.register('req-2', { channel: 'C123' });

  const events = collectEvents(bus);
  const rejected = approvals.reject('req-2');

  assert.equal(rejected?.channel, 'C123');
  assert.equal(approvals.has('req-2'), false);
  assert.equal(events.length, 0, 'reject must not publish plan.approved');
});

test('clearByChannel removes all entries for the given channel only', () => {
  const approvals = new PlanApprovals();
  approvals.register('a', { channel: 'C1' });
  approvals.register('b', { channel: 'C1' });
  approvals.register('c', { channel: 'C2' });

  const removed = approvals.clearByChannel('C1');

  assert.equal(removed, 2);
  assert.equal(approvals.has('a'), false);
  assert.equal(approvals.has('b'), false);
  assert.equal(approvals.has('c'), true, 'C2 entry must remain');
});

test('resolve/reject of unknown requestId returns undefined and emits nothing', () => {
  const bus = new EventBus();
  const approvals = new PlanApprovals(bus);
  const events = collectEvents(bus);

  assert.equal(approvals.resolve('missing'), undefined);
  assert.equal(approvals.reject('missing'), undefined);
  assert.equal(events.length, 0);
});
