import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleExecutionsList } from '../../../src/domain/ui-service/query/executions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const now = Date.now();
const mockExecutions = [
  {
    id: 'exec_1', kind: 'local', status: 'running', channel: 'C1', project: 'proj1',
    source: { trigger: 'message' }, backend: 'claude', billingMode: 'api',
    session: { sessionId: 's1' }, thread: null, dispatch: null, scheduleTaskId: null,
    runtime: { startedAt: new Date(now - 60000).toISOString(), updatedAt: new Date().toISOString(), endedAt: null },
    metrics: { costUsd: null, numTurns: null, durationS: null },
    text: { label: 'test1', finalOutput: null, error: null },
  },
  {
    id: 'exec_2', kind: 'dispatch', status: 'completed', channel: 'C2', project: 'proj2',
    source: { trigger: 'dispatch' }, backend: 'pi', billingMode: 'api',
    session: { sessionId: 's2' }, thread: null,
    dispatch: { taskId: 't1', machine: 'server1' }, scheduleTaskId: 'sch1',
    runtime: { startedAt: new Date(now - 120000).toISOString(), updatedAt: new Date(now - 1000).toISOString(), endedAt: new Date(now - 1000).toISOString() },
    metrics: { costUsd: 0.05, numTurns: 3, durationS: 119 },
    text: { label: 'dispatch-task', finalOutput: 'done', error: null },
  },
  {
    id: 'exec_3', kind: 'local', status: 'failed', channel: 'C3', project: 'proj1',
    source: { trigger: 'message' }, backend: 'claude', billingMode: 'api',
    session: { sessionId: null }, thread: { threadId: 'thr_1', agentSlotId: 'main' }, dispatch: null, scheduleTaskId: null,
    runtime: { startedAt: new Date(now - 300000).toISOString(), updatedAt: new Date(now - 200000).toISOString(), endedAt: new Date(now - 200000).toISOString() },
    metrics: { costUsd: null, numTurns: null, durationS: null },
    text: { label: null, finalOutput: null, error: 'something broke' },
  },
];

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => mockExecutions, cancelExecution: () => null },
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

test('executions.list returns all executions when no filter', async () => {
  const result = await handleExecutionsList(makeDeps(), {});
  assert.equal(result.length, 3);
});

test('executions.list filters by status', async () => {
  const result = await handleExecutionsList(makeDeps(), { status: ['running', 'failed'] });
  assert.equal(result.length, 2);
  assert.ok(result.every(e => e.status === 'running' || e.status === 'failed'));
});

test('executions.list respects limit', async () => {
  const result = await handleExecutionsList(makeDeps(), { limit: 2 });
  assert.equal(result.length, 2);
});

test('executions.list sorts by startedAt descending', async () => {
  const result = await handleExecutionsList(makeDeps(), {});
  assert.ok(result[0].startedAt >= result[result.length - 1].startedAt);
});

test('executions.list DTO shape for dispatch execution', async () => {
  const result = await handleExecutionsList(makeDeps(), { status: ['completed'] });
  assert.equal(result.length, 1);
  const e = result[0];
  assert.equal(e.id, 'exec_2');
  assert.equal(e.type, 'dispatch');
  assert.equal(e.status, 'completed');
  assert.equal(e.taskId, 't1');
  assert.equal(e.machine, 'server1');
  assert.equal(e.projectId, 'proj2');
  assert.ok(e.durationMs! > 0);
  assert.equal(e.cost, 0.05);
});

test('executions.list DTO shape for running execution', async () => {
  const result = await handleExecutionsList(makeDeps(), { status: ['running'] });
  assert.equal(result.length, 1);
  const e = result[0];
  assert.equal(e.type, 'local');
  assert.equal(e.sessionId, 's1');
  assert.equal(e.finishedAt, null);
  assert.equal(e.durationMs, null);
  assert.equal(e.cost, null);
});
