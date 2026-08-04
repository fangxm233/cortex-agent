import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleTaskVerification } from '../../../src/domain/ui-service/query/task-verification.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const iso = (ms: number) => new Date(ms).toISOString();
const t0 = Date.parse('2026-06-01T00:00:00Z');

// Neutral placeholder project/task ids only (守则11). Task store raw records (snake_case fields).
const mockTasks: Record<string, any> = {
  // Completed task with a completion note + completed-at + a completing dispatch execution.
  done1: {
    id: 'done1', text: 'Ship the atlas widget', project: 'atlas', status: 'done',
    priority: 'high', done_when: 'tests green + merged', completed_at: iso(t0 + 90000),
    completed_note: 'merged; suite green', claimed_by: 'agent1', blocked_by: null,
    paused: false, depends_on: [],
  },
  // Open task, never completed, never dispatched.
  open1: {
    id: 'open1', text: 'Draft the nimbus plan', project: 'nimbus', status: 'open',
    priority: 'medium', done_when: 'plan written', completed_at: null, completed_note: null,
    claimed_by: null, blocked_by: null, paused: false, depends_on: [],
  },
  // Completed task with NO linked execution (e.g. cortex-task CLI completion) and empty done_when.
  done2: {
    id: 'done2', text: 'Tidy orchard docs', project: 'orchard', status: 'done',
    priority: 'low', done_when: '', completed_at: iso(t0 + 5000),
    completed_note: 'done by hand', claimed_by: null, blocked_by: null, paused: false, depends_on: [],
  },
};

// Executions joined by dispatch.taskId. done1 has three: an older completed, a failed retry, and the
// most-recent completed (the "completing" one). open1 has none.
const mockExecutions = [
  {
    id: 'exec_done1_a', kind: 'dispatch', status: 'completed', project: 'atlas',
    thread: { threadId: 'thr_a' }, dispatch: { taskId: 'done1', machine: 'server-nvidia' },
    runtime: { startedAt: iso(t0), updatedAt: iso(t0 + 10000), endedAt: iso(t0 + 10000) },
    metrics: { costUsd: 0.02 }, text: { finalOutput: 'first attempt output', error: null },
  },
  {
    id: 'exec_done1_b', kind: 'dispatch', status: 'failed', project: 'atlas',
    thread: { threadId: 'thr_b' }, dispatch: { taskId: 'done1', machine: 'lab-ksu' },
    runtime: { startedAt: iso(t0 + 20000), updatedAt: iso(t0 + 25000), endedAt: iso(t0 + 25000) },
    metrics: { costUsd: 0.01 }, text: { finalOutput: null, error: 'boom' },
  },
  {
    id: 'exec_done1_c', kind: 'dispatch', status: 'completed', project: 'atlas',
    thread: { threadId: 'thr_c' }, dispatch: { taskId: 'done1', machine: 'server-nvidia' },
    runtime: { startedAt: iso(t0 + 80000), updatedAt: iso(t0 + 90000), endedAt: iso(t0 + 90000) },
    metrics: { costUsd: 0.05 }, text: { finalOutput: 'final merged output', error: null },
  },
  // Unrelated execution — must never be joined.
  {
    id: 'exec_other', kind: 'local', status: 'running', project: 'nimbus',
    thread: { threadId: 'thr_x' }, dispatch: { taskId: 'someone-else' },
    runtime: { startedAt: iso(t0 + 1000), updatedAt: iso(t0 + 1000), endedAt: null },
    metrics: { costUsd: null }, text: { finalOutput: null, error: null },
  },
  {
    id: 'exec_no_dispatch', kind: 'local', status: 'running', project: 'nimbus',
    thread: { threadId: 'thr_y' }, dispatch: null,
    runtime: { startedAt: iso(t0 + 2000), updatedAt: iso(t0 + 2000), endedAt: null },
    metrics: { costUsd: null }, text: { finalOutput: null, error: null },
  },
];

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => Object.values(mockTasks), getById: (id: string) => mockTasks[id] ?? null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: (id: string) => mockExecutions.find(e => e.id === id) ?? null, getAll: () => mockExecutions, cancelExecution: () => null },
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
    adapter: { getProjectConduits: async () => ({}) } as any,
    ...overrides,
  };
}

