// input:  dispatch job, settings, CPU topology, task doubles
// output: limits, generations, hooks, quarantine, recovery tests
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
  getThread: vi.fn(),
  mutateThread: vi.fn(),
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
  taskMutator: { unclaim: deps.unclaim, block: deps.block },
}));

import { ctx } from '../src/domain/scheduling/job-registry.js';
import { taskDispatchRunner } from '../src/domain/scheduling/jobs/task-dispatch.js';

const OWNERSHIP = { ownership: { generation: 'generation-b' } };

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
  dispatchGeneration: 'generation-b',
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
  deps.getThread.mockImplementation(() => threadRecord);
  deps.mutateThread.mockImplementation(async (_id, mutate) => { mutate(threadRecord); });
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

test('dispatch persists generation on the thread and terminal event', async () => {
  deps.runThread.mockResolvedValueOnce({
    thread: { status: 'completed', metadata: {} },
    lastAgentResult: null,
  });

  await runDispatchCycle();

  const createOptions = deps.createThread.mock.calls[0][1];
  assert.equal(createOptions.metadata.dispatchGeneration, 'generation-b');
  assert.deepEqual(deps.processSplitOutcome.mock.calls[0][0].ownership, {
    generation: 'generation-b',
  });
  const terminal = (ctx.bus!.publish as any).mock.calls
    .map(([event]) => event)
    .find((event) => event.type === 'task.completed');
  assert.deepEqual(terminal, {
    type: 'task.completed', taskId: 'task-1', dispatchGeneration: 'generation-b',
  });
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
    OWNERSHIP,
  ]]);

  deps.block.mockClear();
  await runDispatchCycle();
  await runDispatchCycle();
  assert.equal(deps.block.mock.calls.length, 0);

  await runDispatchCycle();
  assert.equal(deps.block.mock.calls.length, 1);
});

/** Generation-fenced task double. Mirrors the three rules the real mutator enforces:
 *  a mismatched generation is refused (task-state.ts staleOwnership), unclaim clears
 *  dispatch_generation, and block keeps the owning generation while releasing the claim. */
function installFencedTask(id: string) {
  const state = { generation: null as string | null, blockedBy: null as string | null };
  const refuseStale = (ownership?: { generation: string | null }) =>
    ownership && state.generation !== ownership.generation
      ? { success: false, stale: true, message: 'Stale task dispatch generation; mutation ignored' }
      : null;
  deps.selectAndClaimTask.mockImplementation(async () => {
    state.generation = selected.dispatchGeneration;
    return { ...selected, task: { ...selected.task, id } };
  });
  deps.unclaim.mockImplementation(async (_id: string, options: any = {}) => {
    const stale = refuseStale(options.ownership);
    if (stale) return stale;
    state.generation = null;
    return { success: true };
  });
  deps.block.mockImplementation(async (_id: string, reason: string, options: any = {}) => {
    const stale = refuseStale(options.ownership);
    if (stale) return stale;
    state.blockedBy = reason;
    state.generation = options.ownership?.generation ?? null;
    return { success: true };
  });
  return state;
}

test('quarantine still blocks the task after the same failure released its claim', async () => {
  const state = installFencedTask('fenced-target');
  deps.runThread.mockRejectedValue(new Error('provider unavailable'));

  await runDispatchCycle();
  await runDispatchCycle();
  assert.equal(state.blockedBy, null, 'the first two failures only requeue the task');

  await runDispatchCycle();
  assert.equal(state.blockedBy, 'dispatch-failed-3x: provider unavailable');
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
    OWNERSHIP,
  ]);
});
