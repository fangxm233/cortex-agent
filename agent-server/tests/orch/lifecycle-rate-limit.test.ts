// input:  Node test runner + lifecycle.handleAgentError (shares throttle/resume singletons)
// output: provider-attributed error pause and unrelated-provider guards
// pos:    Validate orchestration/lifecycle.ts direct/TUI thrown-rate-limit recovery (parity with thread path)
// >>> If I am updated, update my require first <<<
import '../_test-home.js'; // MUST be first — isolates store singletons
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleAgentError } from '../../src/orchestration/lifecycle.js';
import { initRateLimitThrottle, handleRateLimitEvent, _testReset as throttleReset } from '../../src/domain/costs/rate-limit-throttle.js';
import { initResumeRegistry, getResumeCount, takeAllResumes, _testReset as resumeReset } from '../../src/domain/costs/resume-registry.js';
import { MockAdapter } from '../../src/platform/testing.js';

const stub = { save: async () => {}, load: async () => null };
const RL_MSG = "API Error: Server is temporarily limiting requests · This request would exceed your account's rate limit";

async function activateThrottle(adapter: MockAdapter) {
  await initRateLimitThrottle(adapter as any, stub as any);
  // five_hour + utilization >= 0.90 + resetsAt → throttle active (isThrottled() true)
  await handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 },
    { provider: 'provider-a', displayName: 'Provider A', mode: 'plan' },
  );
  // Activation fires an admin DM through this same adapter — clear it so assertions below only
  // observe handleAgentError's own posts/updates.
  adapter.posted.length = 0;
  adapter.updated.length = 0;
}

function baseArgs(adapter: MockAdapter, overrides: Record<string, unknown> = {}) {
  return {
    error: { message: RL_MSG, rateLimitProvider: 'provider-a' },
    channel: 'C1', adapter: adapter as any,
    statusMsg: { conduit: 'C1', messageId: 's1' } as any,
    startTime: Date.now(),
    executionId: null, sessionName: null, sessionId: null, userMessageTs: null,
    userMessage: 'hello',
    ...overrides,
  };
}

test('throttled + rate-limit error + userMessage → pause & record direct resume (no error post)', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await activateThrottle(adapter);

  await handleAgentError(baseArgs(adapter) as any);

  assert.equal(getResumeCount(), 1, 'a direct resume entry was recorded');
  const entries = takeAllResumes();
  assert.equal(entries[0].kind, 'direct');
  assert.equal((entries[0] as any).channel, 'C1');
  assert.equal((entries[0] as any).provider, 'provider-a');
  assert.equal(adapter.posted.length, 0, 'no error body posted — paused, not failed');
  assert.ok(adapter.updated.length >= 1, 'status sealed via updateMessage');
});

test('a different active provider does not pause this provider error', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await activateThrottle(adapter);

  await handleAgentError(baseArgs(adapter, {
    error: { message: RL_MSG, rateLimitProvider: 'provider-b' },
  }) as any);

  assert.equal(getResumeCount(), 0);
  assert.equal(adapter.posted.length, 1, 'unrelated provider throttle cannot promise an auto-resume');
});

test('NOT throttled + rate-limit error → normal error path, no resume', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  // throttle intentionally NOT activated → isThrottled() false

  await handleAgentError(baseArgs(adapter) as any);

  assert.equal(getResumeCount(), 0, 'no resume when throttle inactive');
  assert.equal(adapter.posted.length, 1, 'error body posted (normal failure)');
});

test('throttled + rate-limit error but no userMessage → normal error path, no resume', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await activateThrottle(adapter);

  await handleAgentError(baseArgs(adapter, { userMessage: null }) as any);

  assert.equal(getResumeCount(), 0, 'no resume without a userMessage (manager-qa/edit callers)');
  assert.equal(adapter.posted.length, 1, 'error body posted');
});

test('throttled + non-rate-limit error → normal error path, no resume', async (t) => {
  t.onTestFinished(() => { throttleReset(); resumeReset(); });
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await activateThrottle(adapter);

  await handleAgentError(baseArgs(adapter, { error: { message: 'TypeError: undefined is not a function' } }) as any);

  assert.equal(getResumeCount(), 0, 'no resume for a non-rate-limit error');
  assert.equal(adapter.posted.length, 1, 'error body posted');
});
