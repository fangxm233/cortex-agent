import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleThreadsList } from '../../../src/domain/ui-service/query/threads.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const mockThreads = [
  { id: 'thr_a', channel: 'web:sess-1', templateName: 'coder-review', status: 'running', projectId: 'proj1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', currentStepIndex: 1, currentStepName: 'review', template: { agents: [{ name: 'coder' }, { name: 'reviewer' }] }, steps: [], artifactPath: '/tmp/a.md' },
  { id: 'thr_b', channel: 'proj1', templateName: 'research', status: 'completed', projectId: 'proj1', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z', currentStepIndex: null, steps: [{ name: 'plan' }, { name: 'execute' }], artifactPath: null },
  { id: 'thr_c', channel: 'web:sess-2', templateName: 'bugfix', status: 'failed', projectId: 'proj2', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-05-15T00:00:00Z', currentStepIndex: 0, currentStepName: 'fix', steps: [{ name: 'fix' }], artifactPath: '/tmp/c.md' },
];

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => mockThreads, get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
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

test('threads.list returns all threads when no filter', async () => {
  const result = await handleThreadsList(makeDeps(), {});
  assert.equal(result.length, 3);
});

test('threads.list filters by projectId', async () => {
  const result = await handleThreadsList(makeDeps(), { projectId: 'proj1' });
  assert.equal(result.length, 2);
  assert.ok(result.every(t => t.projectId === 'proj1'));
});

test('threads.list filters by status', async () => {
  const result = await handleThreadsList(makeDeps(), { status: ['running', 'completed'] });
  assert.equal(result.length, 2);
  assert.ok(result.every(t => t.status === 'running' || t.status === 'completed'));
});

test('threads.list currentStep is correct', async () => {
  const result = await handleThreadsList(makeDeps(), {});
  const running = result.find(t => t.id === 'thr_a')!;
  assert.deepEqual(running.currentStep, { index: 1, name: 'review' });

  const completed = result.find(t => t.id === 'thr_b')!;
  assert.equal(completed.currentStep, null);
});

test('threads.list totalSteps from template agents or step count', async () => {
  const result = await handleThreadsList(makeDeps(), {});
  const thrA = result.find(t => t.id === 'thr_a')!;
  assert.equal(thrA.totalSteps, 2); // template.agents.length

  const thrB = result.find(t => t.id === 'thr_b')!;
  assert.equal(thrB.totalSteps, 2); // steps.length

  const thrC = result.find(t => t.id === 'thr_c')!;
  assert.equal(thrC.totalSteps, 1); // steps.length
});

test('threads.list artifactPath is null when absent', async () => {
  const result = await handleThreadsList(makeDeps(), {});
  const thrB = result.find(t => t.id === 'thr_b')!;
  assert.equal(thrB.artifactPath, null);
});

test('threads.list scopes to the current session by channel', async () => {
  // sessionId resolves to a channel; only threads on that channel are returned (the inline chat
  // thread card shows THIS session's thread, not a random global one).
  const deps = makeDeps({
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => ({ channel: 'web:sess-1' } as any) },
  });
  const result = await handleThreadsList(deps, { sessionId: 'sess-1' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'thr_a');
});

test('threads.list sessionId + status compose (both applied)', async () => {
  const deps = makeDeps({
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => ({ channel: 'web:sess-1' } as any) },
  });
  // thr_a is on web:sess-1 but running; asking only for 'completed' yields nothing.
  const result = await handleThreadsList(deps, { sessionId: 'sess-1', status: ['completed'] });
  assert.equal(result.length, 0);
});

test('threads.list returns empty when the sessionId is unknown', async () => {
  const deps = makeDeps({
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
  });
  const result = await handleThreadsList(deps, { sessionId: 'nope' });
  assert.equal(result.length, 0);
});
