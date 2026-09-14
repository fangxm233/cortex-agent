import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSessionsList, handleSessionsTranscript } from '../../../src/domain/ui-service/query/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { RunRegistry } from '../../../src/core/run-registry.js';

const mockSessions = [
  { sessionId: 's1', name: 'cortex-abc', projectId: 'proj1', channel: 'C1', backend: 'pi', kind: 'local' as const, origin: 'direct' as const, createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-05-01T00:00:00Z', label: 'dev', profileName: 'default', contextUsage: { usedTokens: 60000, contextWindow: 200000, percent: 30, accuracy: 'estimate' as const, updatedAt: '2026-07-27T12:00:00.000Z' } },
  { sessionId: 's2', name: 'cortex-def', projectId: 'proj2', channel: 'C2', backend: 'pi', kind: 'scheduled' as const, origin: 'scheduled' as const, createdAt: '2026-02-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z', label: null as string | null, profileName: null },
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
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: {
      getAll: () => [],
      sessionState: () => ({ running: false, backgroundRunning: false, numTurns: null, executionId: null }),
    } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, monthlyBudget: 0, budgetScope: 'global' as const, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
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

test('sessions.list exposes server-derived manual compaction support per session', async () => {
  const result = await handleSessionsList(makeDeps({
    supportsSessionCompaction: (session) => session.backend === 'pi',
  }), {});
  const byId = Object.fromEntries(result.map((session) => [session.sessionId, session.contextCompactionSupported]));
  assert.equal(byId['s1'], true);
  assert.equal(byId['s2'], true);
  assert.equal(byId['s3'], false);
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

test('sessions.list running snapshot: true when a live interactive turn is on the session', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      // s1 itself has a live interactive (non-thread) execution.
      sessionState: (sessionId: string) => sessionId === 's1'
        ? { running: true, backgroundRunning: false, numTurns: null, executionId: 'exec_1' }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
    } as any,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.running]));
  assert.equal(byId['s1'], true);
  assert.equal(byId['s2'], false);
  assert.equal(byId['s3'], false);
});

test('sessions.list running snapshot: a thread execution does NOT mark the session running', async () => {
  // Driven through a REAL RunRegistry, not a stub: the `!threadId` rule moved into
  // sessionState (pinned directly in tests/runs/registry.test.ts), and this asserts the whole
  // join still holds — a thread step running for s1 leaves the session's own row idle.
  const registry = new RunRegistry();
  registry.register({
    threadId: 'thr_x', channel: 'C1', executionId: 'exec_t', agentSlotId: null,
    kill: () => true, backend: 'pi', trackSessionId: 's1',
  });
  const deps = makeDeps({ runningExecutions: registry as any });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.ok(result.every(s => s.running === false));
});

test('sessions.list running snapshot: no live executions → running false everywhere', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      sessionState: () => ({ running: false, backgroundRunning: false, numTurns: null, executionId: null }),
    } as any,
  });
  const result = await handleSessionsList(deps, {});
  assert.ok(result.every(s => s.running === false));
});

test('sessions.list running snapshot: a session is NOT running just because a DIFFERENT session on its channel is', async () => {
  // Session-switch false positive (the P4.2 fix): the old session record keeps the `channel` value it
  // had, so the pre-P4.2 channel lookup (`getByChannel`) marked the OLD record running whenever the
  // NEW session on that channel ran. sessionState keys off the session id — the stale row stays idle.
  const switched = [
    { ...mockSessions[0] }, // s1, channel C1 — the record left behind by the switch
    { ...mockSessions[0], sessionId: 's1-new', name: 'cortex-new', channel: 'C1' },
  ];
  const deps = makeDeps({
    sessionStore: {
      listByProject: async () => switched,
      listByOrigin: async () => switched,
      listResumable: async () => switched,
      getById: async () => null,
    } as any,
    runningExecutions: {
      getAll: () => [],
      // Only the NEW session on C1 is in turn; the old record shares the channel, not the run.
      sessionState: (sessionId: string) => sessionId === 's1-new'
        ? { running: true, backgroundRunning: false, numTurns: 4, executionId: 'exec_new' }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.running]));
  assert.equal(byId['s1'], false, 'stale record sharing the channel must not read as running');
  assert.equal(byId['s1-new'], true, 'the session that actually owns the run is running');
});

