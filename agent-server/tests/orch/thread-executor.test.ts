// input:  ThreadExecutor class
// output: unit tests — thread routing coordination [S8-A]
// pos:    verifies (a) +1/-1 trackPendingTask via injectable track; (b) enqueue called;
//         (c) hourglass when queue exists; (d) threadExecutor singleton exists;
//         (e) route() works without existing queue (no addReaction);
//         (f) ThreadExecutor default constructor uses real enqueue
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ThreadExecutor, threadExecutor } from '../../src/orchestration/thread-executor.js';
import { enqueue, conduitQueues } from '../../src/orchestration/conduit-queue.js';
import { MockAdapter } from '../../src/platform/testing.js';

// ── helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
function freshChannel() { return `te-test-${++_seq}`; }

function makeCtx(channel: string, overrides: Record<string, any> = {}) {
  return {
    message: { ref: { conduit: channel, messageId: 'M1', threadId: null }, text: 'hi', isBot: false, files: [], subtype: undefined } as any,
    channel,
    adapter: new MockAdapter() as any,
    threadAnchorId: null,
    hasFiles: false,
    agentMessage: 'hello',
    threadAddMatch: null,
    threadStartMatch: null,
    existingThread: null,
    isActiveThread: false,
    ...overrides,
  };
}

// ── (a) +1/-1 trackPendingTask ────────────────────────────────────────────────

test('(a) route() calls track(+1) then enqueue fn calls track(-1) in finally', async () => {
  const trackCalls: number[] = [];
  const enqueueFns: Array<() => Promise<void>> = [];
  // Injectable execute to avoid running real thread operations
  const executor = new ThreadExecutor({
    enqueue: (_ch, fn) => { enqueueFns.push(fn); return false; },
    track: (d) => { trackCalls.push(d); },
    execute: async () => { throw new Error('test-controlled rejection'); },
  });

  const channel = freshChannel();
  const ctx = makeCtx(channel, { threadStartMatch: ['!thread coder hi', 'coder', 'hi'] as any });
  await executor.route(ctx as any);

  assert.deepEqual(trackCalls, [+1], 'track(+1) called synchronously by route()');
  assert.equal(enqueueFns.length, 1, 'one enqueue fn captured');

  // Run the captured fn — lightweight rejection, track(-1) must fire in finally
  try { await enqueueFns[0](); } catch {}

  assert.ok(trackCalls.includes(-1), 'track(-1) called in finally');
});

// ── (b) enqueue called with correct channel ───────────────────────────────────

test('(b) route() calls enqueue with the correct channel', async () => {
  const channel = freshChannel();
  const enqueueCalls: string[] = [];
  const executor = new ThreadExecutor({
    enqueue: (ch, _fn) => { enqueueCalls.push(ch); return false; },
    track: () => {},
  });

  const ctx = makeCtx(channel, { threadAddMatch: ['!thread add main', 'main'] as any });
  await executor.route(ctx as any);

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0], channel);
});

// ── (c) hourglass reaction when prior queue exists ────────────────────────────

test('(c) route() calls addReaction(hourglass) when channel already has a running queue', async () => {
  const channel = freshChannel();
  // Pre-seed a blocking queue
  let unlockPrior!: () => void;
  const priorBlock = new Promise<void>(r => { unlockPrior = r; });
  enqueue(channel, () => priorBlock);

  const enqueueCalls: string[] = [];
  const adapter = new MockAdapter();
  const executor = new ThreadExecutor({
    enqueue: (ch, _fn) => { enqueueCalls.push(ch); return true; },
    track: () => {},
  });

  const ctx = makeCtx(channel, { adapter, threadStartMatch: ['!thread coder hi', 'coder', 'hi'] as any });
  await executor.route(ctx as any);

  // markQueued should have been called when the channel already had a queue
  assert.equal(adapter.marksQueued.length, 1, 'markQueued was called once');
  assert.equal(adapter.marksQueued[0].ref.conduit, channel, 'markQueued called with correct channel');
  assert.equal(adapter.marksQueued[0].ref.messageId, 'M1', 'markQueued called with correct messageId');
  assert.equal(enqueueCalls.length, 1, 'enqueue was called');

  unlockPrior();
  const tail = conduitQueues.get(channel);
  if (tail) await tail;
});

// ── (d) threadExecutor singleton exists ──────────────────────────────────────

test('(d) threadExecutor singleton is a ThreadExecutor with a route method', () => {
  assert.ok(threadExecutor instanceof ThreadExecutor);
  assert.equal(typeof threadExecutor.route, 'function');
});

// ── (e) route() without existing queue does NOT call addReaction ───────────────

test('(e) route() on fresh channel skips addReaction (no prior queue)', async () => {
  const channel = freshChannel();
  const enqueueCalls: string[] = [];
  const adapter = new MockAdapter();
  // addReaction on MockAdapter shouldn't throw; we just verify the executor doesn't throw
  const executor = new ThreadExecutor({
    enqueue: (ch, _fn) => { enqueueCalls.push(ch); return false; },
    track: () => {},
  });

  const ctx = makeCtx(channel, { adapter });
  await executor.route(ctx as any);

  assert.equal(enqueueCalls.length, 1, 'enqueue was called');
  // No prior queue → markQueued was NOT called (conduitQueues.has returned false)
  assert.equal(adapter.marksQueued.length, 0, 'markQueued was not called when no prior queue');
  assert.ok(true, 'route() completed synchronously without throwing');
});

// ── (f) ThreadExecutor default constructor uses real enqueue ──────────────────

test('(f) ThreadExecutor constructed with no opts uses module-level enqueue', () => {
  const executor = new ThreadExecutor();
  assert.equal(executor._enqueue, enqueue, 'defaults to module-level enqueue');
});

// ── (g) message buffering when thread has a running step ─────────────────────

test('(g) route() buffers user message when thread is running a step, skips enqueue', async () => {
  const channel = freshChannel();
  const enqueueCalls: string[] = [];
  const adapter = new MockAdapter();

  const executor = new ThreadExecutor({
    enqueue: (_ch, _fn) => { enqueueCalls.push(_ch); return false; },
    track: () => {},
  });

  const runningThread = {
    id: 'thr_test-buffer',
    status: 'running',
    channel,
    steps: [{ output: undefined }],
    metadata: {},
  };

  const ctx = makeCtx(channel, {
    adapter,
    existingThread: runningThread,
    isActiveThread: true,
    agentMessage: 'continue please',
    threadAnchorId: '123.456',
  });
  delete (ctx as any).threadAddMatch;
  delete (ctx as any).threadStartMatch;

  await executor.route(ctx as any);

  assert.equal(enqueueCalls.length, 0, 'enqueue was not called when thread is running');
  assert.ok(adapter.posted.length > 0, 'a message was posted');
  assert.match(adapter.posted[0].content.text, /buffered|inbox/i);
});
