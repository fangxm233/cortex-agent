import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleExecutionsGet } from '../../../src/domain/ui-service/query/executions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const now = Date.now();
const knownRecord = {
  id: 'exec_known', kind: 'dispatch', status: 'completed', channel: 'C2', project: 'proj2',
  source: { trigger: 'dispatch' }, backend: 'pi', billingMode: 'api',
  session: { sessionId: 's2' }, thread: { threadId: 'thr_9', agentSlotId: 'main' },
  dispatch: {
    taskId: 't1', taskHash: 'h1', machine: 'server1', scheduleTaskId: 'sch1',
    sessionName: 'sess-1', tmuxName: 'tmux-1', pid: '4242',
  },
  scheduleTaskId: 'sch1',
  runtime: {
    startedAt: new Date(now - 120000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    endedAt: new Date(now - 1000).toISOString(),
  },
  metrics: { costUsd: 0.05, numTurns: 3, durationS: 119 },
  text: { label: 'dispatch-task', finalOutput: 'done', error: null },
};

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: {
      getExecution: (id: string) => (id === 'exec_known' ? knownRecord : null),
      getAll: () => [knownRecord],
      cancelExecution: () => null,
    },
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
    adapter: { getProjectConduits: async () => ({}) } as any,
    ...overrides,
  };
}

test('executions.get handler maps real ExecutionRecord fields into the detail DTO', async () => {
  const dto = await handleExecutionsGet(makeDeps(), { executionId: 'exec_known' });
  assert.equal(dto.id, 'exec_known');
  assert.equal(dto.type, 'dispatch');
  assert.equal(dto.kind, 'dispatch');
  assert.equal(dto.status, 'completed');
  assert.equal(dto.projectId, 'proj2');
  assert.equal(dto.sessionId, 's2');
  assert.equal(dto.threadId, 'thr_9');
  assert.equal(dto.runtime.startedAt, knownRecord.runtime.startedAt);
  assert.equal(dto.runtime.updatedAt, knownRecord.runtime.updatedAt);
  assert.equal(dto.runtime.endedAt, knownRecord.runtime.endedAt);
  assert.deepEqual(dto.dispatch, {
    taskId: 't1', machine: 'server1', pid: '4242',
    tmuxName: 'tmux-1', sessionName: 'sess-1', scheduleTaskId: 'sch1',
  });
  assert.deepEqual(dto.metrics, { costUsd: 0.05, numTurns: 3, durationS: 119 });
  assert.deepEqual(dto.text, { label: 'dispatch-task', finalOutput: 'done', error: null });
});

test('executions.get handler throws not-found for an unknown id', async () => {
  await assert.rejects(
    () => handleExecutionsGet(makeDeps(), { executionId: 'missing' }),
    (e: any) => e?.code === 'not-found',
  );
});
