// input:  hook-bridge, EventBus, MockAdapter
// output: regression tests for webhook→bus.publish→subscriber→Slack-side-effect chain (S5)
// pos:    verifies that registerAskQuestion / registerPlanApproval publish to the bus, that a
//         subscriber can produce platform side effects, and that resolveRequest still resolves
//         the blocking Promise after the S5 refactor
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';
import { MockAdapter } from '../src/platform/testing.js';

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

// ── (2) registerAskQuestion → subscriber → MockAdapter.postMessage ─────────────

test('ask-user.requested subscriber calls MockAdapter.postMessage (Slack side effect)', async () => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);

  const mockAdapter = new MockAdapter();

  // Inline subscriber simulating the app.ts 'ask-user.requested' handler (minimal wiring)
  bus.subscribe('ask-user.requested', async (e) => {
    const ev = e as Extract<CortexEvent, { type: 'ask-user.requested' }>;
    const text = `Questions (${ev.questions.length})`;
    await mockAdapter.postMessage({ type: 'interactive-reply', conduit: ev.channel, sessionId: ev.sessionId }, { text });
  });

  const resultPromise = hb.registerAskQuestion('req-2', 'C_ASK', 'sess-2', [{ q: 'Pick one?' }]);

  // bus.publish is synchronous fan-out; async handlers are fire-and-forget.
  // Flush the microtask queue so the async subscriber body runs before our assert.
  await new Promise(setImmediate as any);

  assert.equal(mockAdapter.posted.length, 1, 'exactly one message posted to mock adapter');
  assert.equal((mockAdapter.posted[0].destination as { conduit: string }).conduit, 'C_ASK');
  assert.equal((mockAdapter.posted[0].content as any).text, 'Questions (1)');

  hb.resolveRequest('req-2', { answers: {} });
  await resultPromise;
});

// ── (3) registerPlanApproval → subscriber → MockAdapter.postInteractive ────────

test('registerPlanApproval publishes plan.submitted and subscriber calls MockAdapter.postInteractive', async () => {
  const bus = new EventBus();
  const hb = await freshHookBridge();
  hb.initHookBridge(bus);

  const mockAdapter = new MockAdapter();

  bus.subscribe('plan.submitted', async (e) => {
    const ev = e as Extract<CortexEvent, { type: 'plan.submitted' }>;
    await mockAdapter.postInteractive({ type: 'interactive-reply', conduit: ev.channel, sessionId: ev.sessionId }, {
      text: 'Plan approval',
      richBlocks: [],
      actions: [{ type: 'button', text: 'Approve', value: ev.requestId, actionId: 'plan_approve' }],
    });
  });

  const resultPromise = hb.registerPlanApproval('req-3', 'C_PLAN', 'sess-3', 'do the thing', {});

  await new Promise(setImmediate as any);

  assert.equal(mockAdapter.posted.length, 1, 'exactly one interactive message posted');
  assert.equal((mockAdapter.posted[0].destination as { conduit: string }).conduit, 'C_PLAN');
  assert.equal((mockAdapter.posted[0].content as any).text, 'Plan approval');

  const actions = mockAdapter.posted[0].actions ?? [];
  assert.equal(actions.length, 1);
  assert.equal((actions[0] as any).value, 'req-3', 'requestId propagated to action value');

  hb.resolveRequest('req-3', { approved: true, reason: '' });
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