test('sessions.list numTurns: running session → live running execution numTurns', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      // s1's live interactive (non-thread) execution is mid-run at 6 turns.
      sessionState: (sessionId: string) => sessionId === 's1'
        ? { running: true, backgroundRunning: false, numTurns: 6, executionId: 'exec_1' }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
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
      sessionState: (sessionId: string) => sessionId === 's1'
        ? { running: true, backgroundRunning: false, numTurns: null, executionId: 'exec_1' }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
    } as any,
    // A previous completed run on C1 exists — must NOT leak into the fresh running turn.
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 9 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.equal(result.find(s => s.sessionId === 's1')!.numTurns, null);
});

test('sessions.list numTurns: idle session → last non-thread execution numTurns (latest by startedAt)', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      sessionState: () => ({ running: false, backgroundRunning: false, numTurns: null, executionId: null }),
    } as any,
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 2 } },
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 7 } },
        // A thread execution on the same channel must be ignored.
        { channel: 'C1', session: { sessionId: 's1' }, thread: { threadId: 'thr_x' }, runtime: { startedAt: '2026-06-01T00:00:00Z' }, metrics: { numTurns: 99 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  assert.equal(result.find(s => s.sessionId === 's1')!.numTurns, 7, 'latest non-thread run');
  // s3 (channel C3) has no executions → null.
  assert.equal(result.find(s => s.sessionId === 's3')!.numTurns, null);
});

test('sessions.list numTurns/costUsd: a SUBAGENT run on the parent channel never shadows the session run', async () => {
  // The observed bug: `agent`-tool children inherit the parent's channel and carry no track identity
  // (`session.sessionId === null`), and a child always starts AFTER the parent run that spawned it.
  // Keyed by channel + max(startedAt), the last child won and the card showed ITS turns/cost.
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      sessionState: () => ({ running: false, backgroundRunning: false, numTurns: null, executionId: null }),
    } as any,
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        // The session's own long run — started first, finished last.
        {
          channel: 'C1', session: { sessionId: 's1' }, thread: null, source: { trigger: 'user' },
          runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 300, costUsd: 32.51 },
        },
        // Two children spawned one minute in — later startedAt, no session identity.
        {
          channel: 'C1', session: { sessionId: null }, thread: null, source: { trigger: 'subagent' },
          runtime: { startedAt: '2026-05-01T00:01:00Z' }, metrics: { numTurns: 47, costUsd: 1.55 },
        },
        {
          channel: 'C1', session: { sessionId: null }, thread: null, source: { trigger: 'subagent' },
          runtime: { startedAt: '2026-05-01T00:01:30Z' }, metrics: { numTurns: 52, costUsd: 1.95 },
        },
      ],
    } as any,
  });
  const s1 = (await handleSessionsList(deps, { projectId: 'proj1' })).find(s => s.sessionId === 's1')!;
  assert.equal(s1.numTurns, 300, "the session's own run, not its last child");
  assert.equal(s1.costUsd, 32.51, "the session's own cost, not its last child's");
});

// ── Whole-session totals (SessionInfo.totals) ──

