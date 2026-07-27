// input:  session query handlers with injected stores and live registries
// output: session list/context/transcript snapshot regression coverage
// pos:    ui-service session query specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSessionsList, handleSessionsTranscript } from '../../../src/domain/ui-service/query/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const mockSessions = [
  { sessionId: 's1', name: 'cortex-abc', projectId: 'proj1', channel: 'C1', backend: 'pi', kind: 'local' as const, origin: 'direct' as const, createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-05-01T00:00:00Z', label: 'dev', profileName: 'default', contextUsage: { usedTokens: 60000, contextWindow: 200000, percent: 30, accuracy: 'estimate' as const, updatedAt: '2026-07-27T12:00:00.000Z' } },
  { sessionId: 's2', name: 'cortex-def', projectId: 'proj2', channel: 'C2', backend: 'codex', kind: 'scheduled' as const, origin: 'scheduled' as const, createdAt: '2026-02-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z', label: null as string | null, profileName: null },
  { sessionId: 's3', name: 'cortex-ghi', projectId: 'proj1', channel: 'C3', backend: 'claude', kind: 'local' as const, origin: 'thread' as const, createdAt: '2026-03-01T00:00:00Z', lastUsedAt: '2026-05-15T00:00:00Z', label: '[thr_x:main]', profileName: 'pi' },
];

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: {
      list: () => [
        { id: 'proj1', name: 'proj1', kind: 'user' as const, contextDir: '/p1' },
        { id: 'proj2', name: 'proj2', kind: 'user' as const, contextDir: '/p2' },
      ],
      get: () => undefined, exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }),
      createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }),
    },
    sessionStore: {
      listByProject: async (pid: string) => mockSessions.filter(s => s.projectId === pid),
      listByOrigin: async (origin: string, pid?: string) => mockSessions.filter(s => s.origin === origin && (!pid || s.projectId === pid)),
      listResumable: async (pid?: string) => mockSessions.filter(s => s.kind !== 'scheduled' && (!pid || s.projectId === pid)),
      getById: async () => null,
    },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [], getByChannel: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
    ...overrides,
  };
}

test('sessions.list with projectId returns filtered sessions', async () => {
  const result = await handleSessionsList(makeDeps(), { projectId: 'proj1' });
  assert.equal(result.length, 2);
  assert.equal(result[0].sessionId, 's1');
  assert.equal(result[0].projectId, 'proj1');
  assert.equal(result[0].resumable, true);
  assert.equal(result[1].sessionId, 's3');
  assert.equal(result[1].resumable, true);
});

test('sessions.list exposes persisted context usage and uses null for legacy sessions', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  const byId = Object.fromEntries(result.map((session) => [session.sessionId, session.contextUsage]));
  assert.deepEqual(byId['s1'], mockSessions[0].contextUsage);
  assert.equal(byId['s2'], null);
});

test('sessions.list with resumable=true returns only non-scheduled sessions', async () => {
  const result = await handleSessionsList(makeDeps(), { resumable: true });
  assert.equal(result.length, 2);
  assert.ok(result.every(s => s.resumable === true));
});

test('sessions.list with projectId + resumable', async () => {
  const result = await handleSessionsList(makeDeps(), { projectId: 'proj2', resumable: true });
  assert.equal(result.length, 0); // proj2 only has scheduled session
});

test('sessions.list without filter returns all sessions grouped by project', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  assert.equal(result.length, 3);
});

test('sessions.list sets resumable correctly for scheduled sessions', async () => {
  const result = await handleSessionsList(makeDeps(), { projectId: 'proj2' });
  assert.equal(result.length, 1);
  assert.equal(result[0].resumable, false);
});

test('sessions.list maps the origin field onto SessionInfo', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.origin]));
  assert.equal(byId['s1'], 'direct');
  assert.equal(byId['s2'], 'scheduled');
  assert.equal(byId['s3'], 'thread');
});

