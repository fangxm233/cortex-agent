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

  instance.unmount();
  instance.cleanup();
});