const ENDED = { startedAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:10:00.000Z', endedAt: '2026-05-01T00:10:00.000Z' };

function registryOf(records: unknown[]) {
  return { getExecution: () => null, cancelExecution: () => null, getAll: () => records } as any;
}

test('sessions.list totals: every finished run of the session, not just the last one', async () => {
  // The reported problem: the status line showed the LAST run (`52 turns · $1.95`) for a session
  // that had run 13 times. Totals answer the other question.
  const deps = makeDeps({
    executionRegistry: registryOf([
      { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: ENDED, metrics: { numTurns: 300, costUsd: 32.5, durationS: 4477 } },
      { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: ENDED, metrics: { numTurns: 12, costUsd: 1.5, durationS: 63 } },
    ]),
  });
  const s1 = (await handleSessionsList(deps, { projectId: 'proj1' })).find(s => s.sessionId === 's1')!;
  assert.equal(s1.numTurns, 12, 'the last-run snapshot is unchanged');
  assert.deepEqual(s1.totals, { runs: 2, turns: 312, activeMs: 4540_000, costUsd: 34, subagentCostUsd: null });
});

test('sessions.list totals: a subagent child contributes its cost to the session that spawned it', async () => {
  const deps = makeDeps({
    executionRegistry: registryOf([
      { channel: 'C1', session: { sessionId: 's1' }, thread: null, source: { trigger: 'user' }, runtime: ENDED, metrics: { numTurns: 300, costUsd: 32.51, durationS: 4477 } },
      // Children keep sessionId null (so they cannot shadow the last run) and carry ownerSessionId.
      { channel: 'C1', session: { sessionId: null, ownerSessionId: 's1' }, thread: null, source: { trigger: 'subagent' }, runtime: ENDED, metrics: { numTurns: 52, costUsd: 1.95, durationS: 300 } },
      { channel: 'C1', session: { sessionId: null, ownerSessionId: 's1' }, thread: null, source: { trigger: 'subagent' }, runtime: ENDED, metrics: { numTurns: 47, costUsd: 1.55, durationS: 250 } },
    ]),
  });
  const s1 = (await handleSessionsList(deps, { projectId: 'proj1' })).find(s => s.sessionId === 's1')!;
  assert.equal(s1.numTurns, 300, 'the child-shadowing fix still holds');
  assert.equal(s1.totals!.turns, 300, 'children do not inflate the turn count');
  assert.equal(s1.totals!.activeMs, 4477_000, 'children run inside the parent turn — no extra time');
  assert.equal(Number(s1.totals!.costUsd!.toFixed(2)), 36.01);
  assert.equal(Number(s1.totals!.subagentCostUsd!.toFixed(2)), 3.5);
});

test('sessions.list totals: the in-flight turn and thread runs are excluded', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      sessionState: (id: string) => (id === 's1'
        ? { running: true, backgroundRunning: false, numTurns: 9, executionId: 'exec_live' }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null }),
    } as any,
    executionRegistry: registryOf([
      { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: ENDED, metrics: { numTurns: 4, costUsd: 1, durationS: 10 } },
      // The live turn: no endedAt, no final numbers.
      { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:01:00.000Z', endedAt: null }, metrics: { numTurns: 9, costUsd: null, durationS: null } },
      { channel: 'C1', session: { sessionId: 's1' }, thread: { threadId: 'thr_x' }, runtime: ENDED, metrics: { numTurns: 99, costUsd: 50, durationS: 999 } },
    ]),
  });
  const s1 = (await handleSessionsList(deps, { projectId: 'proj1' })).find(s => s.sessionId === 's1')!;
  assert.equal(s1.numTurns, 9, 'the live count still drives the last-run snapshot');
  assert.deepEqual(s1.totals, { runs: 1, turns: 4, activeMs: 10_000, costUsd: 1, subagentCostUsd: null });
});

