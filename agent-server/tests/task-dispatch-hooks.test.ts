// input:  dispatch job, settings, CPU topology, task doubles
// output: limit policy, hook, quarantine, and recovery tests
// pos:    Task dispatch lifecycle behavioral regressions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  emitCortexEvent: vi.fn(),
  getRunningExecutions: vi.fn(),
  cpus: vi.fn(),
  selectAndClaimTask: vi.fn(),
  updateScheduleInterval: vi.fn(),
  generateSessionName: vi.fn(),
  createThread: vi.fn(),
  runThread: vi.fn(),
  processAbortOutcome: vi.fn(),
  processSplitOutcome: vi.fn(),
  finalizeThreadSuccess: vi.fn(),
  refreshTasks: vi.fn(),
  getTaskById: vi.fn(),
  readArtifact: vi.fn(),
  getTemplate: vi.fn(),
  getThread: vi.fn(),
  mutateThread: vi.fn(),
  add: vi.fn(),
  unclaim: vi.fn(),
  block: vi.fn(),
  logError: vi.fn(),
  settings: { taskDispatchMaxConcurrent: null as number | null },
}));

vi.mock('@core/settings.js', () => ({
  getSettings: () => deps.settings,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, cpus: deps.cpus };
});

vi.mock('@core/log.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: deps.logError,
  }),
}));

vi.mock('@core/hook-bus.js', () => ({
  emitCortexEvent: deps.emitCortexEvent,
}));

vi.mock('../src/domain/executions/registry.js', () => ({
  getRunningExecutions: deps.getRunningExecutions,
  cancelExecutionByTaskId: vi.fn(),
}));

vi.mock('../src/domain/tasks/dispatcher.js', () => ({
  selectAndClaimTask: deps.selectAndClaimTask,
  computeNextInterval: vi.fn(() => 60_000),
  updateScheduleInterval: deps.updateScheduleInterval,
}));

vi.mock('@store/session-registry-repo.js', () => ({
  sessionStore: { generateSessionName: deps.generateSessionName },
}));

vi.mock('../src/domain/threads/index.js', () => ({
  createThread: deps.createThread,
  detectSplitFromControl: vi.fn(),
  clearPendingControl: vi.fn(),
  readArtifact: deps.readArtifact,
  getTemplate: deps.getTemplate,
}));

vi.mock('../src/domain/tasks/store.js', () => ({
  taskStore: { refresh: deps.refreshTasks, getById: deps.getTaskById },
}));

vi.mock('@store/thread-repo.js', () => ({
  threadStore: { get: deps.getThread, mutate: deps.mutateThread },
}));

vi.mock('../src/domain/threads/runner.js', () => ({
  runThread: deps.runThread,
}));

vi.mock('../src/domain/tasks/dispatch-utils.js', () => ({
  processAbortOutcome: deps.processAbortOutcome,
  processSplitOutcome: deps.processSplitOutcome,
  formatWorkerAbortReason: vi.fn(),
}));

vi.mock('../src/domain/scheduling/jobs/_shared.js', () => ({
  finalizeThreadSuccess: deps.finalizeThreadSuccess,
}));

vi.mock('../src/domain/tasks/mutator.js', () => ({
  taskMutator: { add: deps.add, unclaim: deps.unclaim, block: deps.block },
}));

import { ctx } from '../src/domain/scheduling/job-registry.js';
import { taskDispatchRunner } from '../src/domain/scheduling/jobs/task-dispatch.js';

const selected = {
  task: {
    id: 'task-1',
    project: 'atlas',
    text: 'Run the queued implementation',
    template: 'coder-review',
    plan: 'plans/review.md',
  },
  template: 'coder-review',
  prompt: 'Implement the queued task',
};

let threadRecord: Record<string, any>;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function completedCycleCount(): number {
  return (ctx.bus!.publish as any).mock.calls.filter(
    ([event]: [{ type: string; delta?: number }]) => event.type === 'llm.active-count-delta' && event.delta === -1,
  ).length;
}

async function runDispatchCycle(): Promise<void> {
  const completedBefore = completedCycleCount();
  taskDispatchRunner({ channel: 'atlas', scheduleTaskId: 'schedule-1', profileName: 'execute' });
  await waitFor(() => completedCycleCount() === completedBefore + 1);
}

function selectFixture(id: string): void {
  deps.selectAndClaimTask.mockResolvedValue({
    ...selected,
    task: { ...selected.task, id },
  });
}

