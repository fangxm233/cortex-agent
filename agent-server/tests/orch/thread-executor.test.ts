// input:  ThreadExecutor, platform files, readiness registry
// output: thread routing, file buffering, and eviction regressions
// pos:    Verifies thread queueing and buffered-input coordination
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ThreadExecutor } from '../../src/orchestration/thread-executor.js';
import { enqueue, conduitQueues } from '../../src/orchestration/conduit-queue.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { waitForPendingUserInputs } from '../../src/domain/threads/pending-user-inputs.js';

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
  const enqueueFns: Array<() => Promise<void>> = [];
  const adapter = new MockAdapter();
  const executor = new ThreadExecutor({
    enqueue: (ch, fn) => { enqueueCalls.push(ch); enqueueFns.push(fn); return true; },
    track: () => {},
    execute: async () => {},
  });

  const ctx = makeCtx(channel, { adapter, threadStartMatch: ['!thread coder hi', 'coder', 'hi'] as any });
  await executor.route(ctx as any);

  // markQueued should have been called when the channel already had a queue
  assert.equal(adapter.marksQueued.length, 1, 'markQueued was called once');
  assert.equal(adapter.marksQueued[0].ref.conduit, channel, 'markQueued called with correct channel');
  assert.equal(adapter.marksQueued[0].ref.messageId, 'M1', 'markQueued called with correct messageId');
  assert.equal(enqueueCalls.length, 1, 'enqueue was called');
  assert.equal(adapter.marksUnqueued.length, 0, 'marker stays while the turn is pending');

  await enqueueFns[0]();
  assert.equal(adapter.marksUnqueued.length, 1, 'turn completion removes the marker');
  assert.deepEqual(adapter.marksUnqueued[0].ref, { conduit: channel, messageId: 'M1' });

  unlockPrior();
  const tail = conduitQueues.get(channel);
  if (tail) await tail;
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

test('(g2) running thread buffers a downloaded platform file with its user input', async () => {
  const channel = freshChannel();
  const adapter = new MockAdapter() as any;
  let downloads = 0;
  adapter.downloadFile = async () => {
    downloads += 1;
    return { localPath: '/tmp/thread-report.txt', mimetype: 'text/plain', name: 'report.txt' };
  };
  const runningThread: any = {
    id: 'thr_test-buffer-file', status: 'running', channel,
    steps: [{ output: undefined }], metadata: {},
  };
  const file = { id: 'F1', name: 'report.txt', mimetype: 'text/plain', url: 'https://files.invalid/F1', conduit: channel };
  const ctx = makeCtx(channel, {
    adapter, existingThread: runningThread, isActiveThread: true, hasFiles: true,
    agentMessage: 'inspect this',
    message: { ref: { conduit: channel, messageId: 'M-file', threadId: 'T1' }, text: 'inspect this', isBot: false, files: [file] },
  });
  delete (ctx as any).threadAddMatch;
  delete (ctx as any).threadStartMatch;

  await new ThreadExecutor({ enqueue: () => false, track: () => {} }).route(ctx as any);

  assert.equal(downloads, 1);
  assert.equal(runningThread.metadata.pendingUserInputs.length, 1);
  assert.match(runningThread.metadata.pendingUserInputs[0].id, /^buf_/);
  assert.match(runningThread.metadata.pendingUserInputs[0].text, /\/tmp\/thread-report\.txt/);
  assert.doesNotMatch(runningThread.metadata.pendingUserInputs[0].text, /files\.invalid/);
});

test('(g3) file-only input remains actionable when buffered by a running thread', async () => {
  const channel = freshChannel();
  const adapter = new MockAdapter() as any;
  adapter.downloadFile = async () => ({
    localPath: '/tmp/thread-image.png', mimetype: 'image/png', name: 'image.png',
  });
  const runningThread: any = {
    id: 'thr_test-buffer-file-only', status: 'running', channel,
    steps: [{ output: undefined }], metadata: {},
  };
  const ctx = makeCtx(channel, {
    adapter, existingThread: runningThread, isActiveThread: true, hasFiles: true, agentMessage: '',
    message: {
      ref: { conduit: channel, messageId: 'M-image', threadId: 'T1' }, text: '', isBot: false,
      files: [{ id: 'I1', name: 'image.png', mimetype: 'image/png', url: 'https://files.invalid/I1', conduit: channel }],
    },
  });
  delete (ctx as any).threadAddMatch;
  delete (ctx as any).threadStartMatch;

  await new ThreadExecutor({ enqueue: () => false, track: () => {} }).route(ctx as any);

  assert.match(runningThread.metadata.pendingUserInputs[0].text, /thread-image\.png/);
  assert.match(runningThread.metadata.pendingUserInputs[0].text, /analyze the attached file/i);
});