test('sessions.list totals: archived runs come back from the carry, and are not counted twice', async () => {
  // The archive sweep removes week-old records from the registry. The carry holds their numbers and
  // a watermark; anything still live but older than that watermark has already been carried.
  const { STORE_DIR } = await import('../../../src/core/paths.js');
  const { sessionTotalsCarry } = await import('../../../src/store/session-totals-repo.js');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(path.join(STORE_DIR, 'session-totals.json'), JSON.stringify({
    carriedThrough: '2026-05-15T00:00:00.000Z',
    sessions: { s1: { runs: 3, turns: 40, activeMs: 300_000, cost: 9, costSamples: 3, subCost: 1, subSamples: 1 } },
  }), 'utf8');
  sessionTotalsCarry.invalidate();

  const deps = makeDeps({
    executionRegistry: registryOf([
      // Already inside the carry (ended before the watermark) — must not be added again.
      { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-05-01T00:00:00.000Z', updatedAt: ENDED.endedAt, endedAt: '2026-05-01T00:10:00.000Z' }, metrics: { numTurns: 999, costUsd: 999, durationS: 999 } },
      // After the watermark — still the live pass's business.
      { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:01:00.000Z', endedAt: '2026-06-01T00:01:00.000Z' }, metrics: { numTurns: 5, costUsd: 2, durationS: 40 } },
    ]),
  });
  const s1 = (await handleSessionsList(deps, { projectId: 'proj1' })).find(s => s.sessionId === 's1')!;
  assert.deepEqual(s1.totals, { runs: 4, turns: 45, activeMs: 340_000, costUsd: 12, subagentCostUsd: 1 });

  await fs.rm(path.join(STORE_DIR, 'session-totals.json'), { force: true });
  sessionTotalsCarry.invalidate();
});

test('sessions.list totals: a session that never finished a run has none', async () => {
  const deps = makeDeps({ executionRegistry: registryOf([]) });
  const s1 = (await handleSessionsList(deps, { projectId: 'proj1' })).find(s => s.sessionId === 's1')!;
  assert.equal(s1.totals, null);
});

test('sessions.list numTurns/costUsd: a run belonging to ANOTHER session on the same channel is not attributed', async () => {
  // Channel recycling (the session-switch case): the stale record keeps the channel, so a
  // channel-keyed snapshot would hand s1 the NEW session's numbers.
  const deps = makeDeps({
    sessionStore: {
      listByProject: async () => [
        { ...mockSessions[0] },
        { ...mockSessions[0], sessionId: 's1-new', name: 'cortex-new', channel: 'C1' },
      ],
    } as any,
    runningExecutions: {
      getAll: () => [],
      sessionState: () => ({ running: false, backgroundRunning: false, numTurns: null, executionId: null }),
    } as any,
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 7, costUsd: 0.42 } },
        { channel: 'C1', session: { sessionId: 's1-new' }, thread: null, runtime: { startedAt: '2026-06-01T00:00:00Z' }, metrics: { numTurns: 3, costUsd: 0.07 } },
      ],
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s]));
  assert.equal(byId['s1'].numTurns, 7);
  assert.equal(byId['s1'].costUsd, 0.42);
  assert.equal(byId['s1-new'].numTurns, 3);
  assert.equal(byId['s1-new'].costUsd, 0.07);
});

test('sessions.list numTurns: no execution data anywhere → null', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  assert.ok(result.every(s => s.numTurns === null));
});

test('sessions.list costUsd: idle session → last non-thread execution costUsd (latest by startedAt)', async () => {
  const deps = makeDeps({
    runningExecutions: {
      getAll: () => [],
      sessionState: () => ({ running: false, backgroundRunning: false, numTurns: null, executionId: null }),
    } as any,
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 2, costUsd: 0.11 } },
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 7, costUsd: 0.42 } },
        // A thread execution on the same channel must be ignored.
        { channel: 'C1', session: { sessionId: 's1' }, thread: { threadId: 'thr_x' }, runtime: { startedAt: '2026-06-01T00:00:00Z' }, metrics: { numTurns: 99, costUsd: 9.99 } },
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
      sessionState: (sessionId: string) => sessionId === 's1'
        ? { running: true, backgroundRunning: false, numTurns: 3, executionId: 'exec_1' }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
    } as any,
    // A previous completed run on C1 has a cost — must NOT leak into the fresh running turn.
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-04-01T00:00:00Z' }, metrics: { numTurns: 9, costUsd: 1.23 } },
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
    runningExecutions: {
      getAll: () => [],
      // The session is held with NO live foreground execution (executionId null).
      sessionState: (sessionId: string) => sessionId === 's1'
        ? { running: true, backgroundRunning: true, numTurns: null, executionId: null }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
    } as any,
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
    runningExecutions: {
      getAll: () => [],
      sessionState: (sessionId: string) => sessionId === 's1'
        ? { running: true, backgroundRunning: true, numTurns: null, executionId: null }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
    } as any,
    executionRegistry: {
      getExecution: () => null, cancelExecution: () => null,
      getAll: () => [
        { channel: 'C1', session: { sessionId: 's1' }, thread: null, runtime: { startedAt: '2026-05-01T00:00:00Z' }, metrics: { numTurns: 7, costUsd: 0.42 } },
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
      // Defensive: the registry still flags a background hold AND a live foreground turn; the row
      // must mask backgroundRunning while in a turn.
      sessionState: (sessionId: string) => sessionId === 's1'
        ? { running: true, backgroundRunning: true, numTurns: null, executionId: 'exec_1' }
        : { running: false, backgroundRunning: false, numTurns: null, executionId: null },
    } as any,
  });
  const result = await handleSessionsList(deps, { projectId: 'proj1' });
  const s1 = result.find(s => s.sessionId === 's1')!;
  assert.equal(s1.running, true);
  assert.equal(s1.backgroundRunning, false);
});