test('tasks.verification: completed task exposes real completed-note / completed-at evidence', async () => {
  const r = await handleTaskVerification(makeDeps(), { projectId: 'atlas', taskId: 'done1' });
  assert.equal(r.taskId, 'done1');
  assert.equal(r.project, 'atlas');
  assert.equal(r.evidence.completed, true);
  assert.equal(r.evidence.doneWhen, 'tests green + merged');
  assert.equal(r.evidence.completedAt, iso(t0 + 90000));
  assert.equal(r.evidence.completedNote, 'merged; suite green');
});

test('tasks.verification: completing execution = most-recent TERMINAL execution joined by taskId', async () => {
  const r = await handleTaskVerification(makeDeps(), { projectId: 'atlas', taskId: 'done1' });
  assert.equal(r.evidence.completingExecutionId, 'exec_done1_c');
  assert.equal(r.evidence.completingOutput, 'final merged output');
});

test('tasks.verification: dispatch history is the full per-task join, newest first', async () => {
  const r = await handleTaskVerification(makeDeps(), { projectId: 'atlas', taskId: 'done1' });
  assert.deepEqual(r.dispatches.map(d => d.executionId), ['exec_done1_c', 'exec_done1_b', 'exec_done1_a']);
  const c = r.dispatches[0];
  assert.equal(c.type, 'dispatch');
  assert.equal(c.status, 'completed');
  assert.equal(c.machine, 'server-nvidia');
  assert.equal(c.threadId, 'thr_c');
  assert.equal(c.durationMs, 10000);
  assert.equal(c.cost, 0.05);
  // never joins unrelated / null-dispatch executions
  assert.ok(!r.dispatches.some(d => d.executionId === 'exec_other' || d.executionId === 'exec_no_dispatch'));
});

test('tasks.verification: open task → honest null evidence + empty dispatches (no fabrication)', async () => {
  const r = await handleTaskVerification(makeDeps(), { projectId: 'nimbus', taskId: 'open1' });
  assert.equal(r.evidence.completed, false);
  assert.equal(r.evidence.completedAt, null);
  assert.equal(r.evidence.completedNote, null);
  assert.equal(r.evidence.completingExecutionId, null);
  assert.equal(r.evidence.completingOutput, null);
  assert.equal(r.evidence.doneWhen, 'plan written');
  assert.deepEqual(r.dispatches, []);
});

test('tasks.verification: completed task with no linked execution → note kept, completing null', async () => {
  const r = await handleTaskVerification(makeDeps(), { projectId: 'orchard', taskId: 'done2' });
  assert.equal(r.evidence.completed, true);
  assert.equal(r.evidence.completedNote, 'done by hand');
  assert.equal(r.evidence.completedAt, iso(t0 + 5000));
  assert.equal(r.evidence.completingExecutionId, null);
  assert.equal(r.evidence.completingOutput, null);
  assert.equal(r.evidence.doneWhen, null); // empty done_when → honest null
  assert.deepEqual(r.dispatches, []);
});

test('tasks.verification: unknown task id → not-found', async () => {
  await assert.rejects(
    () => handleTaskVerification(makeDeps(), { projectId: 'atlas', taskId: 'ghost' }),
    (e: any) => e.code === 'not-found',
  );
});

test('tasks.verification: project mismatch → not-found (no cross-project leak)', async () => {
  await assert.rejects(
    () => handleTaskVerification(makeDeps(), { projectId: 'nimbus', taskId: 'done1' }),
    (e: any) => e.code === 'not-found',
  );
});
