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

test('singleton export shares one registry', () => {
  bgHeldSessions.onSessionStatus({ sessionId: 'sx', running: true, backgroundRunning: true });
  assert.equal(bgHeldSessions.has('sx'), true);
  bgHeldSessions.clear();
  assert.equal(bgHeldSessions.has('sx'), false);
});
