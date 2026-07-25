import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { BgHeldSessions, bgHeldSessions } from '../../src/core/bg-held-sessions.js';

// The queryable snapshot of the web bg-hold (session.status backgroundRunning delta):
// mirrors the event stream so sessions.list can restore the state on any client
// mount / session switch / app restart. Held = the last status event for the session
// said running:true AND backgroundRunning:true; anything else clears.

beforeEach(() => bgHeldSessions.clear());

test('marks a session held on running+backgroundRunning', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  assert.equal(t.has('s1'), true);
  assert.equal(t.has('s2'), false);
});

test('clears the hold when running:false lands (seal / max-wait release)', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false, backgroundRunning: false });
  assert.equal(t.has('s1'), false);
});

test('a plain turn start (running:true, no bg flag) clears the hold — foreground turn supersedes', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: true });
  assert.equal(t.has('s1'), false);
});

test('a plain turn end (running:false, no bg flag) clears the hold', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false });
  assert.equal(t.has('s1'), false);
});

test('re-arm keeps the session held across chained background work', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  assert.equal(t.has('s1'), true);
});

test('sessions are tracked independently', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's2', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false });
  assert.equal(t.has('s1'), false);
  assert.equal(t.has('s2'), true);
});

test('events without a sessionId are ignored', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: '', running: true, backgroundRunning: true });
  assert.equal(t.has(''), false);
});

test('clear() empties the registry (test hygiene / restart semantics)', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.clear();
  assert.equal(t.has('s1'), false);
});

// --- Stop path: channel index + abort handle (a bg-held session has no live execution, so the
// channel-keyed cancel path must find it here or Stop silently does nothing).

test('records the channel a hold lives on (reverse lookup for the Stop path)', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's2', channel: 'web:xyz', running: true, backgroundRunning: true });
  assert.deepEqual(t.sessionsOnChannel('web:abc'), ['s1']);
  assert.deepEqual(t.sessionsOnChannel('web:xyz'), ['s2']);
  assert.deepEqual(t.sessionsOnChannel('web:none'), []);
  assert.deepEqual(t.sessionsOnChannel(''), []);
});

test('sessionsOnChannel drops the session once the hold is sealed', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: false, backgroundRunning: false });
  assert.deepEqual(t.sessionsOnChannel('web:abc'), []);
});

test('abort() fires the registered seal exactly once', () => {
  const t = new BgHeldSessions();
  let fired = 0;
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.setAbort('s1', () => { fired++; });
  assert.equal(t.abort('s1'), true);
  assert.equal(fired, 1);
  assert.equal(t.abort('s1'), false, 'single-fire: handle dropped before invoking');
  assert.equal(fired, 1);
});

test('abort() on a session with no hold is a no-op', () => {
  const t = new BgHeldSessions();
  assert.equal(t.abort('nope'), false);
});

test('sealing the hold drops its abort handle (no stale abort after the hold ends)', () => {
  const t = new BgHeldSessions();
  let fired = 0;
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.setAbort('s1', () => { fired++; });
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: false });
  assert.equal(t.abort('s1'), false);
  assert.equal(fired, 0);
});

test('clear() drops abort handles too', () => {
  const t = new BgHeldSessions();
  t.onSessionStatus({ sessionId: 's1', channel: 'web:abc', running: true, backgroundRunning: true });
  t.setAbort('s1', () => { throw new Error('must not fire'); });
  t.clear();
  assert.equal(t.abort('s1'), false);
  assert.deepEqual(t.sessionsOnChannel('web:abc'), []);
});

test('singleton export shares one registry', () => {
  bgHeldSessions.onSessionStatus({ sessionId: 'sx', running: true, backgroundRunning: true });
  assert.equal(bgHeldSessions.has('sx'), true);
  bgHeldSessions.clear();
  assert.equal(bgHeldSessions.has('sx'), false);
});