test('sessions.list with origin=direct returns only direct sessions', async () => {
  const result = await handleSessionsList(makeDeps(), { origin: 'direct' });
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 's1');
  assert.ok(result.every(s => s.origin === 'direct'));
});

test('sessions.list with origin=thread returns only thread sessions', async () => {
  const result = await handleSessionsList(makeDeps(), { origin: 'thread' });
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 's3');
});

test('sessions.list with origin + projectId scopes to both', async () => {
  const result = await handleSessionsList(makeDeps(), { origin: 'direct', projectId: 'proj1' });
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 's1');

  const none = await handleSessionsList(makeDeps(), { origin: 'direct', projectId: 'proj2' });
  assert.equal(none.length, 0);
});

test('sessions.list running snapshot: true when a live interactive turn is on the session channel', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      // s1's channel C1 has a live interactive (non-thread) execution.
      getByChannel: (channel: string) =>
        channel === 'C1' ? [{ threadId: null, channel: 'C1', executionId: 'exec_1' }] : [],
    } as any,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.running]));
  assert.equal(byId['s1'], true);
  assert.equal(byId['s2'], false);
  assert.equal(byId['s3'], false);
});

test('sessions.list running snapshot: a thread execution on the channel does NOT mark the session running', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      // C1 only has a THREAD execution — the session itself is not in a turn.
      getByChannel: (channel: string) =>
        channel === 'C1' ? [{ threadId: 'thr_x', channel: 'C1', executionId: 'exec_t' }] : [],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.ok(result.every(s => s.running === false));
});

test('sessions.list running snapshot: no live executions → running false everywhere', async () => {
  const deps = makeDeps({
    runningExecutions: { getAll: () => [], getByChannel: () => [] } as any,
  });
  const result = await handleSessionsList(deps, {});
  assert.ok(result.every(s => s.running === false));
});

test('sessions.list numTurns: running session → live running execution numTurns', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      // s1's channel C1 has a live interactive (non-thread) execution mid-run at 6 turns.
      getByChannel: (channel: string) =>
        channel === 'C1' ? [{ threadId: null, channel: 'C1', executionId: 'exec_1', numTurns: 6 }] : [],
    } as any,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.numTurns]));
  assert.equal(byId['s1'], 6, 'running session shows the live turn count');
  assert.equal(byId['s2'], null);
  assert.equal(byId['s3'], null);
});

test('sessions.list numTurns: running session but no progress yet → null (no stale fallback)', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      getByChannel: (channel: string) =>
        channel === 'C1' ? [{ threadId: null, channel: 'C1', executionId: 'exec_1', numTurns: null }] : [],
    } as any,
    // A previous completed run on C1 exists — must NOT leak into the fresh running turn.
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 9 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.equal(result.find(s => s.sessionId === 's1')!.numTurns, null);
});

test('sessions.list numTurns: idle session → last non-thread execution numTurns (latest by startedAt)', async () => {
  const deps = makeDeps({
    runningExecutions: { getAll: () => [], getByChannel: () => [] } as any,
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 2 } },
        { channel: 'C1', thread: null, runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 7 } },
        // A thread execution on the same channel must be ignored.
        { channel: 'C1', thread: { threadId: 'thr_x' }, runtime: { startedAt: '2026-06-01T00:00:00Z' }, metrics: { numTurns: 99 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.equal(result.find(s => s.sessionId === 's1')!.numTurns, 7, 'latest non-thread run');
  // s3 (channel C3) has no executions → null.
  assert.equal(result.find(s => s.sessionId === 's3')!.numTurns, null);
});

test('sessions.list numTurns: no execution data anywhere → null', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  assert.ok(result.every(s => s.numTurns === null));
});

