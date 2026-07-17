import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleThreadsGet } from '../../../src/domain/ui-service/query/threads.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

// A 6-level chain (root + 6 descendants) to exercise the ≤5-level depth cap, plus a
// running thread with one completed step + a synthesized active step, machine dispatches,
// and a rate_limited thread for status mapping.
const iso = (ms: number) => new Date(ms).toISOString();
const t0 = Date.parse('2026-06-01T00:00:00Z');

const threads: Record<string, any> = {
  thr_root: {
    id: 'thr_root', templateName: 'manager', status: 'running', channel: 'C1',
    projectId: 'proj1', createdAt: iso(t0), updatedAt: iso(t0 + 5000), endedAt: null,
    error: null, abortReason: null,
    currentStepIndex: 1, activeAgent: 'reviewer', activeStage: 'review',
    steps: [
      {
        stepIndex: 0, agentSlotId: 'coder', stage: null, executionId: 'exec_root_0',
        sessionId: 's-coder', sessionName: 'cortex-coder', input: 'do the thing',
        output: 'x'.repeat(500), costUsd: 0.02, numTurns: 4, durationS: 12,
        startedAt: iso(t0), endedAt: iso(t0 + 12000),
      },
    ],
    agents: {
      reviewer: {
        slotId: 'reviewer', profile: 'reviewer-profile', sessionId: 's-rev',
        sessionName: 'cortex-rev', status: 'running', lastOutput: 'reviewing now',
        persistSession: false,
      },
    },
    totalCostUsd: 0.02, workspacePath: '/tmp/threads/thr_root',
    artifactPath: '/tmp/threads/thr_root/artifact.md',
    metadata: { childThreadIds: ['thr_l1'], taskId: 'ab12', taskProject: 'cortex-self' },
  },
  thr_l1: { id: 'thr_l1', templateName: 'coder-review', status: 'completed', projectId: 'proj1', createdAt: iso(t0 + 100), updatedAt: iso(t0 + 200), endedAt: iso(t0 + 200), error: null, abortReason: null, currentStepIndex: 0, activeAgent: 'coder', activeStage: null, steps: [], agents: {}, totalCostUsd: 0.5, workspacePath: '/tmp/threads/thr_l1', artifactPath: null, metadata: { parentThreadId: 'thr_root', childThreadIds: ['thr_l2'], taskId: 'cd34', taskProject: 'cortex-self' } },
  thr_l2: { id: 'thr_l2', templateName: 'coder-review', status: 'completed', projectId: 'proj1', createdAt: iso(t0 + 300), updatedAt: iso(t0 + 400), endedAt: iso(t0 + 400), error: null, abortReason: null, currentStepIndex: 0, activeAgent: 'coder', activeStage: null, steps: [], agents: {}, totalCostUsd: 0.1, workspacePath: '/x', artifactPath: null, metadata: { parentThreadId: 'thr_l1', childThreadIds: ['thr_l3'] } },
  thr_l3: { id: 'thr_l3', templateName: 'coder-review', status: 'completed', projectId: 'proj1', createdAt: iso(t0 + 500), updatedAt: iso(t0 + 600), endedAt: iso(t0 + 600), error: null, abortReason: null, currentStepIndex: 0, activeAgent: 'coder', activeStage: null, steps: [], agents: {}, totalCostUsd: 0.1, workspacePath: '/x', artifactPath: null, metadata: { parentThreadId: 'thr_l2', childThreadIds: ['thr_l4'] } },
  thr_l4: { id: 'thr_l4', templateName: 'coder-review', status: 'completed', projectId: 'proj1', createdAt: iso(t0 + 700), updatedAt: iso(t0 + 800), endedAt: iso(t0 + 800), error: null, abortReason: null, currentStepIndex: 0, activeAgent: 'coder', activeStage: null, steps: [], agents: {}, totalCostUsd: 0.1, workspacePath: '/x', artifactPath: null, metadata: { parentThreadId: 'thr_l3', childThreadIds: ['thr_l5'] } },
  thr_l5: { id: 'thr_l5', templateName: 'coder-review', status: 'completed', projectId: 'proj1', createdAt: iso(t0 + 900), updatedAt: iso(t0 + 1000), endedAt: iso(t0 + 1000), error: null, abortReason: null, currentStepIndex: 0, activeAgent: 'coder', activeStage: null, steps: [], agents: {}, totalCostUsd: 0.1, workspacePath: '/x', artifactPath: null, metadata: { parentThreadId: 'thr_l4', childThreadIds: ['thr_l6'] } },
  thr_l6: { id: 'thr_l6', templateName: 'coder-review', status: 'completed', projectId: 'proj1', createdAt: iso(t0 + 1100), updatedAt: iso(t0 + 1200), endedAt: iso(t0 + 1200), error: null, abortReason: null, currentStepIndex: 0, activeAgent: 'coder', activeStage: null, steps: [], agents: {}, totalCostUsd: 0.1, workspacePath: '/x', artifactPath: null, metadata: { parentThreadId: 'thr_l5', childThreadIds: [] } },
  thr_rl: { id: 'thr_rl', templateName: 'coder-review', status: 'rate_limited', projectId: 'proj1', createdAt: iso(t0), updatedAt: iso(t0), endedAt: null, error: null, abortReason: null, currentStepIndex: 0, activeAgent: 'coder', activeStage: null, steps: [], agents: {}, totalCostUsd: 0, workspacePath: '/x', artifactPath: null, metadata: {} },
  // self-referential cycle guard
  thr_cycle: { id: 'thr_cycle', templateName: 'x', status: 'running', projectId: 'proj1', createdAt: iso(t0), updatedAt: iso(t0), endedAt: null, error: null, abortReason: null, currentStepIndex: 0, activeAgent: null, activeStage: null, steps: [], agents: {}, totalCostUsd: 0, workspacePath: '/x', artifactPath: null, metadata: { childThreadIds: ['thr_cycle'] } },
};

