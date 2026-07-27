// input:  histories, pending data, DEBUG gate and warning env
// output: transcript grouping, interactions, DEBUG and warning tests
// pos:    Authoritative sessions.transcript handler specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSessionsTranscript } from '../../../src/domain/ui-service/query/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { SessionHistory } from '../../../src/store/conversation-history-repo.js';

function makeDeps(history: SessionHistory | null): UiServiceDeps {
  return {
    conversationHistory: { getHistory: async () => history },
  } as unknown as UiServiceDeps;
}

test('sessions.transcript exposes debug metadata and derives large-tool warnings from server env', async (t) => {
  const previous = process.env.DEBUG;
  const previousThreshold = process.env.CORTEX_DEBUG_TOOL_WARNING_CHARS;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
    if (previousThreshold === undefined) delete process.env.CORTEX_DEBUG_TOOL_WARNING_CHARS;
    else process.env.CORTEX_DEBUG_TOOL_WARNING_CHARS = previousThreshold;
  });
  const history: SessionHistory = {
    sessionId: 'sess-debug',
    events: [
      { type: 'user', text: 'visible', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0, debug: { agentMessage: 'system context\nvisible' } },
      { type: 'tool', toolName: 'Bash', toolInput: 'echo …', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0, debug: { toolInput: { command: 'echo full' }, toolResult: { content: 'full\noutput', isError: false } } },
    ],
  } as SessionHistory;

  delete process.env.DEBUG;
  const hidden = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-debug' });
  assert.ok(hidden.turns[0].messages.every((message) => !('debug' in message)), 'disabled responses contain no sensitive debug key');

  process.env.DEBUG = '1';
  process.env.CORTEX_DEBUG_TOOL_WARNING_CHARS = '1000';
  const visible = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-debug' });
  assert.deepEqual(visible.turns[0].messages[0].debug, { agentMessage: 'system context\nvisible' });
  assert.deepEqual(visible.turns[0].messages[1].debug, {
    toolInput: { command: 'echo full' },
    toolResult: { content: 'full\noutput', isError: false },
  });

  process.env.CORTEX_DEBUG_TOOL_WARNING_CHARS = '10';
  const warned = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-debug' });
  assert.deepEqual(warned.turns[0].messages[1].debug, {
    toolInput: { command: 'echo full' },
    toolResult: { content: 'full\noutput', isError: false },
    overCharacterThreshold: true,
  });
  assert.ok(!('overCharacterThreshold' in history.events[1].debug!), 'derived warning is not persisted');
});

test('sessions.transcript groups user/assistant/tool events by turn', async () => {
  const history: SessionHistory = {
    sessionId: 'sess-1',
    events: [
      { type: 'user', text: 'hi', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0 },
      { type: 'assistant', text: 'hello', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0 },
      { type: 'tool', toolName: 'Read', toolInput: 'x.ts', ts: '2026-07-07T00:00:02.000Z', turnIndex: 0 },
      { type: 'user', text: 'again', ts: '2026-07-07T00:00:03.000Z', turnIndex: 1 },
      { type: 'assistant', text: 'sure', ts: '2026-07-07T00:00:04.000Z', turnIndex: 1 },
    ],
  };
  const out = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-1' });

  assert.equal(out.sessionId, 'sess-1');
  assert.equal(out.turns.length, 2);

  assert.equal(out.turns[0].turnIndex, 0);
  assert.equal(out.turns[0].messages.length, 3);
  assert.deepEqual(out.turns[0].messages[0], {
    type: 'user', text: 'hi', toolName: null, toolInput: null, ts: '2026-07-07T00:00:00.000Z', elapsedMs: null,
  });
  assert.deepEqual(out.turns[0].messages[2], {
    type: 'tool', text: null, toolName: 'Read', toolInput: 'x.ts', ts: '2026-07-07T00:00:02.000Z', elapsedMs: 1000,
  });

  assert.equal(out.turns[1].turnIndex, 1);
  assert.equal(out.turns[1].messages.length, 2);
});

test('sessions.transcript exposes an assistant notice level', async () => {
  const history: SessionHistory = {
    sessionId: 'sess-notice',
    events: [
      { type: 'user', text: 'hi', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0 },
      { type: 'assistant', text: 'Heads up', noticeLevel: 'warning', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0 },
    ],
  };

  const out = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-notice' });
  assert.equal(out.turns[0].messages[1].noticeLevel, 'warning');
});

test('sessions.transcript derives per-message elapsedMs from ts deltas (chronological, first=null)', async () => {
  const history: SessionHistory = {
    sessionId: 'sess-2',
    events: [
      { type: 'user', text: 'hi', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0 },
      { type: 'assistant', text: 'thinking', ts: '2026-07-07T00:00:02.500Z', turnIndex: 0 },
      { type: 'user', text: 'again', ts: '2026-07-07T00:00:10.000Z', turnIndex: 1 },
      { type: 'assistant', text: 'done', ts: '2026-07-07T00:00:11.000Z', turnIndex: 1 },
    ],
  };
  const out = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-2' });

  // First message overall has no predecessor.
  assert.equal(out.turns[0].messages[0].elapsedMs, null);
  // Delta from the previous message in the flat chronological stream.
  assert.equal(out.turns[0].messages[1].elapsedMs, 2500);
  // Elapsed spans turn boundaries (previous = last assistant of turn 0).
  assert.equal(out.turns[1].messages[0].elapsedMs, 7500);
  assert.equal(out.turns[1].messages[1].elapsedMs, 1000);
});

