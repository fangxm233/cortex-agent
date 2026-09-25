import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  handleSessionsDebugDetails,
  handleSessionsTranscript,
  handleSessionsSubagentTranscript,
} from '../../../src/domain/ui-service/query/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { SessionHistory } from '../../../src/store/conversation-history-repo.js';

function makeDeps(history: SessionHistory | null): UiServiceDeps {
  return {
    conversationHistory: { getHistory: async () => history },
  } as unknown as UiServiceDeps;
}

test('sessions.transcript exposes debug metadata and forwards the folded large-tool warning', async (t) => {
  const previous = process.env.DEBUG;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
  });
  const makeHistory = (debug: Record<string, unknown>): SessionHistory => ({
    sessionId: 'sess-debug',
    events: [
      { type: 'user', text: 'visible', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0, debug: { agentMessage: 'system context\nvisible' } },
      { type: 'tool', toolName: 'Bash', toolInput: 'echo …', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0, debug },
    ],
  } as SessionHistory);
  const payload = { toolRef: 'toolu_1', toolInput: { command: 'echo full' }, toolResult: { content: 'full\noutput', isError: false } };

  delete process.env.DEBUG;
  const hidden = await handleSessionsTranscript(makeDeps(makeHistory(payload)), { sessionId: 'sess-debug' });
  assert.ok(hidden.turns[0].messages.every((message) => !('debug' in message)), 'disabled responses contain no sensitive debug key');

  process.env.DEBUG = '1';
  const visible = await handleSessionsTranscript(makeDeps(makeHistory(payload)), { sessionId: 'sess-debug' });
  assert.deepEqual(visible.turns[0].messages[0].debug, { agentMessage: 'system context\nvisible' });
  assert.deepEqual(visible.turns[0].messages[1].debug, { toolRef: 'toolu_1' }, 'the full payload stays behind the on-demand fetch');

  // The size verdict is stamped by the fold, from the row's own bytes. The query forwards it and
  // never re-weighs the parsed input — that measurement was 4.65% of the server's CPU.
  const warnedHistory = makeHistory({ ...payload, overCharacterThreshold: true });
  const warned = await handleSessionsTranscript(makeDeps(warnedHistory), { sessionId: 'sess-debug' });
  assert.deepEqual(warned.turns[0].messages[1].debug, {
    toolRef: 'toolu_1', overCharacterThreshold: true,
  });
});

test('sessions.transcript reports the system origin on user rows and nowhere else', async () => {
  const history: SessionHistory = {
    sessionId: 'sess-origin',
    events: [
      { type: 'user', text: 'go', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0 },
      { type: 'assistant', text: 'ok', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0 },
      {
        type: 'user', text: '[Task done] #ab12', ts: '2026-07-07T00:00:02.000Z', turnIndex: 1,
        systemOrigin: 'task-callback',
      },
    ],
  } as SessionHistory;

  const transcript = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-origin' });
  const [human, assistant] = transcript.turns[0].messages;
  assert.equal('systemOrigin' in human, false, 'a typed turn carries no tag');
  assert.equal('systemOrigin' in assistant, false, 'the field is user-only');
  assert.equal(transcript.turns[1].messages[0].systemOrigin, 'task-callback');
});

test('sessions.debugDetails fetches one full tool payload only while DEBUG is enabled', async (t) => {
  const previous = process.env.DEBUG;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
  });
  const details = {
    toolRef: 'toolu_1', toolInput: { command: 'echo full' },
    toolResult: { content: 'full output', isError: false },
  };
  const deps = {
    conversationHistory: {
      getHistory: async () => null,
      getToolDebugDetails: async () => details,
    },
  } as unknown as UiServiceDeps;

  delete process.env.DEBUG;
  assert.equal(await handleSessionsDebugDetails(deps, { sessionId: 's', ref: 'toolu_1' }), null);
  process.env.DEBUG = '1';
  assert.deepEqual(
    await handleSessionsDebugDetails(deps, { sessionId: 's', ref: 'toolu_1' }),
    details,
  );
});

test('sessions.transcript groups user/assistant/tool events by turn', async () => {
  const history: SessionHistory = {
    sessionId: 'sess-1',
    events: [
      { type: 'user', text: 'hi', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0 },
      { type: 'assistant', text: 'hello', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0 },
      { type: 'tool', toolName: 'remote_read', toolInput: 'x.ts', toolDevice: 'hub', ts: '2026-07-07T00:00:02.000Z', turnIndex: 0 },
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
    type: 'tool', text: null, toolName: 'remote_read', toolInput: 'x.ts', toolDevice: 'hub',
    ts: '2026-07-07T00:00:02.000Z', elapsedMs: 1000,
  });

  assert.equal(out.turns[1].turnIndex, 1);
  assert.equal(out.turns[1].messages.length, 2);
});

