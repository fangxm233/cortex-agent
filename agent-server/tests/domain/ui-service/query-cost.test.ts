import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCostSummary } from '../../../src/domain/ui-service/query/cost.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

test('cost.summary delegates to costSummary and returns CostSummary', async () => {
  const expected: any = {
    today: 10, week: 50, month: 200, total: 1000,
    byMode: {},
    byProject: {}, byTrigger: {}, bySource: {}, byBackend: {},
    tokens: { today: { input: 100, output: 50 }, month: { input: 500, output: 250 }, total: { input: 5000, output: 2500 } },
    entryCount: 42,
    // additive real-data fields (task c489) — the facade must pass them through unchanged
    dailyBudget: 300, forecastToday: 24.5,
    dailyCost: [{ date: '2026-07-10', cost: 10 }],
    byTriggerScoped: { thread: { today: 10, week: 50, month: 200, total: 1000 } },
  };

  const deps: UiServiceDeps = {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
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
    costSummary: async (projectId?: string | null) => {
      assert.equal(projectId, null);
      return expected;
    },
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
  };

  const result = await handleCostSummary(deps, { projectId: null });
  assert.deepEqual(result, expected);
});

test('cost.summary passes projectId filter', async () => {
  let capturedProjectId: string | null | undefined = undefined;
  const deps: UiServiceDeps = {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
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
    costSummary: async (projectId?: string | null) => {
      capturedProjectId = projectId;
      return { today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} };
    },
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
  };

  await handleCostSummary(deps, { projectId: 'proj1' });
  assert.equal(capturedProjectId, 'proj1');
});