test('sessions.transcript elapsedMs is null when a ts is unparseable', async () => {
  const history: SessionHistory = {
    sessionId: 'sess-3',
    events: [
      { type: 'user', text: 'hi', ts: 'not-a-date', turnIndex: 0 },
      { type: 'assistant', text: 'ok', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0 },
    ],
  };
  const out = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-3' });
  assert.equal(out.turns[0].messages[0].elapsedMs, null);
  // Previous ts is unparseable → cannot derive a delta.
  assert.equal(out.turns[0].messages[1].elapsedMs, null);
});

test('sessions.transcript returns empty turns for an absent history', async () => {
  const out = await handleSessionsTranscript(makeDeps(null), { sessionId: 'nope' });
  assert.deepEqual(out, { sessionId: 'nope', turns: [], pendingUserMessages: [] });
});

// ── Interaction entity materialization (web-interactions-redesign plan) ──────

function makeInteractionDeps(history: SessionHistory, pendingIds: string[]): UiServiceDeps {
  return {
    conversationHistory: { getHistory: async () => history },
    isInteractionPending: (id: string) => pendingIds.includes(id),
  } as unknown as UiServiceDeps;
}

const QUESTIONS = [{ question: 'A or B?', header: 'Q', options: [{ label: 'A' }], multiSelect: false }];

test('a live pending interaction materializes with structured detail and status pending', async () => {
  const now = new Date().toISOString();
  const history: SessionHistory = {
    sessionId: 's1',
    events: [
      { type: 'user', text: 'go', ts: now, turnIndex: 0 },
      { type: 'interaction', id: 'req-1', kind: 'ask-user', status: 'pending', payload: { questions: QUESTIONS }, text: 'A or B?', ts: now, turnIndex: 0 },
    ],
  };
  const out = await handleSessionsTranscript(makeInteractionDeps(history, ['req-1']), { sessionId: 's1' });
  const msg = out.turns[0].messages[1];
  assert.equal(msg.type, 'interaction');
  assert.equal(msg.interaction?.id, 'req-1');
  assert.equal(msg.interaction?.kind, 'ask-user');
  assert.equal(msg.interaction?.status, 'pending');
  assert.deepEqual(msg.interaction?.payload.questions, QUESTIONS);
});

test('a pending interaction with no live resolver (server restarted) derives to expired', async () => {
  const now = new Date().toISOString();
  const history: SessionHistory = {
    sessionId: 's2',
    events: [
      { type: 'user', text: 'go', ts: now, turnIndex: 0 },
      { type: 'interaction', id: 'req-2', kind: 'plan-approval', status: 'pending', payload: { planContent: '# P', planFilePath: null }, text: 'Plan', ts: now, turnIndex: 0 },
    ],
  };
  const out = await handleSessionsTranscript(makeInteractionDeps(history, []), { sessionId: 's2' });
  const msg = out.turns[0].messages[1];
  assert.equal(msg.interaction?.status, 'expired');
});

test('a pending interaction older than the TTL derives to expired even when the resolver looks live', async () => {
  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const history: SessionHistory = {
    sessionId: 's3',
    events: [
      { type: 'user', text: 'go', ts: old, turnIndex: 0 },
      { type: 'interaction', id: 'req-3', kind: 'ask-user', status: 'pending', payload: { questions: QUESTIONS }, text: 'A or B?', ts: old, turnIndex: 0 },
    ],
  };
  const out = await handleSessionsTranscript(makeInteractionDeps(history, ['req-3']), { sessionId: 's3' });
  assert.equal(out.turns[0].messages[1].interaction?.status, 'expired');
});

test('a resolved interaction materializes final status + result and never re-derives', async () => {
  const now = new Date().toISOString();
  const history: SessionHistory = {
    sessionId: 's4',
    events: [
      { type: 'user', text: 'go', ts: now, turnIndex: 0 },
      { type: 'interaction', id: 'req-4', kind: 'plan-approval', status: 'approved', payload: { planContent: '# P', planFilePath: 'p.md' }, result: {}, resolvedVia: 'web', text: 'Plan approved', ts: now, turnIndex: 0 },
    ],
  };
  const out = await handleSessionsTranscript(makeInteractionDeps(history, []), { sessionId: 's4' });
  const msg = out.turns[0].messages[1];
  assert.equal(msg.interaction?.status, 'approved');
  assert.equal(msg.subtype, 'plan-approved', 'legacy-compatible subtype derived from kind+status');
  assert.equal(msg.text, 'Plan approved');
});

test('legacy interaction rows (subtype/text, no id) materialize as before with no detail', async () => {
  const now = new Date().toISOString();
  const history: SessionHistory = {
    sessionId: 's5',
    events: [
      { type: 'user', text: 'go', ts: now, turnIndex: 0 },
      { type: 'interaction', subtype: 'ask-user-answered', text: 'Q → A', ts: now, turnIndex: 0 },
    ],
  };
  const out = await handleSessionsTranscript(makeDeps(history), { sessionId: 's5' });
  const msg = out.turns[0].messages[1];
  assert.equal(msg.type, 'interaction');
  assert.equal(msg.subtype, 'ask-user-answered');
  assert.equal(msg.text, 'Q → A');
  assert.equal(msg.interaction, undefined);
});
