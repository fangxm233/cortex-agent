// input:  src/tui/hooks/useMutate.js
// output: Tests — ok-path, error-path, timeout-path, unmount-cleanup
// pos:    Verifies ui.mutate request/response correlation

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useMutate } from '../../src/tui/hooks/useMutate.js';
import type { MutateResult } from '../../src/tui/hooks/useMutate.js';
import type { TuiFrame, UiMutate } from '../../src/platform/tui/protocol.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Test harness ──

interface HarnessState {
  mutate: ((op: string, args: Record<string, unknown>) => Promise<MutateResult>) | null;
  handleFrame: ((frame: TuiFrame) => void) | null;
  sentFrames: UiMutate[];
}

function createTestHarness(): { Harness: React.FC; state: HarnessState } {
  const state: HarnessState = {
    mutate: null,
    handleFrame: null,
    sentFrames: [],
  };

  function Harness() {
    const { mutate, handleFrame } = useMutate({
      sendFrame: (frame) => {
        if (frame.type === 'ui.mutate') {
          state.sentFrames.push(frame as UiMutate);
        }
      },
    });
    state.mutate = mutate;
    state.handleFrame = handleFrame;
    return React.createElement(Text, null, 'test');
  }

  return { Harness, state };
}

// ── Tests ──

test('ok-path: resolves with data on matching ui.mutateResult', async (t) => {
  const { Harness, state } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  const promise = state.mutate!('task.claim', { taskId: 't1' });
  await delay(50);

  assert.equal(state.sentFrames.length, 1);
  const sentId = state.sentFrames[0].id;

  // Send matching result
  state.handleFrame!({
    type: 'ui.mutateResult',
    id: sentId,
    ok: true,
    data: { success: true, taskId: 't1' },
  } as any);

  const result = await promise;
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data, { success: true, taskId: 't1' });
  }

  instance.unmount();
  instance.cleanup();
});

test('error-path: resolves with error on failing ui.mutateResult', async (t) => {
  const { Harness, state } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  const promise = state.mutate!('task.claim', { taskId: 't1' });
  await delay(50);

  assert.equal(state.sentFrames.length, 1);
  const sentId = state.sentFrames[0].id;

  // Send failing result
  state.handleFrame!({
    type: 'ui.mutateResult',
    id: sentId,
    ok: false,
    error: { code: 'not_found', message: 'Task not found' },
  } as any);

  const result = await promise;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'not_found');
    assert.equal(result.error.message, 'Task not found');
  }

  instance.unmount();
  instance.cleanup();
});

test('timeout-path: resolves with timeout error after 10s', async (t) => {
  const { Harness, state } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100); // real timers — let mount settle

  // Enable mock timers AFTER mount so React/Ink internals are unaffected
  vi.useFakeTimers({ toFake: ['setTimeout'] });

  const promise = state.mutate!('task.claim', { taskId: 't1' });

  // Advance past the 10s timeout
  vi.advanceTimersByTime(10000);

  const result = await promise;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'timeout');
    assert.equal(result.error.message, 'no ui.mutateResult within 10s');
  }

  vi.useRealTimers();
  instance.unmount();
  instance.cleanup();
});

test('unmount-cleanup: clears pending on unmount', async (t) => {
  const { Harness, state } = createTestHarness();
  const instance = render(React.createElement(Harness));
  await delay(100);

  // Save handleFrame reference before unmount
  const { handleFrame: savedHandleFrame } = state;
  const promise = state.mutate!('task.claim', { taskId: 't1' });
  const sentId = state.sentFrames[0].id;

  // Unmount — triggers useEffect cleanup (clears pending map, clears timers).
  // In React 18 concurrent mode, useEffect cleanup is flushed asynchronously,
  // so we need a microtask/delay to let it complete.
  instance.unmount();
  instance.cleanup();
  await delay(50);

  // After unmount, calling handleFrame with the matching ID should be a no-op
  // (pending map was cleared on unmount, so the entry won't be found)
  savedHandleFrame!({
    type: 'ui.mutateResult',
    id: sentId,
    ok: true,
    data: { success: true },
  } as any);

  // The promise should NOT have been resolved (pending map was cleared).
  // Verify by racing against a microtask — the race resolves via the
  // Promise.resolve().then() on the next microtask, since the mutate
  // promise stays pending after cleanup.
  const raced = await Promise.race([
    promise.then(r => ({ resolved: true, result: r })),
    Promise.resolve().then(() => ({ resolved: false })),
  ]);

  assert.equal(raced.resolved, false, 'Promise should not resolve after unmount cleanup');
});