test('sessions.list costUsd: idle session → last non-thread execution costUsd (latest by startedAt)', async () => {
  const deps = makeDeps({
    runningExecutions: { getAll: () => [], getByChannel: () => [] } as any,
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 2, costUsd: 0.11 } },
        { channel: 'C1', thread: null, runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 7, costUsd: 0.42 } },
        // A thread execution on the same channel must be ignored.
        { channel: 'C1', thread: { threadId: 'thr_x' }, runtime: { startedAt: '2026-06-01T00:00:00Z' }, metrics: { numTurns: 99, costUsd: 9.99 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.equal(result.find(s => s.sessionId === 's1')!.costUsd, 0.42, 'latest non-thread run cost');
  // s3 (channel C3) has no executions → null.
  assert.equal(result.find(s => s.sessionId === 's3')!.costUsd, null);
});

test('sessions.list costUsd: running session → null (no live cost source, no stale fallback)', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      getByChannel: (channel: string) =>
        channel === 'C1' ? [{ threadId: null, channel: 'C1', executionId: 'exec_1', numTurns: 3 }] : [],
    } as any,
    // A previous completed run on C1 has a cost — must NOT leak into the fresh running turn.
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 9, costUsd: 1.23 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.equal(result.find(s => s.sessionId === 's1')!.costUsd, null);
});

test('sessions.list costUsd: no execution data anywhere → null', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  assert.ok(result.every(s => s.costUsd === null));
});

