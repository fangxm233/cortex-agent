// input:  task-dispatch job, HookBus and thread runner doubles
// output: dispatch.started payload, ordering and isolation tests
// pos:    Verifies lifecycle hooks on claimed task dispatch
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  emitCortexEvent: vi.fn(),
  getRunningExecutions: vi.fn(),
  selectAndClaimTask: vi.fn(),
  updateScheduleInterval: vi.fn(),
  generateSessionName: vi.fn(),
  createThread: vi.fn(),
  runThread: vi.fn(),
  unclaim: vi.fn(),
  block: vi.fn(),
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

vi.mock('../src/domain/threads/runner.js', () => ({
  runThread: deps.runThread,
}));

vi.mock('../src/domain/tasks/mutator.js', () => ({
  taskMutator: { unclaim: deps.unclaim, block: deps.block },
}));

import { ctx } from '../src/domain/scheduling/job-registry.js';
import { taskDispatchRunner } from '../src/domain/scheduling/jobs/task-dispatch.js';

const selected = {
  task: {
    id: 'task-1',
    project: 'atlas',
    text: 'Run the queued implementation',
  },
  template: 'coder-review',
  prompt: 'Implement the queued task',
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

beforeEach(() => {
  for (const mock of Object.values(deps)) mock.mockReset();
  deps.emitCortexEvent.mockResolvedValue([]);
  deps.getRunningExecutions.mockReturnValue([]);
  deps.selectAndClaimTask.mockResolvedValue(selected);
  deps.generateSessionName.mockResolvedValue('cortex-test');
  deps.createThread.mockReturnValue({ id: 'thread-1' });
  deps.runThread.mockResolvedValue({
    thread: { status: 'waiting', metadata: { waitingOn: [], waitingOnTasks: [] } },
    lastAgentResult: null,
  });
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
