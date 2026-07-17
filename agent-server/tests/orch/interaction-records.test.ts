// input:  InteractionRecords + EventBus + fake conversation-history
// output: regression tests for the persistent interaction entity service
//         (web-interactions-redesign plan: create/resolve lifecycle, idempotency,
//         pending index as liveness, channel scoping, session.interaction events)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionRecords } from '../../src/orchestration/interactions/interaction-records.js';
import { EventBus } from '../../src/events/event-bus.js';
import type { CortexEvent } from '../../src/events/event-types.js';

interface AppendedCreated { sessionId: string; args: any }
interface AppendedResolved { sessionId: string; args: any }

function makeFakeHistory() {
  const created: AppendedCreated[] = [];
  const resolved: AppendedResolved[] = [];
  return {
    created,
    resolved,
    history: {
      appendInteractionCreated: async (sessionId: string, args: any) => { created.push({ sessionId, args }); },
      appendInteractionResolved: async (sessionId: string, args: any) => { resolved.push({ sessionId, args }); },
    },
  };
}

function collectInteractionEvents(bus: EventBus): Extract<CortexEvent, { type: 'session.interaction' }>[] {
  const events: Extract<CortexEvent, { type: 'session.interaction' }>[] = [];
  bus.subscribe('session.interaction', (e) => { events.push(e as any); });
  return events;
}

const PLAN_ARGS = {
  id: 'req-p1',
  sessionId: 'sess-1',
  channel: 'web:sess-1',
  kind: 'plan-approval' as const,
  payload: { planContent: '# Title\nstep', planFilePath: 'plan/x.md' },
};

test('create persists a created record and publishes session.interaction pending', async () => {
  const bus = new EventBus();
  const fake = makeFakeHistory();
  const recs = new InteractionRecords();
  recs.init({ history: fake.history as any, bus });
  const events = collectInteractionEvents(bus);

  await recs.create(PLAN_ARGS);

  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].sessionId, 'sess-1');
  assert.equal(fake.created[0].args.id, 'req-p1');
  assert.equal(fake.created[0].args.kind, 'plan-approval');
  assert.deepEqual(fake.created[0].args.payload, PLAN_ARGS.payload);

  assert.equal(events.length, 1);
  assert.equal(events[0].interactionId, 'req-p1');
  assert.equal(events[0].sessionId, 'sess-1');
  assert.equal(events[0].kind, 'plan-approval');
  assert.equal(events[0].status, 'pending');

  assert.equal(recs.isPending('req-p1'), true);
  assert.equal(recs.get('req-p1')?.status, 'pending');
});

test('resolve persists a resolved record, publishes the final status, and is idempotent', async () => {
  const bus = new EventBus();
  const fake = makeFakeHistory();
  const recs = new InteractionRecords();
  recs.init({ history: fake.history as any, bus });
  await recs.create(PLAN_ARGS);
  const events = collectInteractionEvents(bus);

  const first = await recs.resolve({ id: 'req-p1', status: 'approved', resolvedVia: 'web' });
  assert.equal(first, 'resolved');
  assert.equal(fake.resolved.length, 1);
  assert.equal(fake.resolved[0].args.status, 'approved');
  assert.equal(fake.resolved[0].args.resolvedVia, 'web');
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'approved');
  assert.equal(recs.isPending('req-p1'), false);
  assert.equal(recs.get('req-p1')?.status, 'approved');

  // Second resolve is a no-op with a distinct outcome (first-writer-wins).
  const second = await recs.resolve({ id: 'req-p1', status: 'rejected', resolvedVia: 'web' });
  assert.equal(second, 'already-resolved');
  assert.equal(fake.resolved.length, 1, 'no second record appended');
  assert.equal(events.length, 1, 'no second event published');
});

test('resolve of an unknown id returns unknown (restart case: index empty)', async () => {
  const bus = new EventBus();
  const fake = makeFakeHistory();
  const recs = new InteractionRecords();
  recs.init({ history: fake.history as any, bus });

  const out = await recs.resolve({ id: 'ghost', status: 'approved', resolvedVia: 'web' });
  assert.equal(out, 'unknown');
  assert.equal(fake.resolved.length, 0);
});

test('getPendingByChannel returns only pending entries for the channel with payload', async () => {
  const bus = new EventBus();
  const fake = makeFakeHistory();
  const recs = new InteractionRecords();
  recs.init({ history: fake.history as any, bus });

  await recs.create(PLAN_ARGS);
  await recs.create({
    id: 'req-q1', sessionId: 'sess-1', channel: 'web:sess-1', kind: 'ask-user',
    payload: { questions: [{ question: 'A or B?', header: 'Q', options: [{ label: 'A' }], multiSelect: false }] },
  });
  await recs.create({
    id: 'req-other', sessionId: 'sess-2', channel: 'web:sess-2', kind: 'plan-approval',
    payload: { planContent: 'x', planFilePath: null },
  });
  await recs.resolve({ id: 'req-p1', status: 'approved', resolvedVia: 'web' });

  const pend = recs.getPendingByChannel('web:sess-1');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].id, 'req-q1');
  assert.equal(pend[0].kind, 'ask-user');
  assert.equal(pend[0].payload.questions?.[0].question, 'A or B?');
});

test('resolvePendingByChannel cancels all pending interactions on a channel', async () => {
  const bus = new EventBus();
  const fake = makeFakeHistory();
  const recs = new InteractionRecords();
  recs.init({ history: fake.history as any, bus });

  await recs.create(PLAN_ARGS);
  await recs.create({ id: 'req-q1', sessionId: 'sess-1', channel: 'web:sess-1', kind: 'ask-user', payload: { questions: [] } });
  await recs.create({ id: 'req-other', sessionId: 'sess-2', channel: 'web:sess-2', kind: 'plan-approval', payload: {} });
  const events = collectInteractionEvents(bus);

  const n = await recs.resolvePendingByChannel('web:sess-1', 'cancelled', 'command');
  assert.equal(n, 2);
  assert.equal(recs.isPending('req-p1'), false);
  assert.equal(recs.isPending('req-q1'), false);
  assert.equal(recs.isPending('req-other'), true, 'other channel untouched');
  assert.equal(events.filter(e => e.status === 'cancelled').length, 2);
  assert.equal(fake.resolved.length, 2);
});

test('create without init does not throw (fail-soft) and get returns null', async () => {
  const recs = new InteractionRecords();
  await recs.create(PLAN_ARGS);
  assert.equal(recs.get('req-p1'), null);
});
