// input:  AgentRunner, queue, MockAdapter, agent config
// output: Queue-marker, injection, busy, and routing regressions
// pos:    Verifies plain user-message orchestration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AgentRunner, agentRunner, resolveDefaultAgent, emitTurnProgress } from '../../src/orchestration/agent-runner.js';
import { conduitQueues, enqueue } from '../../src/orchestration/conduit-queue.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { loadConfig } from '../../src/domain/threads/template-loader.js';
import { getActiveProfile } from '../../src/domain/agents/config.js';

// ── helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
function freshChannel() { return `ar-test-${++_seq}`; }

function makeCtx(overrides: Record<string, any> = {}) {
  const channel = overrides.channel ?? freshChannel();
  return {
    message: { ref: { conduit: channel, messageId: 'M1', threadId: null }, text: 'hi', isBot: false, files: [], subtype: undefined } as any,
    channel,
    adapter: new MockAdapter() as any,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: 'hi',
    agentMessage: 'hi',
    ...overrides,
  };
}

// ── emitTurnProgress: real agent-turn delta for the S4 chat composer ─────────

test('emitTurnProgress publishes numTurns + updates the live execution on a numeric num_turns', () => {
  const calls: { setNumTurns: number[]; publish: number[] } = { setNumTurns: [], publish: [] };
  emitTurnProgress(
    { sessionId: 's1', channel: 'C1', executionId: 'E1', setNumTurns: (n) => calls.setNumTurns.push(n), publish: (n) => calls.publish.push(n) },
    { num_turns: 4 },
  );
  assert.deepEqual(calls.setNumTurns, [4]);
  assert.deepEqual(calls.publish, [4]);
});

test('emitTurnProgress is a no-op when num_turns is missing / non-numeric', () => {
  const calls: number[] = [];
  const deps = { sessionId: 's1', channel: 'C1', executionId: 'E1', setNumTurns: (n: number) => calls.push(n), publish: (n: number) => calls.push(n) };
  emitTurnProgress(deps, {});
  emitTurnProgress(deps, { num_turns: null });
  emitTurnProgress(deps, { num_turns: 'x' as any });
  assert.deepEqual(calls, []);
});

test('emitTurnProgress skips publish when there is no sessionId, and skips setNumTurns when no executionId', () => {
  const set: number[] = []; const pub: number[] = [];
  // No sessionId → nothing published, but the live execution can still be updated.
  emitTurnProgress({ sessionId: null, channel: 'C1', executionId: 'E1', setNumTurns: (n) => set.push(n), publish: (n) => pub.push(n) }, { num_turns: 2 });
  assert.deepEqual(set, [2]);
  assert.deepEqual(pub, []);
  // No executionId → nothing to update on the live registry, but still published.
  set.length = 0; pub.length = 0;
  emitTurnProgress({ sessionId: 's1', channel: 'C1', executionId: null, setNumTurns: (n) => set.push(n), publish: (n) => pub.push(n) }, { num_turns: 2 });
  assert.deepEqual(set, []);
  assert.deepEqual(pub, [2]);
});

// ── (a) hourglass reaction when channel already has a queue ──────────────────

test('(a) route() calls addReaction(hourglass) when channel already has a queue', async () => {
  const channel = freshChannel();
  // Create a never-resolving fake prior queue entry to simulate an active queue
  const { promise, resolve: unlockPrior } = (() => {
    let res!: () => void;
    const p = new Promise<void>(r => { res = r; });
    return { promise: p, resolve: res };
  })();
  // Pre-seed conduitQueues for the channel by enqueuing a blocking task
  enqueue(channel, () => promise);

  const enqueueCalls: string[] = [];
  const enqueueFns: Array<() => Promise<void>> = [];
  const trackCalls: number[] = [];
  const runner = new AgentRunner({
    enqueue: (ch, fn) => { enqueueCalls.push(ch); enqueueFns.push(fn); return true; },
    track: (d) => { trackCalls.push(d); },
    execute: async () => {},
  });

  const adapter = new MockAdapter();
  const ctx = makeCtx({ channel, adapter });
  await runner.route(ctx as any);

  // Verify markQueued was called (MockAdapter records marksQueued)
  // assert that the runner called markQueued with the correct ref
  assert.equal(adapter.marksQueued.length, 1, 'markQueued was called once');
  assert.equal(adapter.marksQueued[0].ref.conduit, channel, 'markQueued called with correct channel');
  assert.equal(adapter.marksQueued[0].ref.messageId, 'M1', 'markQueued called with correct messageId');

  assert.equal(enqueueCalls.length, 1, 'enqueue was called for the channel');
  assert.equal(enqueueCalls[0], channel);
  assert.equal(adapter.marksUnqueued.length, 0, 'marker stays while its turn is pending');

  await enqueueFns[0]();
  assert.deepEqual(adapter.marksUnqueued, [{ ref: { conduit: channel, messageId: 'M1' } }], 'turn completion removes the marker');

  // Clean up: unblock the prior queue and drain
  unlockPrior();
  const tail = conduitQueues.get(channel);
  if (tail) await tail;
});

// ── (a2) mid-turn injection takes precedence over the queue ──────────────────

test('(a) queued marker is removed even when the queued turn fails', async () => {
  const channel = freshChannel();
  let unlockPrior!: () => void;
  const prior = new Promise<void>((resolve) => { unlockPrior = resolve; });
  enqueue(channel, () => prior);

  const enqueueFns: Array<() => Promise<void>> = [];
  const adapter = new MockAdapter();
  const runner = new AgentRunner({
    enqueue: (_ch, fn) => { enqueueFns.push(fn); return true; },
    track: () => {},
    execute: async () => { throw new Error('controlled failure'); },
  });
  await runner.route(makeCtx({ channel, adapter }) as any);
  await assert.rejects(enqueueFns[0], /controlled failure/);

  assert.equal(adapter.marksQueued.length, 1);
  assert.equal(adapter.marksUnqueued.length, 1, 'failure cleanup removes the marker exactly once');

  unlockPrior();
  const tail = conduitQueues.get(channel);
  if (tail) await tail;
});

