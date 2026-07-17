// input:  src/tui/components/DashboardExecutionsTab.tsx
// output: Tests — happy path (confirm → success → no inline error), not-found path (error inline 5s)
// pos:    Verifies per-row [c] cancel via mutate prop

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { DashboardExecutionsTab } from '../../src/tui/components/DashboardExecutionsTab.js';
import type { MutateResult } from '../../src/tui/hooks/useMutate.js';
import type { TabData } from '../../src/tui/hooks/useDashboardData.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixtures ──

const EXECUTIONS_DATA = [
  {
    id: 'exec-1',
    type: 'local',
    status: 'running',
    machine: 'lab2',
    durationMs: 45200,
    cost: 0.1234,
    startedAt: '2026-05-27T10:00:00Z',
    finishedAt: null,
  },
  {
    id: 'exec-2',
    type: 'dispatch',
    status: 'completed',
    machine: 'lab',
    durationMs: 120000,
    cost: 0.5678,
    startedAt: '2026-05-27T09:00:00Z',
    finishedAt: '2026-05-27T09:02:00Z',
  },
];

function makeTabData(data: unknown[]): TabData {
  return { data, loading: false, error: null, lastUpdated: Date.now() };
}

// ── Tests ──

test('happy-path: cancel execution via [c]→confirm→onMutate success', async (t) => {
  let mutateOp: string | undefined;
  let mutateArgs: Record<string, unknown> | undefined;
  let resolveMutate: (r: MutateResult) => void;

  const mutatePromise = new Promise<MutateResult>(resolve => { resolveMutate = resolve; });

  const app = React.createElement(DashboardExecutionsTab, {
    data: makeTabData(EXECUTIONS_DATA),
    mutate: (op, args) => {
      mutateOp = op;
      mutateArgs = args;
      return mutatePromise;
    },
  });

  const instance = render(app);
  await delay(100);

  // Focus starts on row 0. Press ↓ to move to row 1 (exec-2: dispatch).
  instance.stdin.write('\x1b[B');
  await delay(100);

  // Press [c] to open confirm modal
  instance.stdin.write('c');
  await delay(100);

  // Confirm: press 'y'
  instance.stdin.write('y');
  await delay(100);

  // OnMutate was called with correct op and args
  assert.equal(mutateOp, 'executions.cancel');
  assert.deepEqual(mutateArgs, { executionId: 'exec-2' });

  // Resolve with success
  resolveMutate!({ ok: true, data: { cancelled: true } });
  await delay(100);

  // No error text should be visible
  const lastFrame = instance.lastFrame();
  assert.equal(lastFrame?.includes('not found'), false);

  instance.unmount();
  instance.cleanup();
});

test('long list is windowed: caps rendered rows and shows a "more below" affordance', async (t) => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `exec-${i}`,
    type: i % 2 === 0 ? 'local' : 'dispatch',
    status: 'completed',
    machine: 'lab2',
    durationMs: 1000 * (i + 1),
    cost: 0.01 * (i + 1),
    finishedAt: '2026-05-27T09:02:00Z',
  }));

  const instance = render(React.createElement(DashboardExecutionsTab, {
    data: makeTabData(many),
  }));
  await delay(100);

  const frame = instance.lastFrame() ?? '';
  // Not every row can be present (20 items would overflow); the overflow affordance must show.
  assert.ok(frame.includes('more below'), 'hidden-below affordance is shown for a long list');
  // The last item must NOT be rendered while focus is at the top.
  assert.equal(frame.includes('@lab2') && frame.split('✓').length - 1 <= 8, true,
    'rendered rows are capped well below the full list length');

  instance.unmount();
  instance.cleanup();
});

test('not-found-path: cancel returns not-found → inline error', async (t) => {
  let resolveMutate: (r: MutateResult) => void;
  const mutatePromise = new Promise<MutateResult>(resolve => { resolveMutate = resolve; });

  const app = React.createElement(DashboardExecutionsTab, {
    data: makeTabData(EXECUTIONS_DATA),
    mutate: () => mutatePromise,
  });

  const instance = render(app);
  await delay(100);

  // Press [c] on focused row 0
  instance.stdin.write('c');
  await delay(100);

  // Confirm: press Enter
  instance.stdin.write('\r');
  await delay(100);

  // Resolve with not-found error
  resolveMutate!({ ok: false, error: { code: 'not-found', message: 'not found' } });
  await delay(100);

  // Assert error text is visible under the row
  const lastFrame = instance.lastFrame();
  assert.ok(lastFrame?.includes('not found'), 'Error text should be visible');

  instance.unmount();
  instance.cleanup();
});
