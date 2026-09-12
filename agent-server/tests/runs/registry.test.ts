// input:  core/run-registry.ts and the running-executions / bg-held-sessions shims
// output: spec for RunRegistry.sessionState and the background-hold lifecycle
// pos:    P1.2 contract — RunRegistry is the one answer to "is this session busy"
// >>> If I am updated, update my header comment and the parent folder CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { RunRegistry } from '../../src/core/run-registry.js';
import type { RunningExecutionInput } from '../../src/core/run-registry.js';
import { runningExecutions } from '../../src/core/running-executions.js';
import { bgHeldSessions } from '../../src/core/bg-held-sessions.js';

function makeInput(overrides: Partial<RunningExecutionInput> = {}): RunningExecutionInput {
  return {
    threadId: null,
    channel: 'web:s1',
    agentSlotId: null,
    executionId: 'exec-1',
    kind: null,
    kill: () => true,
    backend: 'claude',
    trackSessionId: 's1',
    ...overrides,
  };
}

// ── sessionState: the four states the UI joins today ───────────────────

test('sessionState: neither foreground nor background → idle', () => {
  const r = new RunRegistry();
  assert.deepEqual(r.sessionState('s1'), {
    running: false,
    backgroundRunning: false,
    numTurns: null,
    executionId: null,
  });
});

test('sessionState: foreground running only → running, not background', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-1', trackSessionId: 's1', channel: 'web:s1' }));
  r.setNumTurns('exec-1', 4);

  assert.deepEqual(r.sessionState('s1'), {
    running: true,
    backgroundRunning: false,
    numTurns: 4,
    executionId: 'exec-1',
  });
});

test('sessionState: background held only → busy, backgroundRunning, no foreground identity', () => {
  const r = new RunRegistry();
  r.markBackgroundHeld('s1', 'web:s1');

  assert.deepEqual(r.sessionState('s1'), {
    running: true,
    backgroundRunning: true,
    numTurns: null,
    executionId: null,
  });
});

test('sessionState: foreground running + background held → both flags, foreground metrics', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-1', trackSessionId: 's1', channel: 'web:s1' }));
  r.setNumTurns('exec-1', 2);
  r.markBackgroundHeld('s1', 'web:s1');

  const state = r.sessionState('s1');
  assert.equal(state.running, true);
  assert.equal(state.backgroundRunning, true);
  assert.equal(state.numTurns, 2);
  assert.equal(state.executionId, 'exec-1');
});

test('sessionState: a thread execution does not make the session itself busy', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-thread', threadId: 'thr_1', trackSessionId: 's1' }));

  // sessions.ts only counts non-thread executions as an interactive turn.
  assert.deepEqual(r.sessionState('s1'), {
    running: false,
    backgroundRunning: false,
    numTurns: null,
    executionId: null,
  });
});

test('sessionState: matches the legacy sessionId alias too, and picks the newest foreground', () => {
  const r = new RunRegistry();
  r.register(makeInput({ executionId: 'exec-old', trackSessionId: null, sessionId: 's1' }));
  r.register(makeInput({ executionId: 'exec-new', trackSessionId: 's1' }));
  r.setNumTurns('exec-new', 7);

  assert.equal(r.sessionState('s1').executionId, 'exec-new');
  assert.equal(r.sessionState('s1').numTurns, 7);
});

// ── background-hold lifecycle: mark → has/listIds/sessionsOnChannel → abort → clear ──

test('markBackgroundHeld records the channel and is queryable', () => {
  const r = new RunRegistry();
  r.markBackgroundHeld('s1', 'web:abc');
  r.markBackgroundHeld('s2', 'web:xyz');

  assert.equal(r.has('s1'), true);
  assert.deepEqual(r.listIds().sort(), ['s1', 's2']);
  assert.deepEqual(r.sessionsOnChannel('web:abc'), ['s1']);
  assert.deepEqual(r.sessionsOnChannel('web:xyz'), ['s2']);
  assert.deepEqual(r.sessionsOnChannel('web:none'), []);
  assert.deepEqual(r.sessionsOnChannel(''), []);
});