test('(g4) next-step readiness waits for the platform download registered by buffering', async () => {
  const channel = freshChannel();
  const adapter = new MockAdapter() as any;
  let releaseDownload!: () => void;
  adapter.downloadFile = () => new Promise((resolve) => {
    releaseDownload = () => resolve({
      localPath: '/tmp/thread-delayed.txt', mimetype: 'text/plain', name: 'delayed.txt',
    });
  });
  const runningThread: any = {
    id: `thr_test-buffer-wait-${channel}`, status: 'running', channel,
    steps: [{ output: undefined }], metadata: {},
  };
  const ctx = makeCtx(channel, {
    adapter, existingThread: runningThread, isActiveThread: true, hasFiles: true, agentMessage: 'wait for it',
    message: {
      ref: { conduit: channel, messageId: 'M-delayed', threadId: 'T1' }, text: 'wait for it', isBot: false,
      files: [{ id: 'D1', name: 'delayed.txt', mimetype: 'text/plain', url: 'https://files.invalid/D1', conduit: channel }],
    },
  });
  delete (ctx as any).threadAddMatch;
  delete (ctx as any).threadStartMatch;

  const routing = new ThreadExecutor({ enqueue: () => false, track: () => {} }).route(ctx as any);
  await Promise.resolve();
  const inputId = runningThread.metadata.pendingUserInputs[0].id;
  let ready = false;
  const waiting = waitForPendingUserInputs(runningThread.id, [inputId]).then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);

  releaseDownload();
  await routing;
  await waiting;
  assert.match(runningThread.metadata.pendingUserInputs[0].text, /thread-delayed\.txt/);
});

test('(g5) cap eviction releases readiness and late download completion cannot resurrect input', async () => {
  const channel = freshChannel();
  const adapter = new MockAdapter() as any;
  let releaseSlow!: () => void;
  adapter.downloadFile = () => new Promise((resolve) => {
    releaseSlow = () => resolve({ localPath: '/tmp/slow.txt', mimetype: 'text/plain', name: 'slow.txt' });
  });
  const runningThread: any = {
    id: `thr_test-buffer-evict-${channel}`, status: 'running', channel,
    steps: [{ output: undefined }], metadata: {},
  };
  const slowCtx = makeCtx(channel, {
    adapter, existingThread: runningThread, isActiveThread: true, hasFiles: true, agentMessage: 'slow input',
    message: {
      ref: { conduit: channel, messageId: 'M-slow', threadId: 'T1' }, text: 'slow input', isBot: false,
      files: [{ id: 'S1', name: 'slow.txt', mimetype: 'text/plain', url: 'https://files.invalid/S1', conduit: channel }],
    },
  });
  delete (slowCtx as any).threadAddMatch;
  delete (slowCtx as any).threadStartMatch;
  const executor = new ThreadExecutor({ enqueue: () => false, track: () => {} });
  const slowRouting = executor.route(slowCtx as any);
  await Promise.resolve();
  const slowId = runningThread.metadata.pendingUserInputs[0].id;
  const slowReady = waitForPendingUserInputs(runningThread.id, [slowId]);

  for (let i = 0; i < 10; i++) {
    const next = makeCtx(channel, {
      adapter, existingThread: runningThread, isActiveThread: true,
      agentMessage: `later ${i}`,
      message: { ref: { conduit: channel, messageId: `M-${i}`, threadId: 'T1' }, text: `later ${i}`, isBot: false, files: [] },
    });
    delete (next as any).threadAddMatch;
    delete (next as any).threadStartMatch;
    await executor.route(next as any);
  }

  await slowReady;
  assert.equal(runningThread.metadata.pendingUserInputs.some((input: any) => input.id === slowId), false);
  releaseSlow();
  await slowRouting;
  assert.equal(runningThread.metadata.pendingUserInputs.length, 10);
  assert.equal(runningThread.metadata.pendingUserInputs.some((input: any) => input.id === slowId), false);
});

test('(g6) out-of-order downloads preserve buffered user-input order', async () => {
  const channel = freshChannel();
  const adapter = new MockAdapter() as any;
  const releases = new Map<string, () => void>();
  adapter.downloadFile = (file: any) => new Promise((resolve) => {
    releases.set(file.id, () => resolve({
      localPath: `/tmp/${file.id}.txt`, mimetype: 'text/plain', name: `${file.id}.txt`,
    }));
  });
  const runningThread: any = {
    id: `thr_test-buffer-order-${channel}`, status: 'running', channel,
    steps: [{ output: undefined }], metadata: {},
  };
  const makeFileCtx = (id: string, text: string) => {
    const ctx = makeCtx(channel, {
      adapter, existingThread: runningThread, isActiveThread: true, hasFiles: true, agentMessage: text,
      message: {
        ref: { conduit: channel, messageId: `M-${id}`, threadId: 'T1' }, text, isBot: false,
        files: [{ id, name: `${id}.txt`, mimetype: 'text/plain', url: `https://files.invalid/${id}`, conduit: channel }],
      },
    });
    delete (ctx as any).threadAddMatch;
    delete (ctx as any).threadStartMatch;
    return ctx;
  };
  const executor = new ThreadExecutor({ enqueue: () => false, track: () => {} });
  const first = executor.route(makeFileCtx('A', 'first') as any);
  const second = executor.route(makeFileCtx('B', 'second') as any);
  await Promise.resolve();

  releases.get('B')!();
  await second;
  releases.get('A')!();
  await first;

  assert.match(runningThread.metadata.pendingUserInputs[0].text, /\/tmp\/A\.txt/);
  assert.match(runningThread.metadata.pendingUserInputs[1].text, /\/tmp\/B\.txt/);
});