const mockExecutions = [
  {
    id: 'exec_root_0', kind: 'dispatch', status: 'completed', channel: 'C1', project: 'proj1',
    source: { trigger: 'dispatch' }, backend: 'claude', billingMode: 'api',
    session: { sessionId: 's-coder' }, thread: { threadId: 'thr_root', agentSlotId: 'coder' },
    dispatch: { taskId: 'ab12', machine: 'server-nvidia' }, scheduleTaskId: null,
    runtime: { startedAt: iso(t0), updatedAt: iso(t0 + 12000), endedAt: iso(t0 + 12000) },
    metrics: { costUsd: 0.02, numTurns: 4, durationS: 12 },
    text: { label: 'coder step', finalOutput: 'done', error: null },
  },
  {
    id: 'exec_other', kind: 'local', status: 'running', channel: 'C9', project: 'proj9',
    source: { trigger: 'message' }, backend: 'claude', billingMode: 'api',
    session: { sessionId: 's9' }, thread: { threadId: 'thr_unrelated', agentSlotId: 'main' },
    dispatch: null, scheduleTaskId: null,
    runtime: { startedAt: iso(t0), updatedAt: iso(t0), endedAt: null },
    metrics: { costUsd: null, numTurns: null, durationS: null },
    text: { label: null, finalOutput: null, error: null },
  },
];

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => Object.values(threads), get: (id: string) => threads[id] ?? null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: (id: string) => mockExecutions.find(e => e.id === id) ?? null, getAll: () => mockExecutions, cancelExecution: () => null },
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

test('threads.get throws for unknown thread id', async () => {
  await assert.rejects(() => handleThreadsGet(makeDeps(), { threadId: 'nope' }), /not found/i);
});

test('threads.get returns summary superset fields', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_root' });
  assert.equal(d.id, 'thr_root');
  assert.equal(d.templateName, 'manager');
  assert.equal(d.status, 'running');
  assert.equal(d.projectId, 'proj1');
  assert.equal(d.totalCostUsd, 0.02);
  assert.equal(d.artifactPath, '/tmp/threads/thr_root/artifact.md');
  assert.equal(d.activeAgent, 'reviewer');
  assert.equal(d.activeStage, 'review');
  assert.deepEqual(d.currentStep, { index: 1, name: 'step-1' });
});

