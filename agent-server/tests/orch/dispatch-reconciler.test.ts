// input:  dispatch reconciler, fake execution state, fake timers
// output: dispatch reconciler settings guard tests
// pos:    Verifies stale-dispatch interval registration is optional
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const mocks = vi.hoisted(() => ({
  reconcileStaleDispatches: vi.fn(),
  getTask: vi.fn(),
  getById: vi.fn(),
}));

vi.mock('../../src/domain/executions/registry.js', () => ({
  reconcileStaleDispatches: mocks.reconcileStaleDispatches,
}));
vi.mock('../../src/domain/tasks/pending-tracker.js', () => ({
  getTask: mocks.getTask,
}));
vi.mock('../../src/core/running-executions.js', () => ({
  runningExecutions: { getById: mocks.getById },
}));

import { startDispatchReconciler } from '../../src/orchestration/dispatch-reconciler.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('dispatch reconciler setting controls whether the interval is armed', async () => {
  vi.useFakeTimers();

  startDispatchReconciler(false);
  assert.equal(vi.getTimerCount(), 0);

  startDispatchReconciler(true);
  assert.equal(vi.getTimerCount(), 1);
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
  assert.equal(mocks.reconcileStaleDispatches.mock.calls.length, 1);

  const options = mocks.reconcileStaleDispatches.mock.calls[0][0];
  mocks.getTask.mockReturnValue({ id: 'abcd' });
  mocks.getById.mockReturnValue({ id: 'execution-1' });
  assert.equal(options.isTaskPending('abcd'), true);
  assert.equal(options.isLive('execution-1'), true);
  assert.equal(options.graceMs, 2 * 60 * 1000);
  assert.equal(options.maxAgeMs, 3 * 60 * 60 * 1000);
});