test('sessions.list bg-held session: running true + backgroundRunning true with NO live execution (web bg-hold snapshot)', async () => {
  // The web bg-hold ends the foreground execution (removed from runningExecutions) but keeps the
  // session logically running via the session.status event stream. The snapshot must mirror that,
  // or a session switch / app restart loses the state (the original bug).
  const deps = makeDeps({
    runningExecutions: { getAll: () => [], getByChannel: () => [] } as any,
    isSessionBgHeld: (id: string) => id === 's1',
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const s1 = result.find(s => s.sessionId === 's1')!;
  assert.equal(s1.running, true, 'held session stays running');
  assert.equal(s1.backgroundRunning, true, 'held session carries the background flag');
  const s3 = result.find(s => s.sessionId === 's3')!;
  assert.equal(s3.running, false);
  assert.equal(s3.backgroundRunning, false);
});

test('sessions.list bg-held session: numTurns/costUsd fall back to the last completed run (foreground turn is over)', async () => {
  const deps = makeDeps({
    runningExecutions: { getAll: () => [], getByChannel: () => [] } as any,
    isSessionBgHeld: (id: string) => id === 's1',
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', thread: null, runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 7, costUsd: 0.42 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const s1 = result.find(s => s.sessionId === 's1')!;
  assert.equal(s1.numTurns, 7);
  assert.equal(s1.costUsd, 0.42);
});

test('sessions.list live foreground turn wins over the bg flag (backgroundRunning false while in a turn)', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      getByChannel: (channel: string) =>
        channel === 'C1' ? [{ threadId: null, channel: 'C1', executionId: 'exec_1' }] : [],
    } as any,
    // Defensive: even if the tracker still flags the session, a live turn renders as plain running.
    isSessionBgHeld: (id: string) => id === 's1',
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const s1 = result.find(s => s.sessionId === 's1')!;
  assert.equal(s1.running, true);
  assert.equal(s1.backgroundRunning, false);
});

test('sessions.list without an isSessionBgHeld dep → backgroundRunning false everywhere (fixtures/TUI)', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  assert.ok(result.every(s => s.backgroundRunning === false));
});

test('sessions.list awaitingInput: a pending ask-user OR plan on the channel → true (needs-user amber)', async () => {
  // The rail dot turns amber only when the session is blocked on a user action (ask-user question /
  // plan approval), keyed by the session's channel via the in-memory pending maps. Background-hold
  // and plain running stay blue — this flag is what distinguishes them.
  const deps = makeDeps({
    getPendingAskUser: (channel: string) =>
      channel === 'C1' ? { requestId: 'r1', questions: [] } : null,
    getPendingPlan: (channel: string) =>
      channel === 'C3' ? { requestId: 'r2', planContent: 'plan', planFilePath: null } : null,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map((s) => [s.sessionId, s.awaitingInput]));
  assert.equal(byId['s1'], true, 'pending ask-user → awaiting');
  assert.equal(byId['s3'], true, 'pending plan → awaiting');
  assert.equal(byId['s2'], false, 'no pending interaction → not awaiting');
});

test('sessions.list awaitingInput: without pending-interaction deps → false everywhere (fixtures/TUI)', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  assert.ok(result.every((s) => s.awaitingInput === false));
});

test('sessions.list unread: activity after lastReadAt → unread; read/never-tracked → false', async () => {
  const withRead = [
    // s1: read AFTER last activity → not unread
    { ...mockSessions[0], lastReadAt: '2026-05-02T00:00:00Z' },
    // s2: activity (lastUsedAt 2026-04-01) AFTER lastReadAt → unread
    { ...mockSessions[1], lastReadAt: '2026-03-01T00:00:00Z' },
    // s3: lastReadAt never set (legacy record) → grandfathered as read
    { ...mockSessions[2] },
  ];
  const deps = makeDeps({
    sessionStore: {
      listByProject: async () => withRead,
      listByOrigin: async () => withRead,
      listResumable: async () => withRead,
      getById: async () => null,
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.unread]));
  assert.equal(byId['s1'], false, 'read after activity');
  assert.equal(byId['s2'], true, 'activity after read');
  assert.equal(byId['s3'], false, 'no lastReadAt → grandfathered read');
});

test('sessions.list exposes backendSessionId (resume target) distinct from the track sessionId', async () => {
  // Post-decoupling (track/backend split): SessionInfo.sessionId is the stable TRACK id (UI identity),
  // while the CLI --resume target lives in the registry's backendSessionId. The Session ID surface
  // must show the real backend resume id, so the DTO has to carry it separately from sessionId.
  const withBackend = [{ ...mockSessions[0], backendSessionId: 'be-uuid-1111' }];
  const deps = makeDeps({
    sessionStore: {
      listByProject: async () => withBackend,
      listByOrigin: async () => withBackend,
      listResumable: async () => withBackend,
      getById: async () => null,
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const s1 = result.find((s) => s.sessionId === 's1')!;
  assert.equal(s1.sessionId, 's1', 'track id (UI identity) unchanged');
  assert.equal(s1.backendSessionId, 'be-uuid-1111', 'exposes the real backend resume id');
});

test('sessions.list backendSessionId: fresh session (explicit null) → null (never fabricated)', async () => {
  const fresh = [{ ...mockSessions[0], backendSessionId: null }];
  const deps = makeDeps({
    sessionStore: {
      listByProject: async () => fresh,
      listByOrigin: async () => fresh,
      listResumable: async () => fresh,
      getById: async () => null,
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.equal(result.find((s) => s.sessionId === 's1')!.backendSessionId, null);
});

test('sessions.list backendSessionId: legacy record (field absent) → falls back to sessionId', async () => {
  // mockSessions carry no backendSessionId (undefined) → the pre-decoupling conflated id, where
  // sessionId WAS the backend id. effectiveBackendSessionId falls back to sessionId so old sessions
  // still resume.
  const result = await handleSessionsList(makeDeps(), { projectId: 'proj1' });
  assert.equal(result.find((s) => s.sessionId === 's1')!.backendSessionId, 's1');
});

test('sessions.list titles a label-less session from its first user message, keeping existing labels', async () => {
  const deps = makeDeps({
    conversationHistory: {
      getHistory: async () => null,
      getFirstUserText: async (id: string) => (id === 's2' ? 'help me set up the ablation sweep' : null),
    },
  });
  const result = await handleSessionsList(deps, {});
  // s2 had no label → titled from its first user message
  assert.equal(result.find((s) => s.sessionId === 's2')!.label, 'help me set up the ablation sweep');
  // s1 already had a label → not overwritten
  assert.equal(result.find((s) => s.sessionId === 's1')!.label, 'dev');
});

test('sessions.transcript maps agent-sent file attachments onto assistant messages (20a)', async () => {
  const attachments = [{ name: 'ablation.pdf', path: 'workspace/outputs/s1/ablation.pdf', size: 2100, mimeType: 'application/pdf', type: 'file' as const }];
  const deps = makeDeps({
    conversationHistory: {
      getHistory: async () => ({
        sessionId: 's1',
        events: [
          { type: 'user' as const, text: 'send me the report', ts: '2026-05-01T00:00:00.000Z', turnIndex: 0 },
          { type: 'assistant' as const, text: 'here it is', ts: '2026-05-01T00:00:01.000Z', turnIndex: 0, attachments },
        ],
      }),
    },
  });
  const result = await handleSessionsTranscript(deps, { sessionId: 's1' });
  const assistantMsg = result.turns[0].messages.find((m) => m.type === 'assistant')!;
  assert.deepEqual(assistantMsg.attachments, attachments);
  // user message with no attachments must not gain an attachments key
  const userMsg = result.turns[0].messages.find((m) => m.type === 'user')!;
  assert.equal(userMsg.attachments, undefined);
});

test('sessions.transcript returns durable pending messages even before committed history exists', async () => {
  const attachments = [{ name: 'note.txt', path: 'workspace/attachments/s1/note.txt', size: 4, mimeType: 'text/plain', type: 'file' as const }];
  const deps = makeDeps({
    conversationHistory: { getHistory: async () => null },
    pendingInjections: {
      listBySession: async (sessionId: string) => sessionId === 's1' ? [{
        id: 'pin-1', sessionId: 's1', channel: 'web:s1', messageId: 'web-1',
        sessionName: 'cortex-nimbus', backend: 'claude', profileName: 'default',
        text: 'change direction', attachments, createdAt: '2026-05-01T00:00:03.000Z',
      }] : [],
    },
  } as any);

  const result = await handleSessionsTranscript(deps, { sessionId: 's1' });
  assert.deepEqual(result.turns, []);
  assert.deepEqual(result.pendingUserMessages, [{
    id: 'pin-1', text: 'change direction', ts: '2026-05-01T00:00:03.000Z', attachments,
  }]);
});

test('sessions.transcript defaults pendingUserMessages to an empty snapshot', async () => {
  const result = await handleSessionsTranscript(makeDeps(), { sessionId: 's1' });
  assert.deepEqual(result.pendingUserMessages, []);
});

test('sessions.transcript reads active pending before history to avoid a cross-store handoff gap', async () => {
  let pendingRead = false;
  const deps = makeDeps({
    pendingInjections: {
      listBySession: async () => {
        pendingRead = true;
        return [];
      },
    },
    conversationHistory: {
      getHistory: async () => {
        assert.equal(pendingRead, true, 'pending-before-history makes remove-after-append observable on one side');
        return null;
      },
    },
  } as any);
  await handleSessionsTranscript(deps, { sessionId: 's1' });
});

test('sessions.transcript suppresses an active record whose committed history row already landed', async () => {
  const pending = {
    id: 'pin-race', sessionId: 's1', channel: 'web:s1', messageId: 'web-race',
    sessionName: 'cortex-nimbus', backend: 'claude', profileName: 'default',
    text: 'change direction', createdAt: '2026-05-01T00:00:03.000Z',
  };
  const deps = makeDeps({
    conversationHistory: {
      getHistory: async () => ({
        sessionId: 's1',
        committedSourceIds: ['pin-race'],
        events: [{ type: 'user' as const, text: pending.text, ts: '2026-05-01T00:00:04.000Z', turnIndex: 0 }],
      }),
    },
    pendingInjections: { listBySession: async () => [pending] },
  } as any);

  const result = await handleSessionsTranscript(deps, { sessionId: 's1' });
  assert.equal(result.turns[0].messages[0].text, pending.text);
  assert.deepEqual(result.pendingUserMessages, [], 'one send must never render as committed + pending');
});