test('threads.get maps completed steps and synthesizes the active running step', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_root' });
  assert.equal(d.steps.length, 2);
  const done = d.steps[0];
  assert.equal(done.stepIndex, 0);
  assert.equal(done.agentSlotId, 'coder');
  assert.equal(done.status, 'completed');
  assert.equal(done.executionId, 'exec_root_0');
  assert.equal(done.costUsd, 0.02);
  assert.equal(done.durationS, 12);
  assert.equal(done.endedAt, iso(t0 + 12000));
  assert.ok(done.outputSummary && done.outputSummary.length <= 200);

  const active = d.steps[1];
  assert.equal(active.stepIndex, 1);
  assert.equal(active.agentSlotId, 'reviewer');
  assert.equal(active.stage, 'review');
  assert.equal(active.status, 'running');
  assert.equal(active.endedAt, null);
  assert.equal(active.outputSummary, 'reviewing now');
});

test('threads.get surfaces the active agent flow', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_root' });
  assert.ok(d.agentFlow);
  assert.equal(d.agentFlow!.slotId, 'reviewer');
  assert.equal(d.agentFlow!.profile, 'reviewer-profile');
  assert.equal(d.agentFlow!.status, 'running');
  assert.equal(d.agentFlow!.stage, 'review');
  assert.equal(d.agentFlow!.lastOutput, 'reviewing now');
});

test('threads.get agentFlow is null for a terminal thread with no active slot', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_l1' });
  assert.equal(d.agentFlow, null);
});

test('threads.get joins machine dispatches by threadId, excluding unrelated executions', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_root' });
  assert.equal(d.dispatches.length, 1);
  const disp = d.dispatches[0];
  assert.equal(disp.executionId, 'exec_root_0');
  assert.equal(disp.machine, 'server-nvidia');
  assert.equal(disp.type, 'dispatch');
  assert.equal(disp.agentSlotId, 'coder');
  assert.equal(disp.taskId, 'ab12');
  assert.equal(disp.cost, 0.02);
  assert.ok(disp.durationMs && disp.durationMs > 0);
});

test('threads.get builds a nested child tree capped at 5 levels', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_root' });
  // depth 0..4 = thr_l1..thr_l5 (5 levels); thr_l6 (would be depth 5) is cut
  assert.equal(d.children.length, 1);
  let node = d.children[0];
  assert.equal(node.id, 'thr_l1');
  assert.equal(node.depth, 0);
  const chain = ['thr_l1', 'thr_l2', 'thr_l3', 'thr_l4', 'thr_l5'];
  for (let i = 0; i < chain.length; i++) {
    assert.equal(node.id, chain[i]);
    assert.equal(node.depth, i);
    if (i < chain.length - 1) {
      assert.equal(node.truncated, false);
      assert.equal(node.children.length, 1);
      node = node.children[0];
    }
  }
  // deepest included node (thr_l5, depth 4) had an unspawned child → truncated
  assert.equal(node.id, 'thr_l5');
  assert.equal(node.depth, 4);
  assert.equal(node.children.length, 0);
  assert.equal(node.truncated, true);
});

test('threads.get child node carries status/template/cost/taskId', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_root' });
  const l1 = d.children[0];
  assert.equal(l1.templateName, 'coder-review');
  assert.equal(l1.status, 'completed');
  assert.equal(l1.costUsd, 0.5);
  assert.equal(l1.taskId, 'cd34');
});

test('threads.get child tree terminates on a self-referential cycle', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_cycle' });
  // must not infinite-loop; cycle child is dropped once seen
  assert.ok(Array.isArray(d.children));
});

test('threads.get surfaces thread-level artifact refs', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_root' });
  assert.equal(d.artifacts.artifactPath, '/tmp/threads/thr_root/artifact.md');
  assert.equal(d.artifacts.workspacePath, '/tmp/threads/thr_root');
  assert.equal(d.artifacts.taskId, 'ab12');
  assert.equal(d.artifacts.taskProject, 'cortex-self');
});

test('threads.get maps rate_limited status to waiting', async () => {
  const d = await handleThreadsGet(makeDeps(), { threadId: 'thr_rl' });
  assert.equal(d.status, 'waiting');
});
