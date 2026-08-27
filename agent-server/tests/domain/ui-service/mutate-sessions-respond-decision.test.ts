// input:  handleRespondDecision + fake deps (history, bus, send seam)
// output: unit tests for decision responses — approve records only, explain/revise
//         record AND forward, idempotent approve, and the validation guards
// pos:    guards the sessions.respondDecision mutation (send_decision cards)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleRespondDecision } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function makeDeps(opts: { actions?: { action: 'approve' | 'explain' | 'revise'; message?: string; ts: string }[] } = {}) {
  const appended: any[] = [];
  const published: any[] = [];
  const sent: any[] = [];
  const deps = {
    sessionStore: {
      getById: async (id: string) => (id === 'sess-1' ? { sessionId: 'sess-1', channel: 'web:sess-1' } : null),
    },
    conversationHistory: {
      getHistory: async () => ({
        sessionId: 'sess-1',
        events: [{
          type: 'assistant', text: '', ts: 't0', turnIndex: 0,
          decisions: [{
            id: 'd-1', title: 'Use SQLite', decision: 'x', context: 'y', reasoning: 'z',
            actions: opts.actions ?? [],
          }],
        }],
      }),
      appendDecisionAction: async (sid: string, o: any) => { appended.push({ sid, ...o }); },
    },
    bus: { publish: (e: any) => { published.push(e); } },
    sendSessionMessage: (o: any) => { sent.push(o); },
  } as unknown as UiServiceDeps;
  return { deps, appended, published, sent };
}

test('approve records the action and never sends anything to the agent', async () => {
  const h = makeDeps();
  const res = await handleRespondDecision(h.deps, { sessionId: 'sess-1', decisionId: 'd-1', action: 'approve' });
  assert.deepEqual(res, { ok: true, data: { outcome: 'recorded' } });
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].action, 'approve');
  assert.equal(h.appended[0].message, undefined, 'approve carries no message');
  assert.equal(h.sent.length, 0, 'nothing reaches the agent');
  assert.equal(h.published[0].type, 'session.decision');
  assert.equal(h.published[0].decisionId, 'd-1');
});

test('a repeated approve is idempotent, not an error', async () => {
  const h = makeDeps({ actions: [{ action: 'approve', ts: 't1' }] });
  const res = await handleRespondDecision(h.deps, { sessionId: 'sess-1', decisionId: 'd-1', action: 'approve' });
  assert.deepEqual(res, { ok: true, data: { outcome: 'already-approved' } });
  assert.equal(h.appended.length, 0, 'no duplicate action line');
  assert.equal(h.published.length, 0);
});

test('explain records the action AND forwards the composed message as a chat send', async () => {
  const h = makeDeps();
  const res = await handleRespondDecision(h.deps, {
    sessionId: 'sess-1', decisionId: 'd-1', action: 'explain', message: '请解释决策「Use SQLite」：why?',
  });
  assert.deepEqual(res, { ok: true, data: { outcome: 'recorded' } });
  assert.equal(h.appended[0].message, '请解释决策「Use SQLite」：why?');
  assert.deepEqual(h.sent, [{ sessionId: 'sess-1', channel: 'web:sess-1', text: '请解释决策「Use SQLite」：why?' }]);
});

test('explain/revise without a message → invalid-args; nothing is recorded', async () => {
  const h = makeDeps();
  for (const action of ['explain', 'revise'] as const) {
    const res = await handleRespondDecision(h.deps, { sessionId: 'sess-1', decisionId: 'd-1', action, message: '  ' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'invalid-args');
  }
  assert.equal(h.appended.length, 0);
  assert.equal(h.sent.length, 0);
});

test('unknown decision id → not-found; unknown session → not-found', async () => {
  const h = makeDeps();
  const badDecision = await handleRespondDecision(h.deps, { sessionId: 'sess-1', decisionId: 'nope', action: 'approve' });
  assert.equal(badDecision.ok, false);
  if (!badDecision.ok) assert.equal(badDecision.code, 'not-found');
  const badSession = await handleRespondDecision(h.deps, { sessionId: 'other', decisionId: 'd-1', action: 'approve' });
  assert.equal(badSession.ok, false);
  if (!badSession.ok) assert.equal(badSession.code, 'not-found');
});

test('an unwired appendDecisionAction dep → not-available', async () => {
  const h = makeDeps();
  (h.deps.conversationHistory as any).appendDecisionAction = undefined;
  const res = await handleRespondDecision(h.deps, { sessionId: 'sess-1', decisionId: 'd-1', action: 'approve' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-available');
});
