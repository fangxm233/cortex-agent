import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSessionsList } from '../../../src/domain/ui-service/query/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const mockSessions = [
  { sessionId: 's1', name: 'cortex-abc', projectId: 'proj1', channel: 'C1', backend: 'claude', kind: 'local' as const, origin: 'direct' as const, createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-05-01T00:00:00Z', label: 'dev', profileName: 'default' },
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