test('sessions.transcript exposes complete subagent spawn metadata outside DEBUG', async () => {
  const subagentSpawns = [{
    id: 'toolu-agent#0', type: 'explore', description: 'Inspect renderers',
    prompt: 'First line.\n\nSecond line remains complete.', requestedModel: 'model-y',
  }];
  const history: SessionHistory = {
    sessionId: 'sess-subagent',
    events: [
      { type: 'user', text: 'go', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0 },
      { type: 'tool', toolName: 'agent', toolInput: 'Inspect renderers', subagentSpawns, ts: '2026-07-07T00:00:01.000Z', turnIndex: 0 },
    ],
  };

  const out = await handleSessionsTranscript(makeDeps(history), { sessionId: 'sess-subagent' });
  assert.deepEqual(out.turns[0].messages[1].subagentSpawns, subagentSpawns);
  assert.equal(out.turns[0].messages[1].debug, undefined);
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

test('sessions.transcript stays full by default and compact opt-in always returns subagent summaries', async () => {
  const fullHistory: SessionHistory = {
    sessionId: 'sess-compact-query',
    events: [
      { type: 'user', text: 'go', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0 },
      { type: 'tool', toolName: 'agent', toolInput: 'Inspect renderers', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0, subagentSpawns: [{ id: 'child-1', type: 'explore', description: 'Inspect renderers', prompt: 'Inspect renderers thoroughly.' }] },
      { type: 'assistant', text: 'child note', ts: '2026-07-07T00:00:02.000Z', turnIndex: 0, subagentId: 'child-1' },
      { type: 'assistant', text: 'main reply', ts: '2026-07-07T00:00:03.000Z', turnIndex: 0 },
    ],
  };
  const compactHistory = {
    sessionId: 'sess-compact-query',
    events: [
      { type: 'user', text: 'go', ts: '2026-07-07T00:00:00.000Z', turnIndex: 0, elapsedMs: null },
      { type: 'tool', toolName: 'agent', toolInput: 'Inspect renderers', ts: '2026-07-07T00:00:01.000Z', turnIndex: 0, elapsedMs: 1000, subagentSpawns: [{ id: 'child-1', type: 'explore', description: 'Inspect renderers', prompt: 'Inspect renderers thoroughly.' }] },
      { type: 'assistant', text: 'main reply', ts: '2026-07-07T00:00:03.000Z', turnIndex: 0, elapsedMs: 1000 },
    ],
    committedSourceIds: [],
    subagentSummaries: [{ id: 'child-1', type: 'explore', description: 'Inspect renderers', toolCount: 0, hasDetails: true, structurallyOpen: false }],
  };
  const deps = {
    conversationHistory: {
      getHistory: async () => fullHistory,
      getCompactHistory: async () => compactHistory,
    },
    pendingInjections: { listBySession: async () => [] },
  } as unknown as UiServiceDeps;

  const full = await handleSessionsTranscript(deps, { sessionId: 'sess-compact-query' });
  assert.equal(full.subagentSummaries, undefined);
  assert.equal(full.turns[0].messages.length, 4);

  const compact = await handleSessionsTranscript(deps, { sessionId: 'sess-compact-query', compactSubagents: true } as any);
  assert.deepEqual(compact.subagentSummaries, compactHistory.subagentSummaries);
  assert.equal(compact.turns[0].messages.length, 3);

  const emptyCompact = await handleSessionsTranscript({
    conversationHistory: {
      getHistory: async () => null,
      getCompactHistory: async () => null,
    },
    pendingInjections: { listBySession: async () => [] },
  } as unknown as UiServiceDeps, { sessionId: 'empty-compact', compactSubagents: true } as any);
  assert.deepEqual(emptyCompact.subagentSummaries, []);
});

test('sessions.subagentTranscript returns exact-id rows and an empty detail when the id has no rows', async () => {
  const deps = {
    conversationHistory: {
      getHistory: async () => null,
      getSubagentHistory: async (_sessionId: string, subagentId: string) => ({
        sessionId: 'sess-subagent-detail',
        subagentId,
        events: subagentId === 'child-1'
          ? [{ type: 'assistant', text: 'child note', ts: '2026-07-07T00:00:02.000Z', turnIndex: 0, elapsedMs: null }]
          : [],
      }),
    },
  } as unknown as UiServiceDeps;

  const detail = await handleSessionsSubagentTranscript(deps, {
    sessionId: 'sess-subagent-detail',
    subagentId: 'child-1',
  } as any);
  assert.equal(detail.subagentId, 'child-1');
  assert.deepEqual(detail.messages[0], {
    type: 'assistant', text: 'child note', toolName: null, toolInput: null,
    ts: '2026-07-07T00:00:02.000Z', elapsedMs: null,
  });

  const empty = await handleSessionsSubagentTranscript(deps, {
    sessionId: 'sess-subagent-detail',
    subagentId: 'missing',
  } as any);
  assert.deepEqual(empty, { sessionId: 'sess-subagent-detail', subagentId: 'missing', messages: [] });
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

// ── cursor-based delta reads ──────────────────────────────────────────────────
// The transcript is what the live SSE tail converges onto, so it is re-read at event rate. These
// guard the protocol that keeps that re-read proportional to what changed.

type CompactFixture = {
  events: { type: string; text?: string; toolName?: string; ts: string; turnIndex: number; id?: string; kind?: string; status?: string }[];
  eventRevs: number[];
};

function makeCursorDeps(model: () => { compact: CompactFixture; cursor: string }): UiServiceDeps {
  return {
    conversationHistory: {
      getHistory: async () => null,
      getCompactHistoryAt: async () => {
        const { compact, cursor } = model();
        return { value: { sessionId: 'sess-delta', committedSourceIds: [], subagentSummaries: [], ...compact }, cursor };
      },
    },
  } as unknown as UiServiceDeps;
}

test('sessions.transcript answers a matching cursor with only the rows that changed', async () => {
  const compact: CompactFixture = {
    events: [
      { type: 'user', text: 'one', ts: '2026-09-09T00:00:00.000Z', turnIndex: 0 },
      { type: 'assistant', text: 'answer one', ts: '2026-09-09T00:00:02.000Z', turnIndex: 0 },
    ],
    eventRevs: [1, 2],
  };
  let cursor = 'e1:2';
  const deps = makeCursorDeps(() => ({ compact, cursor }));

  const full = await handleSessionsTranscript(deps, { sessionId: 'sess-delta', compactSubagents: true });
  assert.equal(full.cursor, 'e1:2');
  assert.equal(full.delta, undefined, 'a read without a cursor is a whole transcript');
  assert.deepEqual(full.turns.map((turn) => turn.messages.map((m) => m.text)), [['one', 'answer one']]);

  // The assistant row grows (a streaming partial collapsing into it) and a new turn opens.
  compact.events[1].text = 'answer one, expanded';
  compact.eventRevs[1] = 3;
  compact.events.push({ type: 'user', text: 'two', ts: '2026-09-09T00:00:05.000Z', turnIndex: 1 });
  compact.eventRevs.push(4);
  cursor = 'e1:4';

  const delta = await handleSessionsTranscript(deps, { sessionId: 'sess-delta', compactSubagents: true, since: full.cursor });
  assert.deepEqual(delta.turns, [], 'a delta response carries no turns');
  assert.equal(delta.cursor, 'e1:4');
  assert.deepEqual(delta.delta!.changed.map((row) => [row.index, row.turnIndex, row.message.text]), [
    [1, 0, 'answer one, expanded'],
    [2, 1, 'two'],
  ]);
  assert.equal(delta.delta!.total, 3);
  // Elapsed is a difference against the PREVIOUS row, including one the delta does not re-send.
  assert.equal(delta.delta!.changed[1].message.elapsedMs, 3000);
});

test('sessions.transcript re-sends nothing when a cursor is already current', async () => {
  const compact: CompactFixture = {
    events: [{ type: 'user', text: 'only', ts: '2026-09-09T00:00:00.000Z', turnIndex: 0 }],
    eventRevs: [1],
  };
  const deps = makeCursorDeps(() => ({ compact, cursor: 'e1:1' }));
  const unchanged = await handleSessionsTranscript(deps, { sessionId: 'sess-delta', compactSubagents: true, since: 'e1:1' });
  assert.deepEqual(unchanged.delta, { changed: [], total: 1 });
});

test('sessions.transcript falls back to a whole transcript when the cursor is void', async () => {
  const compact: CompactFixture = {
    events: [{ type: 'user', text: 'after rewind', ts: '2026-09-09T00:00:00.000Z', turnIndex: 0 }],
    eventRevs: [1],
  };
  const deps = makeCursorDeps(() => ({ compact, cursor: 'e2:1' }));

  // A rewind moved the epoch: the revision the client holds no longer addresses these rows.
  const rebuilt = await handleSessionsTranscript(deps, { sessionId: 'sess-delta', compactSubagents: true, since: 'e1:9' });
  assert.equal(rebuilt.delta, undefined);
  assert.deepEqual(rebuilt.turns.map((turn) => turn.messages.map((m) => m.text)), [['after rewind']]);
  assert.equal(rebuilt.cursor, 'e2:1');

  const garbage = await handleSessionsTranscript(deps, { sessionId: 'sess-delta', compactSubagents: true, since: 'nonsense' });
  assert.equal(garbage.delta, undefined, 'an unparseable cursor is treated as no cursor');
});

test('sessions.transcript keeps re-sending interaction rows, whose rendering is time-dependent', async () => {
  const compact: CompactFixture = {
    events: [
      { type: 'user', text: 'ask me', ts: '2026-09-09T00:00:00.000Z', turnIndex: 0 },
      { type: 'interaction', id: 'int-1', kind: 'ask-user', status: 'pending', text: 'which one?', ts: '2026-09-09T00:00:01.000Z', turnIndex: 0 },
    ],
    eventRevs: [1, 2],
  };
  const deps = makeCursorDeps(() => ({ compact, cursor: 'e1:2' }));
  const delta = await handleSessionsTranscript(deps, { sessionId: 'sess-delta', compactSubagents: true, since: 'e1:2' });
  // The stored row did not change, but its status derives from wall clock + live server state, so
  // a revision comparison alone would let the card go stale.
  assert.deepEqual(delta.delta!.changed.map((row) => row.index), [1]);
  assert.equal(delta.delta!.changed[0].message.interaction!.status, 'expired');
});
