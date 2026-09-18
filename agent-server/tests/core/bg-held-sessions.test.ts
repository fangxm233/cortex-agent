import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SessionHolds } from '../../src/core/session-holds.js';

// The queryable snapshot of the web bg-hold (session.status backgroundRunning delta):
// mirrors the event stream so sessions.list can restore the state on any client
// mount / session switch / app restart. Held = the last status event for the session
// said running:true AND backgroundRunning:true; anything else clears.

test('marks a session held on running+backgroundRunning', () => {
  const t = new SessionHolds();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  assert.equal(t.has('s1'), true);
  assert.equal(t.has('s2'), false);
});

test('clears the hold when running:false lands (seal / max-wait release)', () => {
  const t = new SessionHolds();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false, backgroundRunning: false });
  assert.equal(t.has('s1'), false);
});

test('a plain turn start (running:true, no bg flag) clears the hold — foreground turn supersedes', () => {
  const t = new SessionHolds();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: true });
  assert.equal(t.has('s1'), false);
});

test('a plain turn end (running:false, no bg flag) clears the hold', () => {
  const t = new SessionHolds();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false });
  assert.equal(t.has('s1'), false);
});

test('re-arm keeps the session held across chained background work', () => {
  const t = new SessionHolds();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  assert.equal(t.has('s1'), true);
});

test('sessions are tracked independently', () => {
  const t = new SessionHolds();
  t.onSessionStatus({ sessionId: 's1', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's2', running: true, backgroundRunning: true });
  t.onSessionStatus({ sessionId: 's1', running: false });
  assert.equal(t.has('s1'), false);
  assert.equal(t.has('s2'), true);
});