beforeEach(() => {
  for (const [key, mock] of Object.entries(deps)) {
    if (key !== 'settings') (mock as ReturnType<typeof vi.fn>).mockReset();
  }
  deps.settings.taskDispatchMaxConcurrent = null;
  deps.cpus.mockReturnValue(Array.from({ length: 8 }, () => ({})));
  threadRecord = {
    id: 'thread-1',
    templateName: 'coder-review',
    artifactPath: '/tmp/thread-artifact.md',
    activeAgent: 'coder-reviewer',
    activeStage: 'implReview',
    metadata: {},
  };
  deps.emitCortexEvent.mockResolvedValue([]);
  deps.getRunningExecutions.mockReturnValue([]);
  deps.selectAndClaimTask.mockResolvedValue(selected);
  deps.generateSessionName.mockResolvedValue('cortex-test');
  deps.createThread.mockReturnValue({ id: 'thread-1' });
  deps.runThread.mockResolvedValue({
    thread: { status: 'waiting', metadata: { waitingOn: [], waitingOnTasks: [] } },
    lastAgentResult: null,
  });
  deps.processAbortOutcome.mockResolvedValue({ handled: false });
  deps.processSplitOutcome.mockResolvedValue({ handled: false });
  deps.finalizeThreadSuccess.mockResolvedValue(undefined);
  deps.getTaskById.mockReturnValue({ ...selected.task, status: 'open' });
  deps.getThread.mockImplementation(() => threadRecord);
  deps.mutateThread.mockImplementation(async (_id, mutate) => { mutate(threadRecord); });
  deps.readArtifact.mockReturnValue('');
  deps.getTemplate.mockReturnValue({
    transitions: [
      { condition: { type: 'convergence', marker: '[IMPL-APPROVED]' } },
      { condition: { type: 'output_not_contains', pattern: '\\[REVISED\\]' } },
    ],
  });
  deps.add.mockResolvedValue({ success: true, task_id: 'followup-1' });
  deps.unclaim.mockResolvedValue({ success: true });
  deps.block.mockResolvedValue({ success: true });

  ctx.adapter = {
    postMessage: vi.fn().mockResolvedValue(null),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  ctx.schedulerRef = null;
  ctx.bus = { publish: vi.fn() } as any;
  ctx.buildInteractiveCallbacks = null;
  ctx.onThreadSuspended = null;
});

afterEach(() => {
  ctx.adapter = null;
  ctx.schedulerRef = null;
  ctx.bus = null;
  ctx.buildInteractiveCallbacks = null;
  ctx.onThreadSuspended = null;
});

test('runtime concurrency-limit flip affects the next dispatch guard evaluation', async () => {
  deps.getRunningExecutions.mockReturnValue([{ kind: 'dispatch' }]);
  deps.settings.taskDispatchMaxConcurrent = 1;

  taskDispatchRunner({ channel: 'atlas', scheduleTaskId: 'schedule-1', profileName: 'execute' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (deps.selectAndClaimTask.mock.calls.length > 0) await waitFor(() => completedCycleCount() === 1);
  assert.equal(deps.selectAndClaimTask.mock.calls.length, 0, 'the initial limit blocks dispatch');

  deps.settings.taskDispatchMaxConcurrent = 2;
  await runDispatchCycle();
  assert.equal(deps.runThread.mock.calls.length, 1, 'the next evaluation uses the higher live limit');
});

test.each([
  { cpuCount: 8, automaticLimit: 6 },
  { cpuCount: 2, automaticLimit: 4 },
])('null concurrency uses limit $automaticLimit for $cpuCount CPUs', async ({ cpuCount, automaticLimit }) => {
  deps.cpus.mockReturnValue(Array.from({ length: cpuCount }, () => ({})));
  deps.getRunningExecutions.mockReturnValue(
    Array.from({ length: automaticLimit }, () => ({ kind: 'dispatch' })),
  );

  taskDispatchRunner({ channel: 'atlas', scheduleTaskId: 'schedule-1', profileName: 'execute' });
  assert.equal(deps.selectAndClaimTask.mock.calls.length, 0, 'the exact automatic limit blocks dispatch');

  deps.getRunningExecutions.mockReturnValue(
    Array.from({ length: automaticLimit - 1 }, () => ({ kind: 'dispatch' })),
  );
  await runDispatchCycle();
  assert.equal(deps.runThread.mock.calls.length, 1, 'one slot below the automatic limit dispatches');
});

test('claimed dispatch emits cortex:dispatch.started immediately before thread execution', async () => {
  const order: string[] = [];
  deps.emitCortexEvent.mockImplementation(async () => { order.push('emit'); return []; });
  deps.runThread.mockImplementation(async () => {
    order.push('run');
    return {
      thread: { status: 'waiting', metadata: { waitingOn: [], waitingOnTasks: [] } },
      lastAgentResult: null,
    };
  });

  taskDispatchRunner({ channel: 'atlas', scheduleTaskId: 'schedule-1', profileName: 'execute' });
  await waitFor(() => deps.runThread.mock.calls.length === 1);

  assert.deepEqual(deps.emitCortexEvent.mock.calls, [[
    'cortex:dispatch.started',
    {
      taskId: 'task-1',
      project: 'atlas',
      source: 'task-dispatch',
      templateName: 'coder-review',
    },
  ]]);
  assert.deepEqual(order, ['emit', 'run']);
  assert.deepEqual((ctx.bus!.publish as any).mock.calls.slice(1, 3).map(([event]) => event.type), [
    'task.claimed',
    'task.dispatched',
  ]);
});

test('a rejected dispatch hook does not prevent the claimed thread from running', async () => {
  deps.emitCortexEvent.mockRejectedValueOnce(new Error('hook failed'));

  taskDispatchRunner({ channel: 'atlas', scheduleTaskId: 'schedule-1', profileName: 'execute' });
  await waitFor(() => deps.runThread.mock.calls.length === 1);
  await waitFor(() => (ctx.bus!.publish as any).mock.calls.some(([event]) => event.type === 'llm.active-count-delta' && event.delta === -1));

  assert.equal(deps.emitCortexEvent.mock.calls[0]?.[0], 'cortex:dispatch.started');
  assert.equal(deps.runThread.mock.calls[0]?.[0], 'thread-1');
});

test('third consecutive dispatch failure auto-blocks and clears the counter', async () => {
  selectFixture('quarantine-target');
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));

  await runDispatchCycle();
  await runDispatchCycle();
  assert.equal(deps.block.mock.calls.length, 0);

  await runDispatchCycle();
  assert.deepEqual(deps.block.mock.calls, [[
    'quarantine-target',
    'dispatch-failed-3x: provider unavailable',
  ]]);

  deps.block.mockClear();
  await runDispatchCycle();
  await runDispatchCycle();
  assert.equal(deps.block.mock.calls.length, 0);

  await runDispatchCycle();
  assert.equal(deps.block.mock.calls.length, 1);
});

test('successful dispatch resets consecutive failure count', async () => {
  selectFixture('reset-target');
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));

  await runDispatchCycle();
  await runDispatchCycle();

  deps.runThread.mockResolvedValueOnce({
    thread: { status: 'completed', metadata: {} },
    lastAgentResult: null,
  });
  await runDispatchCycle();
  assert.equal(deps.finalizeThreadSuccess.mock.calls.length, 1);

  await runDispatchCycle();
  await runDispatchCycle();
  assert.equal(deps.block.mock.calls.length, 0);

  await runDispatchCycle();
  assert.equal(deps.block.mock.calls.length, 1);
});