test('sessions.list with no registry background hold → backgroundRunning false everywhere', async () => {
  const result = await handleSessionsList(makeDeps(), {});
  assert.ok(result.every(s => s.backgroundRunning === false));
});

test('sessions.list awaitingInput: a pending ask-user OR plan on the channel → true (needs-user amber)', async () => {
  // The rail dot turns amber only when the session is blocked on a user action (ask-user question /
  // plan approval), keyed by the session's channel via the in-memory pending maps. Background-hold
  // and plain running stay blue — this flag is what distinguishes them.
  const deps = makeDeps({
    getPendingAskUser: (channel: string) =>
      channel === 'C1' ? { requestId: 'r1', questions: [], blocking: true } : null,
    getPendingPlan: (channel: string) =>
      channel === 'C3' ? { requestId: 'r2', planContent: 'plan', planFilePath: null } : null,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map((s) => [s.sessionId, s.awaitingInput]));
  assert.equal(byId['s1'], true, 'pending ask-user → awaiting');
  assert.equal(byId['s3'], true, 'pending plan → awaiting');
  assert.equal(byId['s2'], false, 'no pending interaction → not awaiting');
});

test('sessions.list awaitingInput: a pending NON-blocking ask does not stall the session → false', async () => {
  // cortex_ask_user blocking:false posts a card but the agent keeps running, so the rail dot must
  // stay blue — the amber "needs you" state is reserved for a session that cannot proceed.
  const deps = makeDeps({
    getPendingAskUser: (channel: string) =>
      channel === 'C1' ? { requestId: 'r1', questions: [], blocking: false } : null,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map((s) => [s.sessionId, s.awaitingInput]));
  assert.equal(byId['s1'], false, 'non-blocking ask → not awaiting');
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

test('sessions.list carries scheduleId provenance, null when the record has none', async () => {
  const withSchedule = [
    { ...mockSessions[1], scheduleId: 'sched-7' },
    { ...mockSessions[0] },
  ];
  const deps = makeDeps({
    sessionStore: {
      listByProject: async () => withSchedule,
      listByOrigin: async () => withSchedule,
      listResumable: async () => withSchedule,
      getById: async () => null,
    } as any,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.scheduleId]));
  assert.equal(byId['s2'], 'sched-7');
  assert.equal(byId['s1'], null);
});

test('sessions.list unread: a never-viewed SCHEDULED session is unread (result attention dot)', async () => {
  const rows = [
    // scheduled, never viewed → unread (the 27c "result → blue dot until opened" rule)
    { ...mockSessions[1] },
    // scheduled, viewed after its run → read
    { ...mockSessions[1], sessionId: 's2b', name: 'cortex-s2b', lastReadAt: '2026-04-02T00:00:00Z' },
    // direct, never viewed → stays grandfathered as read (no unread flood on deploy)
    { ...mockSessions[0] },
  ];
  const deps = makeDeps({
    sessionStore: {
      listByProject: async () => rows,
      listByOrigin: async () => rows,
      listResumable: async () => rows,
      getById: async () => null,
    } as any,
  });
  const result = await handleSessionsList(deps, {});
  const byId = Object.fromEntries(result.map(s => [s.sessionId, s.unread]));
  assert.equal(byId['s2'], true, 'never-viewed scheduled run is unread');
  assert.equal(byId['s2b'], false, 'viewed scheduled run is read');
  assert.equal(byId['s1'], false, 'direct sessions keep the grandfather rule');
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
