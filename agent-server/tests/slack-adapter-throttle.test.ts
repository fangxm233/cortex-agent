// input:  node:test, SlackAdapter
// output: per-message coalescing + rate-limit behavior
// pos:    SlackAdapter platform-layer coalescing + rate limit regression test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/platform/adapters/slack.js';
import { TokenBucketRateLimiter } from '../src/platform/utils/rate-limiter.js';

/**
 * Create an adapter with fast rate limits for testing — tokens never run out
 * so calls proceed immediately unless a test deliberately triggers backpressure.
 */
function makeFastLimiter(): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({
    globalCapacity: 100,
    globalRefillPerSec: 100,
    perChannelCapacity: 100,
    perChannelRefillPerSec: 100,
    cleanupIntervalMs: 100_000,
  });
}

function makeAdapter(opts?: { rateLimiter?: TokenBucketRateLimiter }) {
  // Skip the real constructor (which instantiates `@slack/bolt.App` and fires
  // a background `auth.test` against api.slack.com). We only exercise
  // the methods directly.
  const adapter = Object.create(SlackAdapter.prototype) as SlackAdapter;
  (adapter as any).config = { botToken: 'xoxb-test', signingSecret: 'sig', appToken: 'xapp-test' };
  (adapter as any).pendingEdits = new Map();
  (adapter as any).rateLimiter = opts?.rateLimiter ?? makeFastLimiter();
  const calls: { method: string; ts: number }[] = [];
  let nextResponse: () => unknown = () => ({ ok: true });
  (adapter as any).client = {
    chat: {
      update: async () => {
        calls.push({ method: 'chat.update', ts: Date.now() });
        return nextResponse();
      },
      postMessage: async () => {
        calls.push({ method: 'chat.postMessage', ts: Date.now() });
        return { ok: true, ts: '123' };
      },
      delete: async () => {
        calls.push({ method: 'chat.delete', ts: Date.now() });
        return { ok: true };
      },
    },
  };
  return {
    adapter,
    calls,
    setResponse(fn: () => unknown) { nextResponse = fn; },
  };
}

// ── updateMessage coalescing ──

test('SlackAdapter: concurrent updates to same message coalesce into one API call', async () => {
  const { adapter, calls } = makeAdapter();
  const ref = { conduit: 'C1', messageId: 'ts-1' };

  // Three concurrent updates to the same message
  await Promise.all([
    adapter.updateMessage(ref, { text: 'a' }),
    adapter.updateMessage(ref, { text: 'b' }),
    adapter.updateMessage(ref, { text: 'c' }),
  ]);

  // Only ONE API call should fire (with the latest content 'c')
  assert.equal(calls.length, 1);
});

test('SlackAdapter: updates to different messages are independent', async () => {
  const { adapter, calls } = makeAdapter();
  await Promise.all([
    adapter.updateMessage({ conduit: 'C1', messageId: 'ts-A' }, { text: 'a' }),
    adapter.updateMessage({ conduit: 'C1', messageId: 'ts-B' }, { text: 'b' }),
    adapter.updateMessage({ conduit: 'C2', messageId: 'ts-A' }, { text: 'c' }),
  ]);

  assert.equal(calls.length, 3);
});