test('failed dispatch reconciliation is a no-op when the owning task is not done', async () => {
  selectFixture('owner-open');
  deps.getTaskById.mockReturnValue({ ...selected.task, id: 'owner-open', status: 'open' });
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));

  await runDispatchCycle();

  assert.deepEqual(deps.refreshTasks.mock.calls, [[]]);
  assert.deepEqual(deps.getTaskById.mock.calls, [['owner-open']]);
  assert.equal(deps.readArtifact.mock.calls.length, 0);
  assert.equal(deps.add.mock.calls.length, 0);
  assert.equal(deps.mutateThread.mock.calls.length, 0);
  assert.deepEqual(deps.unclaim.mock.calls, [['owner-open']]);
  const texts = (ctx.adapter!.postMessage as any).mock.calls.map(([, content]) => content.text);
  assert.equal(texts.filter((text) => text.includes('Review reconciliation')).length, 0);
  assert.equal(texts.filter((text) => text.includes('Task dispatch error: provider unavailable')).length, 1);
});

test('failed dispatch creates one review followup and deduplicates a second failure', async () => {
  selectFixture('owner-leak');
  deps.getTaskById.mockReturnValue({ ...selected.task, id: 'owner-leak', status: 'done' });
  deps.readArtifact.mockReturnValue('Prior review: [IMPL-APPROVED]\n## Impl Review\nBlocker: quote shell arguments safely.\n');
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));

  await runDispatchCycle();
  await runDispatchCycle();

  assert.deepEqual(deps.add.mock.calls, [[
    'atlas',
    'Close unresolved review left by failed thread thread-1 on completed task owner-leak',
    'Review artifact: /tmp/thread-artifact.md; failed stage: coder-reviewer:implReview.',
    'Every open Blocker in the failed thread artifact is fixed or explicitly rebutted, and tests scoped to the fixes are green.',
    'high',
    'coder-review',
    [],
    { plan: 'plans/review.md', system: true },
  ]]);
  assert.equal(threadRecord.metadata.reviewLeakFollowupTaskId, 'followup-1');
  assert.equal(deps.mutateThread.mock.calls.length, 1);
  const notices = (ctx.adapter!.postMessage as any).mock.calls.filter(
    ([, content]) => content.text.includes('Review reconciliation'),
  );
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0][0], {
    type: 'project-report', projectId: 'atlas', trigger: 'task-dispatch', sessionId: '',
  });
  assert.match(notices[0][1].text, /followup-1/);
});