test('(a2) route() injects into the live turn instead of queuing it behind that turn', async () => {
  const channel = freshChannel();
  const { promise, resolve: unlockPrior } = (() => {
    let res!: () => void;
    const p = new Promise<void>(r => { res = r; });
    return { promise: p, resolve: res };
  })();
  enqueue(channel, () => promise); // the channel is busy — today this message would wait

  const enqueueCalls: string[] = [];
  const trackCalls: number[] = [];
  const runner = new AgentRunner({
    enqueue: (ch, _fn) => { enqueueCalls.push(ch); return true; },
    track: (d) => { trackCalls.push(d); },
    tryInject: async () => true, // the backend took it into the running turn
  });

  const adapter = new MockAdapter();
  await runner.route(makeCtx({ channel, adapter }) as any);

  assert.equal(enqueueCalls.length, 0, 'an injected message is not queued behind the running turn');
  assert.equal(adapter.marksQueued.length, 0, 'and is never marked queued — it is already in front of the model');
  assert.deepEqual(trackCalls, [], 'the injection path owns its own busy bracket');

  unlockPrior();
  const tail = conduitQueues.get(channel);
  if (tail) await tail;
});

test('(a2) route() falls back to the normal queue when there is no live turn to inject into', async () => {
  const channel = freshChannel();
  const { promise, resolve: unlockPrior } = (() => {
    let res!: () => void;
    const p = new Promise<void>(r => { res = r; });
    return { promise: p, resolve: res };
  })();
  enqueue(channel, () => promise);

  const enqueueCalls: string[] = [];
  const trackCalls: number[] = [];
  const runner = new AgentRunner({
    enqueue: (ch, _fn) => { enqueueCalls.push(ch); return true; },
    track: (d) => { trackCalls.push(d); },
    tryInject: async () => false, // no live turn / incapable backend / !command
  });

  const adapter = new MockAdapter();
  await runner.route(makeCtx({ channel, adapter }) as any);

  assert.deepEqual(enqueueCalls, [channel], 'today’s queue behaviour is preserved exactly');
  assert.equal(adapter.marksQueued.length, 1, 'and the queued-message feedback still fires');
  assert.deepEqual(trackCalls, [+1], 'the queued turn takes the busy gate as before');

  unlockPrior();
  const tail = conduitQueues.get(channel);
  if (tail) await tail;
});

// ── (b) +1 / -1 trackPendingTask via injectable track ────────────────────────

test('(b) route() calls track(+1) then the enqueue fn calls track(-1) in finally', async () => {
  const trackCalls: number[] = [];
  const enqueueFns: Array<() => Promise<void>> = [];
  // Use injectable execute to avoid spawning real Claude
  const runner = new AgentRunner({
    enqueue: (_ch, fn) => { enqueueFns.push(fn); return false; },
    track: (d) => { trackCalls.push(d); },
    execute: async () => { throw new Error('test-controlled rejection'); },
  });

  const ctx = makeCtx();
  await runner.route(ctx as any);

  // track(+1) must have been called synchronously during route()
  assert.deepEqual(trackCalls, [+1], 'track(+1) called once by route()');
  assert.equal(enqueueFns.length, 1, 'enqueue fn captured');

  // Execute the captured fn — lightweight rejection, track(-1) must run in finally
  try { await enqueueFns[0](); } catch {}

  assert.ok(trackCalls.includes(-1), 'track(-1) called in finally by enqueue fn');
});

// ── (c) enqueue is called with the correct channel ───────────────────────────

test('(c) route() calls enqueue with the correct channel', async () => {
  const channel = freshChannel();
  const enqueueCalls: Array<{ ch: string }> = [];
  const runner = new AgentRunner({
    enqueue: (ch, _fn) => { enqueueCalls.push({ ch }); return false; },
    track: () => {},
  });

  const ctx = makeCtx({ channel });
  await runner.route(ctx as any);

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].ch, channel);
});

// ── (d) resolveDefaultAgent — no default agent → uses activeProfile ───────────

test('(d) resolveDefaultAgent with no default agent uses activeProfile for profileForRun', () => {
  // When mode-manager has no default agent (getDefaultAgent() returns null/empty),
  // resolveDefaultAgent returns effectiveMessage unchanged and uses activeProfile.
  const result = resolveDefaultAgent('my task');
  assert.equal(typeof result.effectiveMessage, 'string');
  // profileForRun is getActiveProfile(channel), typed string | null — with no default agent it
  // equals the active profile (null when none is configured). Verify the "uses activeProfile"
  // claim directly instead of asserting a type the contract does not guarantee.
  assert.equal(result.profileForRun, getActiveProfile());
  // The message is either the original or prepended with directive
  assert.ok(result.effectiveMessage.includes('my task'));
  assert.equal(result.defaultAgentName === null || typeof result.defaultAgentName === 'string', true);
});

// ── (e) agentRunner singleton exists and has route method ────────────────────

test('(e) agentRunner singleton is an AgentRunner with a route method', () => {
  assert.ok(agentRunner instanceof AgentRunner);
  assert.equal(typeof agentRunner.route, 'function');
});

// ── (f) AgentRunner default constructor uses real enqueue + trackPendingTask ──

test('(f) AgentRunner constructed with no opts uses module-level defaults', () => {
  const runner = new AgentRunner();
  assert.equal(runner._enqueue, enqueue, 'defaults to module-level enqueue');
});