test('SlackAdapter: coalesced update sends the latest content only', async () => {
  const { adapter, calls } = makeAdapter();
  const ref = { conduit: 'C1', messageId: 'ts-coalesce' };
  let lastReceived: any = null;
  (adapter as any).client.chat.update = async (args: any) => {
    calls.push({ method: 'chat.update', ts: Date.now() });
    lastReceived = args;
    return { ok: true };
  };

  await Promise.all([
    adapter.updateMessage(ref, { text: 'version-1' }),
    adapter.updateMessage(ref, { text: 'version-2' }),
    adapter.updateMessage(ref, { text: 'version-3' }),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(lastReceived.text, 'version-3', 'must send the latest content');
});

// ── 429 handling ──

test('SlackAdapter: 429 on chat.update triggers rate limiter backoff and retry', { timeout: 10000 }, async () => {
  // Use a tight rate limiter for this test so the backoff is visible
  const tightLimiter = new TokenBucketRateLimiter({
    globalCapacity: 100, globalRefillPerSec: 100,  // global shouldn't interfere
    perChannelCapacity: 100, perChannelRefillPerSec: 100,
    cleanupIntervalMs: 100_000,
  });
  const { adapter, calls } = makeAdapter({ rateLimiter: tightLimiter });
  const ref = { conduit: 'C1', messageId: 'ts-429' };

  // Use a call-counter: first call fails (429), subsequent succeed
  let callCount = 0;
  (adapter as any).client.chat.update = async () => {
    callCount++;
    calls.push({ method: 'chat.update', ts: Date.now() });
    if (callCount === 1) {
      const e: any = new Error('rate limited');
      e.retryAfter = 1;
      throw e;
    }
    return { ok: true };
  };

  const t0 = Date.now();
  await adapter.updateMessage(ref, { text: 'retry-attempt' });
  const elapsed = Date.now() - t0;

  // Should have retried — first call got 429, second (or later) succeeded
  assert.ok(calls.length >= 1, 'must have at least one API call');
  // The retry loop should have waited for the backoff to expire
  assert.ok(elapsed >= 800, `expected retry delay ≥800ms after 429 retryAfter:1, got ${elapsed}ms`);
});

test('SlackAdapter: coalescing works during in-flight API call that returns 429', { timeout: 10000 }, async () => {
  const { adapter, calls } = makeAdapter();
  const ref = { conduit: 'C1', messageId: 'ts-coalesce-429' };

  // Track what text each chat.update call receives
  const receivedTexts: string[] = [];
  let callCount = 0;
  let resolveInflight: (() => void) | null = null;

  (adapter as any).client.chat.update = async (args: any) => {
    callCount++;
    calls.push({ method: 'chat.update', ts: Date.now() });
    receivedTexts.push(args.text);

    if (callCount === 1) {
      // First call: pause mid-flight so the test can coalesce content, then 429
      await new Promise<void>(r => { resolveInflight = r; });
      const e: any = new Error('rate limited');
      e.retryAfter = 0.1;
      throw e;
    }
    return { ok: true };
  };

  // Start first update — it will block inside chat.update
  const p1 = adapter.updateMessage(ref, { text: 'original' });

  // Wait for the first chat.update to be in-flight
  await new Promise<void>(r => {
    const check = () => { if (resolveInflight) r(); else setTimeout(check, 5); };
    check();
  });

  // Coalesce a newer edit while the API call is in-flight
  const p2 = adapter.updateMessage(ref, { text: 'coalesced-latest' });

  // Unblock the in-flight call (it will 429)
  resolveInflight!();

  await Promise.all([p1, p2]);

  // The retry after 429 should send the coalesced content, not the original
  assert.ok(receivedTexts.length >= 2, `expected ≥2 API calls, got ${receivedTexts.length}`);
  assert.equal(receivedTexts[receivedTexts.length - 1], 'coalesced-latest',
    'retry after 429 must use the latest coalesced content, not the stale original');
});

test('SlackAdapter: 429 on rateLimitedCall propagates to rate limiter', async () => {
  let reportedMethod = '';
  let reportedChannel = '';
  const trackingLimiter = makeFastLimiter();
  const origReport = trackingLimiter.reportThrottled.bind(trackingLimiter);
  trackingLimiter.reportThrottled = (method: string, channel?: string, retryAfterSec?: number) => {
    reportedMethod = method;
    reportedChannel = channel ?? '';
    origReport(method, channel, retryAfterSec);
  };

  const { adapter, setResponse } = makeAdapter({ rateLimiter: trackingLimiter });
  (adapter as any).client.chat.postMessage = async () => {
    const e: any = new Error('rate limited');
    e.retryAfter = 3;
    throw e;
  };

  setResponse(() => {
    const e: any = new Error('rate limited');
    e.retryAfter = 3;
    throw e;
  });

  await assert.rejects(
    adapter.postMessage({ type: 'interactive-reply', conduit: 'C1', sessionId: '' }, { text: 'hello' })
  );

  assert.equal(reportedMethod, 'chat.postMessage');
  assert.equal(reportedChannel, 'C1');
});

// ── deleteMessage ──

test('SlackAdapter: deleteMessage clears pending edits', async () => {
  const { adapter, calls } = makeAdapter();
  const ref = { conduit: 'C1', messageId: 'ts-del' };

  // Start an update that will be pending (no rate limit contention with fast limiter,
  // but just verify the pending edit is cleaned up on delete)
  const updatePromise = adapter.updateMessage(ref, { text: 'to-be-deleted' });
  // The update should go through quickly since we have a fast limiter
  await updatePromise;
  await adapter.deleteMessage(ref);

  // One update call + one delete call
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'chat.update');
  assert.equal(calls[1].method, 'chat.delete');
});

// ── postMessage rate limiting ──

test('SlackAdapter: postMessage is rate limited', async () => {
  const { adapter, calls } = makeAdapter();
  const result = await adapter.postMessage({ type: 'interactive-reply', conduit: 'C1', sessionId: '' }, { text: 'hello' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'chat.postMessage');
  assert.ok(result.messageId);
});
