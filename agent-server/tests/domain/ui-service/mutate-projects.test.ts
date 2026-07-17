import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateProject } from '../../../src/domain/ui-service/mutate/projects.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function makeDeps(createProject: UiServiceDeps['projectStore']['createProject']): UiServiceDeps {
  return {
    projectStore: {
      list: () => [],
      get: () => undefined,
      exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }),
      createProject,
    },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    approvalsPath: '/tmp/PENDING_APPROVALS.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
  };
}

test('projects.create returns ok with the new project id on success', async () => {
  const deps = makeDeps((name) => ({
    ok: true,
    project: { id: name, name, kind: 'user', contextDir: `/p/${name}` },
  }));
  const result = await handleCreateProject(deps, { name: 'nimbus' });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, { id: 'nimbus' });
});

test('projects.create maps invalid-name to an invalid-name Err (not invalid-args)', async () => {
  const deps = makeDeps(() => ({ ok: false, code: 'invalid-name', message: 'bad' }));
  const result = await handleCreateProject(deps, { name: '..' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'invalid-name');
});

test('projects.create maps already-exists to an already-exists Err', async () => {
  const deps = makeDeps(() => ({ ok: false, code: 'already-exists', message: 'dup' }));
  const result = await handleCreateProject(deps, { name: 'orchard' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'already-exists');
});
