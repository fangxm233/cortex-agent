import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/event-bus.js';
import type { HistoryEvent } from '../../src/store/conversation-history-repo.js';
import { InteractionRecords } from '../../src/orchestration/interactions/interaction-records.js';
import { answerRestoredAsk, type RestoredAskDeps } from '../../src/orchestration/interactions/restored-ask.js';

const QUESTIONS = [{ question: 'Which DB?', header: 'DB', options: [{ label: 'sqlite' }], multiSelect: false }];

function askEvent(over: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    type: 'interaction', id: 'req-1', kind: 'ask-user', status: 'pending',
    payload: { questions: QUESTIONS, blocking: false }, text: 'Which DB?', ts: '2026-10-01T00:00:00.000Z', turnIndex: 0,
    ...over,
  } as HistoryEvent;
}

/** A fresh (just-restarted) server: empty interaction index, history on disk. */
function setup(events: HistoryEvent[]) {
  const resolved: any[] = [];
  const delivered: { channel: string; text: string }[] = [];
  const records = new InteractionRecords();
  records.init({
    history: {
      appendInteractionCreated: async () => { throw new Error('a restored ask is never re-created'); },
      appendInteractionResolved: async (sessionId: string, args: any) => { resolved.push({ sessionId, ...args }); },
    } as any,
    bus: new EventBus(),
  });
  const deps: RestoredAskDeps = {
    readEvents: async () => events,
    channelOf: async (sessionId) => `web:${sessionId}`,
    interactionRecords: records,
    deliver: (channel, text) => { delivered.push({ channel, text }); },
  };
  return { deps, records, resolved, delivered };
}

test('a non-blocking ask from before a restart is answered from history and delivered as a user message', async () => {
  const { deps, records, resolved, delivered } = setup([askEvent()]);

  const outcome = await answerRestoredAsk('sess-1', 'req-1', { 'Which DB?': 'sqlite' }, 'web', deps);

  assert.equal(outcome, 'resolved');
  assert.equal(records.get('req-1')?.status, 'answered');
  assert.deepEqual(resolved.map((r) => [r.sessionId, r.id, r.status, r.resolvedVia]), [['sess-1', 'req-1', 'answered', 'web']]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'web:sess-1');
  assert.ok(delivered[0].text.includes('Which DB?') && delivered[0].text.includes('sqlite'), delivered[0].text);
});

test('two clients answering the same restored ask: the first wins, the second is already-resolved', async () => {
  const { deps, delivered } = setup([askEvent()]);

  const [a, b] = await Promise.all([
    answerRestoredAsk('sess-1', 'req-1', { 'Which DB?': 'sqlite' }, 'web', deps),
    answerRestoredAsk('sess-1', 'req-1', { 'Which DB?': 'pg' }, 'web', deps),
  ]);

  assert.deepEqual([a, b].sort(), ['already-resolved', 'resolved']);
  assert.equal(delivered.length, 1);
});

test('a blocking ask, an unknown id, or an already-answered ask is not revived', async () => {
  const blocking = setup([askEvent({ payload: { questions: QUESTIONS } })]);
  assert.equal(await answerRestoredAsk('sess-1', 'req-1', { 'Which DB?': 'sqlite' }, 'web', blocking.deps), 'not-found');
  assert.equal(await answerRestoredAsk('sess-1', 'req-x', { 'Which DB?': 'sqlite' }, 'web', blocking.deps), 'not-found');

  const answered = setup([askEvent({ status: 'answered' })]);
  assert.equal(await answerRestoredAsk('sess-1', 'req-1', { 'Which DB?': 'sqlite' }, 'web', answered.deps), 'already-resolved');

  assert.equal(blocking.delivered.length + answered.delivered.length, 0);
});
