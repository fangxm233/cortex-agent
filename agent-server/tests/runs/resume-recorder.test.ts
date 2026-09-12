// input:  Node test runner + the live throttle and resume-registry singletons
// output: the direct-path throttle gate, the thread path's unconditional record, and entry shape
// pos:    Pin domain/runs/observers/resume-recorder.ts — the resume queue's only writers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import '../_test-home.js'; // MUST be first — isolates store singletons
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { recordDirectResume, recordThreadResume } from '../../src/domain/runs/observers/resume-recorder.js';
import {
  initRateLimitThrottle, handleRateLimitEvent, _testReset as throttleReset,
} from '../../src/domain/costs/rate-limit-throttle.js';
import {
  initResumeRegistry, getResumeCount, takeAllResumes, _testReset as resumeReset,
} from '../../src/domain/costs/resume-registry.js';
import { MockAdapter } from '../../src/platform/testing.js';

const stub = { save: async () => {}, load: async () => null };

async function arm(provider: string): Promise<MockAdapter> {
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await initRateLimitThrottle(adapter as any, stub as any);
  await handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 },
    { provider, displayName: provider, mode: 'plan' },
  );
  return adapter;
}

const direct = { channel: 'C1', trackSessionId: 'cortex-abcd', userMessage: 'hello' };

test('recordDirectResume: a throttled provider is queued and reports that it queued', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  await arm('provider-a');

  assert.equal(recordDirectResume({ provider: 'provider-a', ...direct }), true);
  assert.equal(getResumeCount(), 1);

  const [entry] = takeAllResumes() as any[];
  assert.equal(entry.kind, 'direct');
  assert.equal(entry.provider, 'provider-a');
  assert.equal(entry.channel, 'C1');
  assert.equal(entry.trackSessionId, 'cortex-abcd');
  assert.equal(entry.userMessage, 'hello');
  assert.equal(typeof entry.recordedAt, 'number');
});

test('recordDirectResume: an un-throttled provider is NOT queued — that 429 is terminal', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  await arm('provider-a');

  // The gate is the whole point: queueing provider-b would create an entry whose reset callback
  // never fires, so the turn would wait forever while the user was promised an auto-resume.
  assert.equal(recordDirectResume({ provider: 'provider-b', ...direct }), false);
  assert.equal(getResumeCount(), 0);
});

test('recordDirectResume: a null/absent provider queues only while SOME provider is throttled', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  await arm('provider-a');

  assert.equal(recordDirectResume({ provider: null, ...direct }), true, 'legacy entry waits for every provider');
  assert.equal(recordDirectResume({ provider: undefined, ...direct }), true, 'undefined normalizes to null');
  const [entry] = takeAllResumes() as any[];
  assert.equal(entry.provider, null, 'undefined is stored as null, never as a missing key');
});

test('recordDirectResume: nothing throttled → no queue at all', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await initRateLimitThrottle(adapter as any, stub as any);

  assert.equal(recordDirectResume({ provider: 'provider-a', ...direct }), false);
  assert.equal(recordDirectResume({ provider: null, ...direct }), false);
  assert.equal(getResumeCount(), 0);
});

test('recordThreadResume: unconditional — a paused thread is never left unqueued', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await initRateLimitThrottle(adapter as any, stub as any);

  // No throttle armed at all: the thread caller has already moved the thread to `rate_limited`,
  // so skipping the queue here would strand it with nothing able to restart it.
  recordThreadResume({ provider: 'provider-a', threadId: 'thr_a1b2c3d4', channel: 'C1', userMessage: 'go' });
  assert.equal(getResumeCount(), 1);

  const [entry] = takeAllResumes() as any[];
  assert.equal(entry.kind, 'thread');
  assert.equal(entry.threadId, 'thr_a1b2c3d4');
  assert.equal(entry.provider, 'provider-a');
  assert.equal(entry.channel, 'C1');
  assert.equal(entry.userMessage, 'go');
});
