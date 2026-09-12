import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RunRegistry } from '../../src/core/run-registry.js';

// The queryable snapshot of the web bg-hold (session.status backgroundRunning delta):
// mirrors the event stream so sessions.list can restore the state on any client
// mount / session switch / app restart. Held = the last status event for the session
// said running:true AND backgroundRunning:true; anything else clears.

test('marks a session held on running+backgroundRunning', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  assert.equal(t.has('s1'), true);
  assert.equal(t.has('s2'), false);
});

test('clears the hold when running:false lands (seal / max-wait release)', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false, backgroundRunning: false });
  assert.equal(t.has('s1'), false);
});

test('a plain turn start (running:true, no bg flag) clears the hold — foreground turn supersedes', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: true });
  assert.equal(t.has('s1'), false);
});

test('a plain turn end (running:false, no bg flag) clears the hold', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false });
  assert.equal(t.has('s1'), false);
});

test('re-arm keeps the session held across chained background work', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  assert.equal(t.has('s1'), true);
});

test('sessions are tracked independently', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's2', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false });
  assert.equal(t.has('s1'), false);
  assert.equal(t.has('s2'), true);
});

test('events without a sessionId are ignored', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: '', running: true, backgroundRunning: true });
  assert.equal(t.has(''), false);
});

test('clear() empties the registry (test hygiene / restart semantics)', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.clear();
  assert.equal(t.has('s1'), false);
});

// --- Stop path: channel index + abort handle (a bg-held session has no live execution, so the
// channel-keyed cancel path must find it here or Stop silently does nothing).

test('records the channel a hold lives on (reverse lookup for the Stop path)', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's2', channel: 'web:xyz', running: true, backgroundRunning: true });
  assert.deepEqual(t.sessionsOnChannel('web:abc'), ['s1']);
  assert.deepEqual(t.sessionsOnChannel('web:xyz'), ['s2']);
  assert.deepEqual(t.sessionsOnChannel('web:none'), []);
  assert.deepEqual(t.sessionsOnChannel(''), []);
});

test('sessionsOnChannel drops the session once the hold is sealed', () => {
  const t = new RunRegistry();
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: false, backgroundRunning: false });
  assert.deepEqual(t.sessionsOnChannel('web:abc'), []);
});

test('stopHolds() fires the registered seal exactly once', () => {
  const t = new RunRegistry();
  let fired = 0;
  const seal = (): void => { fired++; };
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.setHoldHandles('s1', 'web-bg-hold', { onSuperseded: seal, onStop: seal });
  assert.equal(t.stopHolds('s1'), true);
  assert.equal(fired, 1);
  assert.equal(t.stopHolds('s1'), false, 'single-fire: handles dropped before invoking');
  assert.equal(fired, 1);
});

test('stopHolds() on a session with no hold is a no-op', () => {
  const t = new RunRegistry();
  assert.equal(t.stopHolds('nope'), false);
});

test('sealing the hold drops its handles (no stale Stop after the hold ends)', () => {
  const t = new RunRegistry();
  let fired = 0;
  const seal = (): void => { fired++; };
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.setHoldHandles('s1', 'web-bg-hold', { onSuperseded: seal, onStop: seal });
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: false });
  assert.equal(t.stopHolds('s1'), false);
  assert.equal(fired, 0);
});

test('clear() drops hold handles too', () => {
  const t = new RunRegistry();
  const boom = (): never => { throw new Error('must not fire'); };
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.setHoldHandles('s1', 'web-bg-hold', { onSuperseded: boom, onStop: boom });
  t.clear();
  assert.equal(t.stopHolds('s1'), false);
  assert.deepEqual(t.sessionsOnChannel('web:abc'), []);
});
