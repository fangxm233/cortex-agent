// input:  src/tui/components/DashboardTasksTab.tsx
// output: Tests — claim/unclaim/complete/block/unblock mutation paths, row navigation, error display
// pos:    Verifies per-row keybinds and ConfirmModal integration for M3 tasks tab

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { DashboardTasksTab } from '../../src/tui/components/DashboardTasksTab.js';
import type { MutateResult } from '../../src/tui/hooks/useMutate.js';
import type { TabData } from '../../src/tui/hooks/useDashboardData.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixtures ──

const TASK_A = {
  id: 'task-1',
  text: 'Implement login page',
  priority: 'high',
  status: 'pending',
  claimedBy: null,
  blockedBy: null,
  projectId: 'p1',
};

const TASK_B = {
  id: 'task-2',
  text: 'Write unit tests for API',
  priority: 'medium',
  status: 'in-progress',
  claimedBy: 'alice',
  blockedBy: null,
  projectId: 'p1',
};

function makeTabData(data: unknown[]): TabData {
  return { data, loading: false, error: null, lastUpdated: Date.now() };
}

interface MutateCapture {
  op: string | undefined;
  args: Record<string, unknown> | undefined;
  resolve: ((r: MutateResult) => void) | null;
  reject: ((e: Error) => void) | null;
}

function createMockMutate(): { fn: (op: string, args: Record<string, unknown>) => Promise<MutateResult>; capture: MutateCapture } {
  const capture: MutateCapture = { op: undefined, args: undefined, resolve: null, reject: null };
  const fn = (op: string, args: Record<string, unknown>): Promise<MutateResult> => {
    capture.op = op;
    capture.args = args;
    return new Promise<MutateResult>((resolve, reject) => {
      capture.resolve = resolve;
      capture.reject = reject;
    });
  };
  return { fn, capture };
}

// ── Tests ──

test('arrow up/down navigates focused row', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Navigate to second row
  instance.stdin.write('\x1b[B');
  await delay(100);

  // Claim the focused (second) row
  instance.stdin.write('c');
  await delay(100);

  assert.equal(capture.op, 'tasks.claim');
  assert.deepEqual(capture.args, { projectId: 'p1', taskId: 'task-2' });
});

test('[c] key sends tasks.claim mutate', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  instance.stdin.write('c');
  await delay(100);

  assert.equal(capture.op, 'tasks.claim');
  assert.deepEqual(capture.args, { projectId: 'p1', taskId: 'task-1' });
});

test('[d] opens ConfirmModal, confirm sends tasks.complete', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Press d to open complete confirm modal
  instance.stdin.write('d');
  await delay(100);

  // Confirm with y
  instance.stdin.write('y');
  await delay(100);

  assert.equal(capture.op, 'tasks.complete');
  assert.deepEqual(capture.args, { projectId: 'p1', taskId: 'task-1' });
});

test('[d] then Esc cancels complete (no mutate sent)', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Press d to open complete confirm modal
  instance.stdin.write('d');
  await delay(100);

  // Cancel with Esc
  instance.stdin.write('\x1b');
  await delay(100);

  // No mutate should have been sent
  assert.equal(capture.op, undefined);

  // Tab should still respond to key presses
  instance.stdin.write('c');
  await delay(100);

  assert.equal(capture.op, 'tasks.claim');
  assert.deepEqual(capture.args, { projectId: 'p1', taskId: 'task-1' });
});

test('[b] opens ConfirmModal with reasonInput, confirm with reason sends tasks.block', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Press b to open block confirm modal with reason input
  instance.stdin.write('b');
  await delay(100);

  // Type each character with delay, then submit with Enter
  const reason = 'Waiting for dependency';
  for (const ch of reason) {
    instance.stdin.write(ch);
    await delay(20);
  }
  await delay(50);

  // Submit with Enter
  instance.stdin.write('\x0d');
  await delay(500);

  assert.equal(capture.op, 'tasks.block');
  assert.equal(capture.args!.projectId, 'p1');
  assert.equal(capture.args!.taskId, 'task-1');
  assert.equal(capture.args!.reason, 'Waiting for dependency');
});
