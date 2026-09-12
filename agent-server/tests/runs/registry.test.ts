// input:  core/run-registry.ts
// output: spec for RunRegistry.sessionState and the background-hold lifecycle
// pos:    P1.2 contract — RunRegistry is the one answer to "is this session busy"
// >>> If I am updated, update my header comment and the parent folder CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { RunRegistry } from '../../src/core/run-registry.js';
import type { RunningExecutionInput } from '../../src/core/run-registry.js';

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

test('markBackgroundHeld registers hold handles that fire exactly once', () => {
  const r = new RunRegistry();
  let fired = 0;
  const seal = (): void => { fired++; };
  r.markBackgroundHeld('s1', 'web:abc', { onSuperseded: seal, onStop: seal });

  assert.equal(r.stopHolds('s1'), true);
  assert.equal(fired, 1);
  assert.equal(r.stopHolds('s1'), false, 'single-fire: handles dropped before invoking');
  assert.equal(fired, 1);
});

test('setHoldHandles registers handles and stopHolds() fires them once', () => {
  const r = new RunRegistry();
  let fired = 0;
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'web-bg-hold', { onStop: () => { fired++; } });

  assert.equal(r.stopHolds('s1'), true);
  assert.equal(fired, 1);
  assert.equal(r.stopHolds('s1'), false);
});

test('stopHolds() on a session with no hold is a no-op', () => {
  const r = new RunRegistry();
  assert.equal(r.stopHolds('nope'), false);
});

// ── the two verbs ──────────────────────────────────────────────────────
//
// One slot per session used to carry handles that meant two different things. A foreground turn
// fired it to RELEASE a passive hold; a backgrounded `agent` run had put "stop the child" there.

test('supersedeHolds fires onSuperseded and KEEPS onStop — the work is still running', () => {
  const r = new RunRegistry();
  const seen: string[] = [];
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'agent-run:sa_1', { onStop: () => seen.push('stop') });

  assert.equal(r.supersedeHolds('s1'), false, 'a work-owning hold has nothing to yield');
  assert.deepEqual(seen, [], 'a new foreground turn must never stop a running child');

  assert.equal(r.stopHolds('s1'), true, 'Stop still reaches it');
  assert.deepEqual(seen, ['stop']);
});

test('supersedeHolds fires a status-only hold and leaves it unable to fire twice', () => {
  const r = new RunRegistry();
  const seen: string[] = [];
  const seal = (): void => { seen.push('seal'); };
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'web-bg-hold', { onSuperseded: seal, onStop: seal });

  assert.equal(r.supersedeHolds('s1'), true);
  assert.deepEqual(seen, ['seal']);
  assert.equal(r.supersedeHolds('s1'), false, 'single-fire');
  assert.deepEqual(seen, ['seal']);
});

test('two owners hold one session independently — neither erases the other', () => {
  const r = new RunRegistry();
  const seen: string[] = [];
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'web-bg-hold', { onSuperseded: () => seen.push('web-seal'), onStop: () => seen.push('web-seal') });
  r.setHoldHandles('s1', 'agent-run:sa_1', { onStop: () => seen.push('stop-child') });

  assert.equal(r.stopHolds('s1'), true);
  assert.deepEqual(seen.sort(), ['stop-child', 'web-seal'], 'Stop reaches BOTH holders');
});

test('dropHoldHandles removes one owner and leaves the rest holding', () => {
  const r = new RunRegistry();
  const seen: string[] = [];
  r.setHoldHandles('s1', 'agent-run:sa_1', { onStop: () => seen.push('one') });
  r.setHoldHandles('s1', 'agent-run:sa_2', { onStop: () => seen.push('two') });

  r.dropHoldHandles('s1', 'agent-run:sa_1');
  assert.equal(r.stopHolds('s1'), true);
  assert.deepEqual(seen, ['two']);
});

test('clearing the status hold leaves a work-owning holder\'s Stop handle armed', () => {
  const r = new RunRegistry();
  const seen: string[] = [];
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'agent-run:sa_1', { onStop: () => seen.push('stop') });

  // The parent's foreground turn publishes running:true — the STATUS hold is over, but the
  // delegated run is not, and Stop must still be able to end it.
  r.clearBackgroundHeld('s1');
  assert.equal(r.has('s1'), false);
  assert.equal(r.stopHolds('s1'), true);
  assert.deepEqual(seen, ['stop']);
});

test('clearBackgroundHeld drops the hold and its handles', () => {
  const r = new RunRegistry();
  let fired = 0;
  const seal = (): void => { fired++; };
  r.markBackgroundHeld('s1', 'web:abc', { onSuperseded: seal, onStop: seal });

  r.clearBackgroundHeld('s1');
  assert.equal(r.has('s1'), false);
  assert.deepEqual(r.sessionsOnChannel('web:abc'), []);
  assert.equal(r.stopHolds('s1'), false);
  assert.equal(fired, 0);
});

test('clear() empties every hold and its handles', () => {
  const r = new RunRegistry();
  const boom = (): never => { throw new Error('must not fire'); };
  r.markBackgroundHeld('s1', 'web:abc', { onSuperseded: boom, onStop: boom });
  r.markBackgroundHeld('s2', 'web:xyz');

  r.clear();
  assert.deepEqual(r.listIds(), []);
  assert.deepEqual(r.sessionsOnChannel('web:abc'), []);
  assert.equal(r.stopHolds('s1'), false);
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
  r.setHoldHandles('s1', 'web-bg-hold', { onStop: () => {
    fired++;
    r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: false, backgroundRunning: false });
  } });

  r.stopHolds('s1');
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

// ── P1.8 run lookup for mid-turn injection ─────────────────────────────

test('getRunByChannel returns the newest live run and skips run-less executions', () => {
  const r = new RunRegistry();
  const older = { steer: async () => 'refused' as const, respondToDialog: () => false };
  const newer = { steer: async () => 'folded' as const, respondToDialog: () => false };
  r.register(makeInput({ executionId: 'exec-1', channel: 'web:s1' }));
  r.register(makeInput({ executionId: 'exec-2', channel: 'web:s1', run: older }));
  r.register(makeInput({ executionId: 'exec-3', channel: 'web:s1', run: newer }));

  assert.equal(r.getRunByChannel('web:s1'), newer);
  assert.equal(r.getRunByChannel('web:none'), null);
});
