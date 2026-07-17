// input:  src/tui/components/DashboardSchedulesTab.tsx
// output: Tests — pause/resume/remove mutation paths, row navigation, error display
// pos:    Verifies per-row keybinds and ConfirmModal integration for M3 schedules tab

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { DashboardSchedulesTab } from '../../src/tui/components/DashboardSchedulesTab.js';
import type { MutateResult } from '../../src/tui/hooks/useMutate.js';
import type { TabData } from '../../src/tui/hooks/useDashboardData.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fixtures ──

const RUNNING = {
  id: 'sched-1',
  type: 'interval',
  message: 'Run test suite',
  projectId: 'p1',
  nextRun: '2026-05-27T12:00:00Z',
  lastRun: '2026-05-26T12:00:00Z',
  paused: false,
  pausedBy: null,
};

const PAUSED = {
  id: 'sched-2',
  type: 'daily',
  message: 'Deploy to production',
  projectId: 'p1',
  nextRun: '2026-05-28T08:00:00Z',
  lastRun: '2026-05-27T08:00:00Z',
  paused: true,
  pausedBy: 'admin',
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

test('[p] key sends schedules.pause mutate for focused row', async () => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  // First row is focused by default. Press p to pause it.
  instance.stdin.write('p');
  await delay(100);

  assert.equal(capture.op, 'schedules.pause');
  assert.deepEqual(capture.args, { scheduleId: 'sched-1' });

  instance.unmount();
  instance.cleanup();
});

test('[r] key sends schedules.resume mutate for focused row', async () => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  // Focus first row, press r to resume
  instance.stdin.write('r');
  await delay(100);

  assert.equal(capture.op, 'schedules.resume');
  assert.deepEqual(capture.args, { scheduleId: 'sched-1' });

  instance.unmount();
  instance.cleanup();
});

test('[x] opens ConfirmModal, confirm sends schedules.remove', async () => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  // Press x to open remove confirm modal
  instance.stdin.write('x');
  await delay(100);

  // Confirm with y
  instance.stdin.write('y');
  await delay(100);

  assert.equal(capture.op, 'schedules.remove');
  assert.deepEqual(capture.args, { scheduleId: 'sched-1' });

  instance.unmount();
  instance.cleanup();
});

test('[x] then Esc cancels remove (no mutate sent)', async () => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  // Press x to open remove confirm modal
  instance.stdin.write('x');
  await delay(100);

  // Cancel with Esc
  instance.stdin.write('\x1b');
  await delay(100);

  // No mutate should have been sent
  assert.equal(capture.op, undefined);

  // Tab should still respond to key presses (verify by pressing p)
  instance.stdin.write('p');
  await delay(100);

  assert.equal(capture.op, 'schedules.pause');
  assert.deepEqual(capture.args, { scheduleId: 'sched-1' });

  instance.unmount();
  instance.cleanup();
});

test('↓ then [p] targets second schedule (row navigation)', async () => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  // Navigate to second row
  instance.stdin.write('\x1b[B');
  await delay(100);

  // Press p to pause the focused (second) row
  instance.stdin.write('p');
  await delay(100);

  assert.equal(capture.op, 'schedules.pause');
  assert.deepEqual(capture.args, { scheduleId: 'sched-2' });

  instance.unmount();
  instance.cleanup();
});

test('error result renders inline error under row', async () => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  // Trigger pause
  instance.stdin.write('p');
  await delay(100);

  // Resolve with error
  capture.resolve!({ ok: false, error: { code: 'not_found', message: 'Schedule sched-1 not found' } });
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('not_found'), 'error code in output');
  assert.ok(output.includes('Schedule sched-1 not found'), 'error message in output');

  instance.unmount();
  instance.cleanup();
});

test('ok result does not show error (success collapses)', async () => {
  const { fn, capture } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  // Trigger pause — resolve with success
  instance.stdin.write('p');
  await delay(100);

  capture.resolve!({ ok: true, data: {} });
  await delay(100);

  const output = instance.lastFrame();
  // Should not contain error-related text
  assert.equal(output.includes('not_found'), false);
  assert.equal(output.includes('error'), false);

  // Action bar should still show (row is focused)
  assert.ok(output.includes('[p] Pause'), 'action bar visible after success');

  instance.unmount();
  instance.cleanup();
});

test('loading state shows loading text', async () => {
  const { fn } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: { data: [], loading: true, error: null, lastUpdated: null },
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Loading schedules'));

  instance.unmount();
  instance.cleanup();
});

test('error state shows error text', async () => {
  const { fn } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: { data: [], loading: false, error: 'Failed to fetch', lastUpdated: null },
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('Error: Failed to fetch'));

  instance.unmount();
  instance.cleanup();
});

test('empty state shows no schedules text', async () => {
  const { fn } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: { data: [], loading: false, error: null, lastUpdated: Date.now() },
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  const output = instance.lastFrame();
  assert.ok(output.includes('No schedules'));

  instance.unmount();
  instance.cleanup();
});

test('Phase 3 placeholder text is removed', async () => {
  const { fn } = createMockMutate();
  const tab = React.createElement(DashboardSchedulesTab, {
    data: makeTabData([RUNNING, PAUSED]),
    mutate: fn,
  });

  const instance = render(tab);
  await delay(100);

  const output = instance.lastFrame();
  assert.equal(output.includes('Phase 3'), false, 'Phase 3 placeholder should not appear');

  instance.unmount();
  instance.cleanup();
});
