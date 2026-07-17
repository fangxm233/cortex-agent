// input:  src/tui/components/DashboardThreadsTab.tsx
// output: Tests — happy path cancel + already-terminal path
// pos:    Verifies DashboardThreadsTab cancel keybind, ConfirmModal, mutate, and inline feedback

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { DashboardThreadsTab } from '../../src/tui/components/DashboardThreadsTab.js';
import type { MutateResult } from '../../src/tui/hooks/useMutate.js';
import type { TabData } from '../../src/tui/hooks/useDashboardData.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixtures ──

const THREADS_DATA = [
  {
    id: 't1',
    templateName: 'Alpha',
    status: 'running',
    currentStep: { name: 'Research', index: 0, totalSteps: 3 },
    totalSteps: 3,
    projectId: 'p1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    artifactPath: null,
  },
  {
    id: 't2',
    templateName: 'Beta',
    status: 'waiting',
    currentStep: null,
    totalSteps: 2,
    projectId: 'p1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    artifactPath: null,
  },
];

// ── Test harness ──

interface RecordedMutate {
  op: string;
  args: Record<string, unknown>;
}

function createTestHarness(
  data: unknown[] = THREADS_DATA,
  mutateResult: MutateResult = { ok: true, data: { cancelled: true } },
): { Harness: React.FC; recorded: RecordedMutate[] } {
  const recorded: RecordedMutate[] = [];

  const tabData: TabData = { data, loading: false, error: null, lastUpdated: Date.now() };

  function Harness() {
    return React.createElement(DashboardThreadsTab as any, {
      data: tabData,
      mutate: async (op: string, args: Record<string, unknown>) => {
        recorded.push({ op, args });
        return mutateResult;
      },
    });
  }

  return { Harness, recorded };
}

// ── Tests ──

test('renders thread list with status and names', async () => {
  const { Harness } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Alpha'), 'should show first thread name');
  assert.ok(output.includes('Beta'), 'should show second thread name');
  assert.ok(output.includes('step 1/3'), 'should show step progress');

  instance.unmount();
  instance.cleanup();
});

test('renders empty state when no threads', async () => {
  const { Harness } = createTestHarness([]);
  const instance = render(React.createElement(Harness));
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('No threads'), 'should show empty message');

  instance.unmount();
  instance.cleanup();
});

test('arrow up/down navigates focused row without crashing', async () => {
  const { Harness } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  // Press down arrow
  instance.stdin.write('\x1b[B');
  await delay(100);

  // Press up arrow — back to first row
  instance.stdin.write('\x1b[A');
  await delay(100);

  // No crash
  instance.unmount();
  instance.cleanup();
});

test('c key opens ConfirmModal with thread info', async () => {
  const { Harness } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  instance.stdin.write('c');
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Cancel thread?'), 'ConfirmModal title should appear');
  assert.ok(output.includes('Alpha'), 'ConfirmModal body should show thread name');
  assert.ok(output.includes('running'), 'ConfirmModal body should show thread status');

  instance.unmount();
  instance.cleanup();
});

test('Escape closes ConfirmModal without sending mutation', async () => {
  const { Harness, recorded } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  // Open confirm modal
  instance.stdin.write('c');
  await delay(100);

  // Press Escape to cancel
  instance.stdin.write('\x1b');
  await delay(100);

  // Modal should be closed
  const output = instance.lastFrame();
  assert.ok(!output.includes('Cancel thread?'), 'modal should be dismissed');
  // No mutate should have been called
  assert.equal(recorded.length, 0, 'no mutate should be called after cancel');

  instance.unmount();
  instance.cleanup();
});

test('happy path: confirm cancel sends threads.cancel mutate', async () => {
  const { Harness, recorded } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  // Open confirm modal
  instance.stdin.write('c');
  await delay(100);

  // Confirm with y
  instance.stdin.write('y');
  await delay(100);

  // Verify mutate was called
  assert.equal(recorded.length, 1, 'should call mutate once');
  assert.equal(recorded[0].op, 'threads.cancel', 'should cancel threads');
  assert.equal(recorded[0].args.threadId, 't1', 'should cancel first thread');

  // Modal should close after successful cancel
  const output = instance.lastFrame();
  assert.ok(!output.includes('Cancel thread?'), 'modal should close after successful cancel');

  instance.unmount();
  instance.cleanup();
});

test('no-mutate prop disables c keybind', async () => {
  const tabData: TabData = { data: THREADS_DATA, loading: false, error: null, lastUpdated: Date.now() };
  const instance = render(React.createElement(DashboardThreadsTab as any, { data: tabData }));
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Alpha'), 'threads list should render');

  // Press c — should be a no-op since mutate is undefined
  instance.stdin.write('c');
  await delay(100);

  // ConfirmModal should NOT open
  const output2 = instance.lastFrame();
  assert.ok(!output2.includes('Cancel thread?'), 'modal should not open when mutate is undefined');

  instance.unmount();
  instance.cleanup();
});

test('already-terminal path shows inline feedback', async () => {
  const errorResult: MutateResult = {
    ok: false,
    error: { code: 'already-terminal', message: 'Thread is already in terminal state' },
  };
  const { Harness, recorded } = createTestHarness(THREADS_DATA, errorResult);
  const instance = render(React.createElement(Harness));
  await delay(100);

  // Open confirm modal for focused row
  instance.stdin.write('c');
  await delay(100);

  // Confirm
  instance.stdin.write('y');
  await delay(100);

  // Verify mutate was called
  assert.equal(recorded.length, 1, 'should call mutate once');
  assert.equal(recorded[0].op, 'threads.cancel');

  // Verify inline feedback is shown
  const output = instance.lastFrame();
  assert.ok(output.includes('already finished'), 'should show already-terminal feedback below the row');
  // Modal should be closed
  assert.ok(!output.includes('Cancel thread?'), 'modal should close after result');

  instance.unmount();
  instance.cleanup();
});
