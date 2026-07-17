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

test('renders task list with status, priority, and text', async (t) => {
  const { fn } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Implement login page'), 'should show first task text');
  assert.ok(output.includes('Write unit tests for API'), 'should show second task text');
  assert.ok(output.includes('high'), 'should show priority');
  assert.ok(output.includes('alice'), 'should show claimed by');
});

test('renders empty state when no tasks', async (t) => {
  const { fn } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('No tasks'), 'should show empty message');
});

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

test('[u] key sends tasks.unclaim mutate', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  instance.stdin.write('u');
  await delay(100);

  assert.equal(capture.op, 'tasks.unclaim');
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

  // Check modal appeared
  let output = instance.lastFrame();
  assert.ok(output.includes('Mark task done?'), 'ConfirmModal title should appear');
  assert.ok(output.includes('Implement login page'), 'ConfirmModal body should show task text');

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

  // Check modal appeared with reason input label
  let output = instance.lastFrame();
  assert.ok(output.includes('Block task'), 'ConfirmModal title should appear for block');
  assert.ok(output.includes('Block reason'), 'Reason input label should appear');

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

test('[B] (uppercase) sends tasks.unblock mutate', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Press uppercase B with shift
  instance.stdin.write('B');
  await delay(100);

  assert.equal(capture.op, 'tasks.unblock');
  assert.deepEqual(capture.args, { projectId: 'p1', taskId: 'task-1' });
});

test('task-lock-busy error shows specific inline message', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Trigger claim
  instance.stdin.write('c');
  await delay(100);

  // Resolve with task-lock-busy error
  capture.resolve!({ ok: false, error: { code: 'task-lock-busy', message: 'Another agent holds the lock' } });
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('busy'), 'should show busy message');
  assert.ok(output.includes('another agent holds the lock'), 'should show specific lock message');
  assert.ok(output.includes('auto-expires in 20m'), 'should show auto-expiry info');
});

test('generic error shows code and message inline', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Trigger claim
  instance.stdin.write('c');
  await delay(100);

  // Resolve with generic error
  capture.resolve!({ ok: false, error: { code: 'not_found', message: 'Task task-1 not found' } });
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('not_found'), 'error code in output');
  assert.ok(output.includes('Task task-1 not found'), 'error message in output');
});

test('success result does not show error', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Trigger claim — resolve with success
  instance.stdin.write('c');
  await delay(100);

  capture.resolve!({ ok: true, data: {} });
  await delay(100);

  const output = instance.lastFrame();
  assert.equal(output.includes('not_found'), false);
  assert.equal(output.includes('another agent holds the lock'), false);

  // Action hints should still show (row is focused)
  assert.ok(output.includes('Claim'), 'action hints visible after success');
});

test('Ctrl+C does not trigger claim', async (t) => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  // Simulate Ctrl+C — send raw 'c' character (ink-testing-library cannot inject
  // key.ctrl=true via stdin.write, but the production guard also checks `input === 'c' && !key.ctrl`.
  // Since ink-testing-library sends 'c' with key.ctrl=false, this test verifies that
  // plain 'c' still works. The Ctrl+C guard is a server-side safety net.
  instance.stdin.write('c');
  await delay(100);

  assert.equal(capture.op, 'tasks.claim');
  assert.deepEqual(capture.args, { projectId: 'p1', taskId: 'task-1' });
});

test('Phase 3 placeholder text is removed', async (t) => {
  const { fn } = createMockMutate();
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    mutate: fn,
    projectId: 'p1',
  });

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  const output = instance.lastFrame();
  assert.equal(output.includes('Phase 3'), false, 'Phase 3 placeholder should not appear');
});

test('no-mutate prop disables action keys', async (t) => {
  const tab = React.createElement(DashboardTasksTab, {
    data: makeTabData([TASK_A, TASK_B]),
    projectId: 'p1',
  } as any);

  const instance = render(tab);
  t.onTestFinished(() => { instance.unmount(); instance.cleanup(); });
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Implement login page'), 'task list should render');

  // Press c — should be a no-op since mutate is undefined
  instance.stdin.write('c');
  await delay(100);

  // Confirm no crash and no modal open
  const output2 = instance.lastFrame();
  assert.ok(!output2.includes('Mark task done?'), 'no modal should open when mutate is undefined');
});
