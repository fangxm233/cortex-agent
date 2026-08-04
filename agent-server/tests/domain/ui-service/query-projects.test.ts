import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleProjectsList } from '../../../src/domain/ui-service/query/projects.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: {
      list: () => [
        { id: 'cortex-self', name: 'cortex-self', kind: 'user' as const, contextDir: '/projects/cortex-self' },
        { id: 'general', name: 'general', kind: 'general' as const, contextDir: '/projects/general' },
      ],
      get: () => undefined,
      exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/projects/general' }),
      createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }),
    },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, monthlyBudget: 0, budgetScope: 'global' as const, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({ 'cortex-self': 'C123' }) } as any,
    ...overrides,
  };
}

test('projects.list returns ProjectConduitInfo for each project', async () => {
  const result = await handleProjectsList(makeDeps());
  assert.equal(result.length, 2);

  const selfProject = result.find(p => p.id === 'cortex-self');
  assert.ok(selfProject);
  assert.equal(selfProject.kind, 'research');
  assert.equal(selfProject.contextDir, '/projects/cortex-self');
  assert.equal(typeof selfProject.hasMission, 'boolean');
  assert.deepEqual(selfProject.conduits, { 'cortex-self': 'C123' });

  const general = result.find(p => p.id === 'general');
  assert.ok(general);
  assert.equal(general.kind, 'general');
});

test('projects.list handles conduit lookup failure gracefully', async () => {
  const result = await handleProjectsList(makeDeps({
    adapter: { getProjectConduits: async () => { throw new Error('fail'); } } as any,
  }));
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].conduits, {});
});
