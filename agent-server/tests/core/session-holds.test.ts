// input:  core/session-holds.ts
// output: the hold lifecycle Stop / supersede / sessions.list depend on
//
// Moved out of tests/runs/registry.test.ts by T2.1 (the code moved out of RunRegistry).
// Assertions unchanged.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { SessionHolds } from '../../src/core/session-holds.js';

// ── background-hold lifecycle: mark → has/listIds/sessionsOnChannel → abort → clear ──

test('markBackgroundHeld records the channel and is queryable', () => {
  const r = new SessionHolds();
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
  const r = new SessionHolds();
  r.markBackgroundHeld('s1', 'web:abc');
  r.markBackgroundHeld('s1', null);
  assert.deepEqual(r.sessionsOnChannel('web:abc'), ['s1']);
});

test('markBackgroundHeld ignores an empty session id', () => {
  const r = new SessionHolds();
  r.markBackgroundHeld('', 'web:abc');
  assert.equal(r.has(''), false);
  assert.deepEqual(r.listIds(), []);
});

test('markBackgroundHeld registers hold handles that fire exactly once', () => {
  const r = new SessionHolds();
  let fired = 0;
  const seal = (): void => { fired++; };
  r.markBackgroundHeld('s1', 'web:abc', { onSuperseded: seal, onStop: seal });

  assert.equal(r.stopHolds('s1'), true);
  assert.equal(fired, 1);
  assert.equal(r.stopHolds('s1'), false, 'single-fire: handles dropped before invoking');
  assert.equal(fired, 1);
});

test('setHoldHandles registers handles and stopHolds() fires them once', () => {
  const r = new SessionHolds();
  let fired = 0;
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'web-status-hold', { onStop: () => { fired++; } });

  assert.equal(r.stopHolds('s1'), true);
  assert.equal(fired, 1);
  assert.equal(r.stopHolds('s1'), false);
});

// ── the two verbs ──────────────────────────────────────────────────────
//
// One slot per session used to carry handles that meant two different things. A foreground turn
// fired it to RELEASE a passive hold; a backgrounded `agent` run had put "stop the child" there.

test('supersedeHolds fires onSuperseded and KEEPS onStop — the work is still running', () => {
  const r = new SessionHolds();
  const seen: string[] = [];
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'agent-run:sa_1', { onStop: () => seen.push('stop') });

  assert.equal(r.supersedeHolds('s1'), false, 'a work-owning hold has nothing to yield');
  assert.deepEqual(seen, [], 'a new foreground turn must never stop a running child');

  assert.equal(r.stopHolds('s1'), true, 'Stop still reaches it');
  assert.deepEqual(seen, ['stop']);
});

test('supersedeHolds fires a status-only hold and leaves it unable to fire twice', () => {
  const r = new SessionHolds();
  const seen: string[] = [];
  const seal = (): void => { seen.push('seal'); };
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'web-status-hold', { onSuperseded: seal, onStop: seal });

  assert.equal(r.supersedeHolds('s1'), true);
  assert.deepEqual(seen, ['seal']);
  assert.equal(r.supersedeHolds('s1'), false, 'single-fire');
  assert.deepEqual(seen, ['seal']);
});

test('two owners hold one session independently — neither erases the other', () => {
  const r = new SessionHolds();
  const seen: string[] = [];
  r.markBackgroundHeld('s1', 'web:abc');
  r.setHoldHandles('s1', 'web-status-hold', { onSuperseded: () => seen.push('web-seal'), onStop: () => seen.push('web-seal') });
  r.setHoldHandles('s1', 'agent-run:sa_1', { onStop: () => seen.push('stop-child') });

  assert.equal(r.stopHolds('s1'), true);
  assert.deepEqual(seen.sort(), ['stop-child', 'web-seal'], 'Stop reaches BOTH holders');
});

test('dropHoldHandles removes one owner and leaves the rest holding', () => {
  const r = new SessionHolds();
  const seen: string[] = [];
  r.setHoldHandles('s1', 'agent-run:sa_1', { onStop: () => seen.push('one') });
  r.setHoldHandles('s1', 'agent-run:sa_2', { onStop: () => seen.push('two') });

  r.dropHoldHandles('s1', 'agent-run:sa_1');
  assert.equal(r.stopHolds('s1'), true);
  assert.deepEqual(seen, ['two']);
});

test('clearing the status hold leaves a work-owning holder\'s Stop handle armed', () => {
  const r = new SessionHolds();
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
  const r = new SessionHolds();
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
  const r = new SessionHolds();
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
  const r = new SessionHolds();
  r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  assert.equal(r.has('s1'), true);

  r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true });
  assert.equal(r.has('s1'), false, 'a plain turn start supersedes the hold');
});

test('onSessionStatus clears the hold when the seal republishes running:false', () => {
  const r = new SessionHolds();
  let fired = 0;
  r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  r.setHoldHandles('s1', 'web-status-hold', { onStop: () => {
    fired++;
    r.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: false, backgroundRunning: false });
  } });

  r.stopHolds('s1');
  assert.equal(fired, 1);
  assert.equal(r.has('s1'), false);
});
