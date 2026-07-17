// input:  node:test, TokenBucketRateLimiter
// output: token bucket rate limiter behavior
// pos:    RateLimiter unit test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TokenBucketRateLimiter } from '../src/platform/utils/rate-limiter.js';

/**
 * Create a rate limiter with tight limits for fast testing.
 * Capacity=2, refill=1/sec → quick to exhaust and quick to refill.
 */
function makeFastLimiter(): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({
    globalCapacity: 2,
    globalRefillPerSec: 1,
    perChannelCapacity: 2,
    perChannelRefillPerSec: 1,
    cleanupIntervalMs: 100_000, // long enough to not interfere
  });
}

test('TokenBucketRateLimiter: initial acquire succeeds (tokens pre-filled)', () => {
  const rl = makeFastLimiter();
  const r = rl.tryAcquire('chat.postMessage');
  assert.equal(r.ok, true);
});

test('TokenBucketRateLimiter: exhausts then denies', () => {
  const rl = makeFastLimiter();
  assert.equal(rl.tryAcquire('chat.postMessage').ok, true);  // 1
  assert.equal(rl.tryAcquire('chat.postMessage').ok, true);  // 2 (exhausted)
  const r = rl.tryAcquire('chat.postMessage');
  assert.equal(r.ok, false);
  assert.ok((r as any).retryAfterMs > 0);
});

test('TokenBucketRateLimiter: refills over time', { timeout: 5000 }, async () => {
  const rl = makeFastLimiter();
  rl.tryAcquire('chat.postMessage');  // 1/2
  rl.tryAcquire('chat.postMessage');  // 2/2 (exhausted)
  assert.equal(rl.tryAcquire('chat.postMessage').ok, false);

  // Wait for refill (~1s for 1 token)
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(rl.tryAcquire('chat.postMessage').ok, true); // refilled 1
});

test('TokenBucketRateLimiter: per-channel isolation', () => {
  const rl = makeFastLimiter();
  assert.equal(rl.tryAcquire('chat.postMessage', 'C1').ok, true);  // global + C1
  assert.equal(rl.tryAcquire('chat.postMessage', 'C1').ok, true);  // global + C1 (both exhausted)
  assert.equal(rl.tryAcquire('chat.postMessage', 'C1').ok, false); // blocked
  // C2 has its own channel bucket but shares global:
  assert.equal(rl.tryAcquire('chat.postMessage', 'C2').ok, false); // global exhausted
});

test('TokenBucketRateLimiter: different methods have separate global buckets', () => {
  const rl = makeFastLimiter();
  assert.equal(rl.tryAcquire('chat.postMessage').ok, true);  // global postMessage 1/2
  assert.equal(rl.tryAcquire('chat.postMessage').ok, true);  // global postMessage 2/2
  assert.equal(rl.tryAcquire('chat.update').ok, true);       // global update 1/2 (separate)
});

test('TokenBucketRateLimiter: reportThrottled sets backoff window', { timeout: 5000 }, async () => {
  const rl = makeFastLimiter();
  rl.reportThrottled('chat.postMessage', undefined, 1); // 1s backoff
  assert.equal(rl.tryAcquire('chat.postMessage').ok, false);

  // Wait for backoff to expire (1s + 1s buffer = 2s from reportThrottled)
  await new Promise(r => setTimeout(r, 2100));
  assert.equal(rl.tryAcquire('chat.postMessage').ok, true);
});

test('TokenBucketRateLimiter: reportThrottled without retryAfter defaults to 10s', () => {
  const rl = makeFastLimiter();
  rl.reportThrottled('chat.postMessage'); // default 10s
  // Would block for 10s — just verify the state
  assert.equal(rl.tryAcquire('chat.postMessage').ok, false);
});

test('TokenBucketRateLimiter: zero capacity denies all', () => {
  const rl = new TokenBucketRateLimiter({
    globalCapacity: 0,
    globalRefillPerSec: 0,
    perChannelCapacity: 0,
    perChannelRefillPerSec: 0,
    cleanupIntervalMs: 100_000,
  });
  assert.equal(rl.tryAcquire('chat.postMessage').ok, false);
  assert.equal(rl.tryAcquire('chat.update', 'C1').ok, false);
});

test('TokenBucketRateLimiter: blocking acquire() eventually resolves', { timeout: 5000 }, async () => {
  const rl = makeFastLimiter();
  rl.tryAcquire('chat.postMessage'); // 1/2
  rl.tryAcquire('chat.postMessage'); // 2/2

  // Should wait ~1s for refill
  const t0 = Date.now();
  await rl.acquire('chat.postMessage');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 800, `expected >=800ms wait, got ${elapsed}ms`);
});

test('TokenBucketRateLimiter: cleanup removes stale buckets', () => {
  const rl = makeFastLimiter();
  rl.tryAcquire('chat.postMessage', 'stale-channel');
  assert.equal(rl._bucketCount(), 2); // global + channel

  // Advance time past the cleanup threshold (5 min)
  rl._advanceTime(6 * 60 * 1000 + 1);
  // Trigger cleanup manually
  (rl as any)._cleanup();
  assert.equal(rl._bucketCount(), 0);
});

test('TokenBucketRateLimiter: acquire respects 429 backoff across channels', () => {
  const rl = makeFastLimiter();
  rl.reportThrottled('chat.postMessage', 'C1', 3);
  // Both C1 specific and global postMessage should be backed off
  assert.equal(rl.tryAcquire('chat.postMessage', 'C1').ok, false);
  assert.equal(rl.tryAcquire('chat.postMessage').ok, false);
});

test('TokenBucketRateLimiter: dispose stops cleanup timer', () => {
  const rl = makeFastLimiter();
  rl.dispose();
  assert.equal(rl._bucketCount(), 0);
  // Should not throw
  rl.tryAcquire('chat.postMessage');
});