test('markBackgroundHeld without a channel preserves the previously recorded channel', () => {
  const r = new RunRegistry();
  r.markBackgroundHeld('s1', 'web:abc');
  r.markBackgroundHeld('s1', null);
  assert.deepEqual(r.sessionsOnChannel('web:abc'), ['s1']);
});

test('markBackgroundHeld ignores an empty session id', () => {
  const r = new RunRegistry();
  r.markBackgroundHeld('', 'web:abc');
  assert.equal(r.has(''), false);
  assert.deepEqual(r.listIds(), []);
});

test('markBackgroundHeld registers an abort handle that fires exactly once', () => {
  const r = new RunRegistry();
  let fired = 0;
  r.markBackgroundHeld('s1', 'web:abc', () => { fired++; });

  assert.equal(r.abort('s1'), true);
  assert.equal(fired, 1);
  assert.equal(r.abort('s1'), false, 'single-fire: handle dropped before invoking');
  assert.equal(fired, 1);
});

test('setAbort registers a handle and abort() fires it once', () => {
  const r = new RunRegistry();
  let fired = 0;
  r.markBackgroundHeld('s1', 'web:abc');
  r.setAbort('s1', () => { fired++; });

  assert.equal(r.abort('s1'), true);
  assert.equal(fired, 1);
  assert.equal(r.abort('s1'), false);
});

test('abort() on a session with no hold is a no-op', () => {
  const r = new RunRegistry();
  assert.equal(r.abort('nope'), false);
});

test('clearBackgroundHeld drops the hold and its abort handle', () => {
  const r = new RunRegistry();
  let fired = 0;
  r.markBackgroundHeld('s1', 'web:abc', () => { fired++; });

  r.clearBackgroundHeld('s1');
  assert.equal(r.has('s1'), false);
  assert.deepEqual(r.sessionsOnChannel('web:abc'), []);
  assert.equal(r.abort('s1'), false);
  assert.equal(fired, 0);
});

test('clear() empties every hold and abort handle', () => {
  const r = new RunRegistry();
  r.markBackgroundHeld('s1', 'web:abc', () => { throw new Error('must not fire'); });
  r.markBackgroundHeld('s2', 'web:xyz');

  r.clear();
  assert.deepEqual(r.listIds(), []);
  assert.deepEqual(r.sessionsOnChannel('web:abc'), []);
  assert.equal(r.abort('s1'), false);
});

// ── onSessionStatus compatibility (the app.ts bus feed) ────────────────

test('onSessionStatus holds on running+backgroundRunning and clears on anything else', () => {
  const r = new RunRegistry();
  r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  assert.equal(r.has('s1'), true);

  r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true });
  assert.equal(r.has('s1'), false, 'a plain turn start supersedes the hold');
});

test('onSessionStatus clears the hold when the seal republishes running:false', () => {
  const r = new RunRegistry();
  let fired = 0;
  r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  r.setAbort('s1', () => {
    fired++;
    r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: false, backgroundRunning: false });
  });

  r.abort('s1');
  assert.equal(fired, 1);
  assert.equal(r.has('s1'), false);
});

// ── streaming slot (P1.9 moves hook-bridge's Map here) ─────────────────

test('streaming slot set / get / clear', () => {
  const r = new RunRegistry();
  assert.equal(r.getStreaming('web:abc'), null);

  const cb = (text: string) => { void text; };
  r.setStreaming('web:abc', cb);
  assert.equal(r.getStreaming('web:abc'), cb);

  r.clearStreaming('web:abc');
  assert.equal(r.getStreaming('web:abc'), null);
});

// ── the shims are the one shared index ─────────────────────────────────

test('runningExecutions and bgHeldSessions are the same runRegistry singleton', () => {
  assert.equal(runningExecutions, bgHeldSessions);
});
