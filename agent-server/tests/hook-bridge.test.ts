// input:  hook-bridge, EventBus, MockAdapter
// output: regression tests for webhook→bus.publish→subscriber→Slack-side-effect chain (S5)
// pos:    verifies that registerAskQuestion / registerPlanApproval publish to the bus, that a
//         subscriber can produce platform side effects, and that resolveRequest still resolves
//         the blocking Promise after the S5 refactor

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';

// Fresh module state per test — re-import via dynamic import to avoid shared module singletons
async function freshHookBridge() {
  // Node.js ESM module cache: re-use the same module instance across tests in a single run.
  // hook-bridge.ts uses module-level state (_bus, pendingRequests).  We reset between tests by
  // calling initHookBridge with a new bus rather than reimporting.
  const mod = await import('../src/orchestration/routing/hook-bridge.js');
  return mod;
}

// ── (1) registerAskQuestion publishes ask-user.requested ───────────────────────

test('registerAskQuestion publishes ask-user.requested event to bus with correct fields', async () => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);

  const received: CortexEvent[] = [];
  bus.subscribe('ask-user.requested', (e) => { received.push(e); });

  // Don't await — the Promise stays pending until resolveRequest is called
  const resultPromise = hb.registerAskQuestion('req-1', 'C_TEST', 'sess-1', [{ q: 'What is X?' }]);

  assert.equal(received.length, 1, 'exactly one ask-user.requested event published');
  const ev = received[0] as Extract<CortexEvent, { type: 'ask-user.requested' }>;
  assert.equal(ev.type, 'ask-user.requested');
  assert.equal(ev.requestId, 'req-1');
  assert.equal(ev.channel, 'C_TEST');
  assert.equal(ev.sessionId, 'sess-1');
  assert.deepEqual(ev.questions, [{ q: 'What is X?' }]);

  // Clean up: resolve so the Promise does not leak
  hb.resolveRequest('req-1', { answers: {} });
  await resultPromise;
});

// ── (1b) registerAskQuestion carries the optional severity level ───────────────

test('registerAskQuestion publishes ask-user.requested with the severity level', async () => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);

  const received: CortexEvent[] = [];
  bus.subscribe('ask-user.requested', (e) => { received.push(e); });

  const resultPromise = hb.registerAskQuestion('req-lvl', 'C_LVL', 'sess-lvl', [{ q: 'Danger?' }], false, null, 'warning');

  assert.equal(received.length, 1);
  const ev = received[0] as Extract<CortexEvent, { type: 'ask-user.requested' }>;
  assert.equal(ev.level, 'warning');

  hb.resolveRequest('req-lvl', { answers: {} });
  await resultPromise;
});

// ── (4) resolveRequest resolves the pending Promise (blocking-wait lifecycle intact) ──

test('resolveRequest resolves the Promise returned by registerAskQuestion', async () => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);

  // No subscriber needed — we only verify the Promise lifecycle
  const resultPromise = hb.registerAskQuestion('req-4', 'C_RESOLVE', 'sess-4', []);

  const expectedResult = { answers: { q: 'yes' } };
  const resolved = hb.resolveRequest('req-4', expectedResult);
  assert.ok(resolved, 'resolveRequest returns true when pending request exists');

  const actual = await resultPromise;
  assert.deepEqual(actual, expectedResult, 'Promise resolves with the data passed to resolveRequest');

  // Second resolve attempt returns false (already deleted)
  const secondAttempt = hb.resolveRequest('req-4', {});
  assert.ok(!secondAttempt, 'resolveRequest returns false for already-resolved requestId');
});

// ── (5) TTL stale cleanup notifies the onStale hook (web-interactions-redesign) ──

test('cleanupStale resolves timed-out requests and fires the onStale callback', async (t) => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);
  t.onTestFinished(() => hb.setOnStale(null));

  const stale: { requestId: string; channel: string; sessionId: string }[] = [];
  hb.setOnStale((requestId, channel, sessionId) => { stale.push({ requestId, channel, sessionId }); });

  const resultPromise = hb.registerPlanApproval('req-ttl', 'web:sess-t', 'sess-t', '# plan', {});

  // Not yet stale — nothing happens.
  hb.cleanupStale(Date.now());
  assert.equal(stale.length, 0);

  // 31 minutes later — the request is stale: resolver fires with timeout, onStale notified.
  hb.cleanupStale(Date.now() + 31 * 60 * 1000);
  const result = await resultPromise;
  assert.equal(result.error, 'timeout');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].requestId, 'req-ttl');
  assert.equal(stale[0].channel, 'web:sess-t');
  assert.equal(stale[0].sessionId, 'sess-t');
});

// ── (6) Non-blocking ask returns at once but stays under the TTL sweep ─────────

test('registerAskQuestion with blocking=false resolves immediately and marks the event non-blocking', async () => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);

  const received: CortexEvent[] = [];
  bus.subscribe('ask-user.requested', (e) => { received.push(e); });

  const result = await hb.registerAskQuestion('req-nb', 'web:sess-nb', 'sess-nb', [{ q: 'Which DB?' }], false, null, null, false);
  assert.equal(result.posted, true);
  assert.equal(result.requestId, 'req-nb');

  const ev = received[0] as Extract<CortexEvent, { type: 'ask-user.requested' }>;
  assert.equal(ev.blocking, false);

  // hook-bridge keeps module-level state across tests: drop the entry so a later TTL sweep is clean.
  hb.resolveRequest('req-nb', { answers: {} });
});

test('an unanswered non-blocking ask is still swept by the TTL cleanup', async (t) => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);
  t.onTestFinished(() => hb.setOnStale(null));

  const stale: string[] = [];
  hb.setOnStale((requestId) => { stale.push(requestId); });

  await hb.registerAskQuestion('req-nb-ttl', 'web:sess-nb2', 'sess-nb2', [{ q: 'Which DB?' }], false, null, null, false);
  hb.cleanupStale(Date.now() + 31 * 60 * 1000);
  assert.deepEqual(stale, ['req-nb-ttl']);
});

test('an answered non-blocking ask is removed from the pending set before the TTL fires', async (t) => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);
  t.onTestFinished(() => hb.setOnStale(null));

  const stale: string[] = [];
  hb.setOnStale((requestId) => { stale.push(requestId); });

  await hb.registerAskQuestion('req-nb-answered', 'web:sess-nb3', 'sess-nb3', [{ q: 'Which DB?' }], false, null, null, false);
  assert.equal(hb.resolveRequest('req-nb-answered', { answers: { 'Which DB?': 'sqlite' } }), true);
  hb.cleanupStale(Date.now() + 31 * 60 * 1000);
  assert.deepEqual(stale, []);
});
