// input:  core/session-state.ts over the two live singletons (runRegistry + sessionHolds)
// output: the four states sessions.list joins on
//
// Moved out of tests/runs/registry.test.ts by T2.1: `sessionState` is no longer a RunRegistry
// method, so these drive the singletons the function reads. Assertions unchanged.
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

import { runRegistry } from '../../src/core/run-registry.js';
import type { RunningExecutionInput } from '../../src/core/run-registry.js';
import { sessionHolds } from '../../src/core/session-holds.js';
import { sessionState } from '../../src/core/session-state.js';

function reset(): void {
  for (const entry of runRegistry.getAll()) runRegistry.remove(entry.registryKey);
  sessionHolds.clear();
}

beforeEach(reset);

function register(overrides: Partial<RunningExecutionInput> = {}): void {
  runRegistry.register({
    threadId: null,
    channel: 'web:s1',
    agentSlotId: null,
    executionId: 'exec-1',
    kind: null,
    kill: () => true,
    backend: 'claude',
    trackSessionId: 's1',
    ...overrides,
  });
}

test('sessionState: neither foreground nor background → idle', () => {
  assert.deepEqual(sessionState('s1'), {
    running: false,
    backgroundRunning: false,
    numTurns: null,
    executionId: null,
  });
});

test('sessionState: foreground running only → running, not background', () => {
  register({ executionId: 'exec-1', trackSessionId: 's1', channel: 'web:s1' });
  runRegistry.setNumTurns('exec-1', 4);

  assert.deepEqual(sessionState('s1'), {
    running: true,
    backgroundRunning: false,
    numTurns: 4,
    executionId: 'exec-1',
  });
});

test('sessionState: background held only → busy, backgroundRunning, no foreground identity', () => {
  sessionHolds.markBackgroundHeld('s1', 'web:s1');

  assert.deepEqual(sessionState('s1'), {
    running: true,
    backgroundRunning: true,
    numTurns: null,
    executionId: null,
  });
});

test('sessionState: foreground running + background held → both flags, foreground metrics', () => {
  register({ executionId: 'exec-1', trackSessionId: 's1', channel: 'web:s1' });
  runRegistry.setNumTurns('exec-1', 2);
  sessionHolds.markBackgroundHeld('s1', 'web:s1');

  const state = sessionState('s1');
  assert.equal(state.running, true);
  assert.equal(state.backgroundRunning, true);
  assert.equal(state.numTurns, 2);
  assert.equal(state.executionId, 'exec-1');
});

test('sessionState: a thread execution does not make the session itself busy', () => {
  register({ executionId: 'exec-thread', threadId: 'thr_1', trackSessionId: 's1' });

  assert.deepEqual(sessionState('s1'), {
    running: false,
    backgroundRunning: false,
    numTurns: null,
    executionId: null,
  });
});

test('sessionState: also matches a run known only by its backend session id, and picks the newest foreground', () => {
  register({ executionId: 'exec-old', trackSessionId: null, backendSessionId: 's1' });
  register({ executionId: 'exec-new', trackSessionId: 's1' });
  runRegistry.setNumTurns('exec-new', 7);

  assert.equal(sessionState('s1').executionId, 'exec-new');
  assert.equal(sessionState('s1').numTurns, 7);
});
