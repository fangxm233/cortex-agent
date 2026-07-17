// input:  orch/channel-queue.ts
// output: regression tests — serialization guarantee + queue cleanup [S6-B]
// pos:    verifies per-channel serial ordering and absence of Map memory leaks

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { conduitQueues, enqueue } from '../../src/orchestration/conduit-queue.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Flush microtask queue (one setImmediate tick). */
function tick() { return new Promise<void>(res => setImmediate(res)); }

// Each test uses a unique channel to avoid cross-test state bleed.
let _seq = 0;
function freshChannel() { return `test-ch-${++_seq}`; }

// ── (a) serialization ─────────────────────────────────────────────────────────

test('serialization — second fn starts only after first resolves', async () => {
  const channel = freshChannel();
  const log: string[] = [];

  const d1 = makeDeferred();
  // First task: blocks until d1 is resolved
  enqueue(channel, async () => {
    log.push('start-1');
    await d1.promise;
    log.push('end-1');
  });

  // Second task
  const hadQueue = enqueue(channel, async () => {
    log.push('start-2');
  });

  assert.equal(hadQueue, true, 'enqueue returns true when a queue was already running');

  // Give microtasks a chance to run so first fn starts
  await tick();

  // First fn has started but not finished (blocked on d1)
  assert.deepEqual(log, ['start-1'], 'second fn must not start before first resolves');

  // Unblock first task and drain
  d1.resolve();
  const tail = conduitQueues.get(channel);
  if (tail) await tail;

  assert.deepEqual(log, ['start-1', 'end-1', 'start-2'], 'second fn runs after first completes');
});

// ── (b) return value on first call ───────────────────────────────────────────

test('enqueue returns false on first call for a channel (no prior queue)', async () => {
  const channel = freshChannel();
  const result = enqueue(channel, async () => {});
  assert.equal(result, false, 'first enqueue returns false (no prior queue)');
  const tail = conduitQueues.get(channel);
  if (tail) await tail;
});

// ── (c) queue cleanup — Map entry removed after fn resolves ───────────────────

test('queue cleanup — Map entry is deleted after fn resolves (no memory leak)', async () => {
  const channel = freshChannel();

  enqueue(channel, async () => {
    // While fn is running, the Map entry must be present
    assert.ok(conduitQueues.has(channel), 'Map entry exists while fn is running');
  });

  // Wait for the tail promise to settle
  const tail = conduitQueues.get(channel);
  if (tail) await tail;

  // Allow the .finally() callback to fire
  await tick();

  assert.equal(conduitQueues.has(channel), false, 'Map entry removed after fn resolves');
});

// ── (d) serialization with multiple channels — no cross-channel interference ──

test('two channels run independently (no cross-channel serialization)', async () => {
  const ch1 = freshChannel();
  const ch2 = freshChannel();
  const log: string[] = [];

  const d1 = makeDeferred();
  // ch1 is blocked
  enqueue(ch1, async () => {
    log.push('ch1-start');
    await d1.promise;
    log.push('ch1-end');
  });

  // ch2 should run freely even while ch1 is blocked
  const ch2Done = new Promise<void>(res => {
    enqueue(ch2, async () => {
      log.push('ch2-run');
      res();
    });
  });

  await ch2Done;
  // ch1 is still blocked
  assert.ok(log.includes('ch2-run'), 'ch2 ran while ch1 was blocked');
  assert.equal(log.includes('ch1-end'), false, 'ch1 has not finished yet');

  // Unblock ch1
  d1.resolve();
  const tail = conduitQueues.get(ch1);
  if (tail) await tail;

  assert.ok(log.includes('ch1-end'), 'ch1 completes after unblock');
});