test.each([
  ['approval', '## Impl Review\nLooks good. [IMPL-APPROVED]\n'],
  ['revision', '## Implementation Summary\nAll blockers fixed. [REVISED]\n'],
])('terminal %s marker posts a notice without creating a followup', async (_label, artifact) => {
  const owner = `owner-terminal-${_label}`;
  selectFixture(owner);
  deps.getTaskById.mockReturnValue({ ...selected.task, id: owner, status: 'done' });
  deps.readArtifact.mockReturnValue(artifact);
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));

  await runDispatchCycle();

  assert.equal(deps.add.mock.calls.length, 0);
  assert.equal(deps.mutateThread.mock.calls.length, 0);
  const notices = (ctx.adapter!.postMessage as any).mock.calls.filter(
    ([, content]) => content.text.includes('Review reconciliation'),
  );
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0][0], {
    type: 'project-report', projectId: 'atlas', trigger: 'task-dispatch', sessionId: '',
  });
  assert.match(notices[0][1].text, /terminal marker/);
  assert.match(notices[0][1].text, /no followup task created/);
});

test('reconciliation failure logs separately while original dispatch error drives recovery', async () => {
  selectFixture('reconcile-failure');
  deps.getTaskById.mockReturnValue({ ...selected.task, id: 'reconcile-failure', status: 'done' });
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));
  deps.add.mockRejectedValue(new Error('project lock failed'));

  await runDispatchCycle();
  await runDispatchCycle();
  await runDispatchCycle();

  assert.equal(deps.logError.mock.calls.filter(
    ([message]) => message === 'Failed dispatch reconciliation: project lock failed',
  ).length, 3);
  assert.deepEqual(deps.unclaim.mock.calls, [
    ['reconcile-failure'],
    ['reconcile-failure'],
    ['reconcile-failure'],
  ]);
  assert.deepEqual(deps.block.mock.calls, [[
    'reconcile-failure',
    'dispatch-failed-3x: provider unavailable',
  ]]);
  const texts = (ctx.adapter!.postMessage as any).mock.calls.map(([, message]) => message.text);
  assert.equal(texts.filter((text: string) => text.includes('Task dispatch error: provider unavailable')).length, 2);
  assert.equal(texts.at(-1).includes('Last error: provider unavailable'), true);
  assert.equal(texts.some((text: string) => text.includes('Task dispatch error: project lock failed')), false);
});

test('failed block mutation keeps the quarantine count and reports dispatch error', async () => {
  selectFixture('stale-target');
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));
  deps.block.mockResolvedValue({ success: false, message: 'Task not found' });

  await runDispatchCycle();
  await runDispatchCycle();
  await runDispatchCycle();

  assert.equal(deps.block.mock.calls.length, 1);
  const texts = (ctx.adapter!.postMessage as any).mock.calls.map(([, message]) => message.text);
  assert.equal(texts.some((text: string) => text.includes('Auto-blocked')), false);
  assert.equal(texts.at(-1).includes('Task dispatch error: provider unavailable'), true);

  deps.block.mockResolvedValue({ success: true });
  await runDispatchCycle();
  assert.deepEqual(deps.block.mock.calls[1], [
    'stale-target',
    'dispatch-failed-4x: provider unavailable',
  ]);
});
