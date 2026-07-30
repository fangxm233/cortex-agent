// input:  UI-service dependencies and task-store fixtures
// output: Task list filters, fields, and completion time regressions
// pos:    UI task query contract tests
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleTasksList } from '../../../src/domain/ui-service/query/tasks.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const mockTasks = [
  { id: 't1', text: 'Task one', project: 'proj1', status: 'open', priority: 'high', claimed_by: null, blocked_by: null, paused: false, approval_needed: true, approved_at: null, depends_on: [], plan: 'plan1', template: 'coder-review', why: 'because one', done_when: 'tests green' },
  { id: 't2', text: 'Task two', project: 'proj1', status: 'open', priority: 'medium', claimed_by: 'agent1', blocked_by: null, paused: false, approval_needed: false, approved_at: '2026-07-30', depends_on: ['t1'], plan: null, template: 'research', why: '', done_when: '' },
  { id: 't3', text: 'Task three', project: 'proj1', status: 'done', priority: 'low', claimed_by: 'agent1', blocked_by: null, paused: false, depends_on: [], plan: 'plan3', template: 'bugfix', why: 'because three', done_when: 'shipped', completed_at: '2026-07-30T16:00:00.000Z' },
  { id: 't4', text: 'Blocked task', project: 'proj2', status: 'open', priority: 'high', claimed_by: null, blocked_by: 'something', paused: false, depends_on: [], plan: null, template: 'coder-review' },
];

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: (project?: string) => project ? mockTasks.filter(t => t.project === project) : mockTasks, getById: () => null, load: () => {}, refresh: () => {} },
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

test('tasks.list returns all tasks when no filter', async () => {
  const result = await handleTasksList(makeDeps(), {});
  assert.equal(result.length, 4);
});

test('tasks.list filters by projectId', async () => {
  const result = await handleTasksList(makeDeps(), { projectId: 'proj2' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 't4');
});

test('tasks.list filters by status', async () => {
  const result = await handleTasksList(makeDeps(), { status: 'done' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 't3');
  assert.equal(result[0].status, 'done');
});

test('tasks.list filters by actionable', async () => {
  const result = await handleTasksList(makeDeps(), { actionable: true });
  // Only t1 is open, unclaimed, unblocked, unpaused
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 't1');
  assert.equal(result[0].actionable, true);
});

test('tasks.list non-actionable filter', async () => {
  const result = await handleTasksList(makeDeps(), { actionable: false });
  assert.equal(result.length, 3);
  assert.ok(result.every(t => t.actionable === false));
});

test('tasks.list DTO shape is correct', async () => {
  const result = await handleTasksList(makeDeps(), { projectId: 'proj1' });
  const t1 = result.find(t => t.id === 't1')!;
  assert.equal(t1.text, 'Task one');
  assert.equal(t1.project, 'proj1');
  assert.equal(t1.priority, 'high');
  assert.equal(t1.claimedBy, null);
  assert.equal(t1.blockedBy, null);
  assert.deepEqual(t1.dependsOn, []);
  assert.equal(t1.plan, 'plan1');
  assert.equal(t1.template, 'coder-review');
});

test('tasks.list exposes real why + doneWhen from the task store', async () => {
  const result = await handleTasksList(makeDeps(), { projectId: 'proj1' });
  const t1 = result.find(t => t.id === 't1')!;
  assert.equal(t1.why, 'because one');
  assert.equal(t1.doneWhen, 'tests green');
});

test('tasks.list exposes pending and completed approval state', async () => {
  const result = await handleTasksList(makeDeps(), { projectId: 'proj1' });
  const t1 = result.find(t => t.id === 't1')!;
  const t2 = result.find(t => t.id === 't2')!;
  assert.equal(t1.approvalNeeded, true);
  assert.equal(t1.approvedAt, null);
  assert.equal(t2.approvalNeeded, false);
  assert.equal(t2.approvedAt, '2026-07-30');
});

test('tasks.list maps empty why/done_when to null (null-safe)', async () => {
  const result = await handleTasksList(makeDeps(), { projectId: 'proj1' });
  const t2 = result.find(t => t.id === 't2')!;
  assert.equal(t2.why, null);
  assert.equal(t2.doneWhen, null);
});

test('tasks.list maps absent why/done_when to null', async () => {
  const result = await handleTasksList(makeDeps(), { projectId: 'proj2' });
  const t4 = result.find(t => t.id === 't4')!;
  assert.equal(t4.why, null);
  assert.equal(t4.doneWhen, null);
});

test('tasks.list exposes completion time and maps absent values to null', async () => {
  const result = await handleTasksList(makeDeps(), { projectId: 'proj1' });
  assert.equal(result.find((task) => task.id === 't3')!.completedAt, '2026-07-30T16:00:00.000Z');
  assert.equal(result.find((task) => task.id === 't1')!.completedAt, null);
});
