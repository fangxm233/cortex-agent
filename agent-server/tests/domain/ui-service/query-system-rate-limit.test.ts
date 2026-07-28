// input:  provider throttle domain state and system rate-limit query handler
// output: provider/window DTO, waiting counts, and inactive assertions
// pos:    UI-service regression coverage for system.rateLimitStatus
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _testReset,
  handleRateLimitEvent,
  initRateLimitThrottle,
  type RateLimitThrottleState,
} from '../../../src/domain/costs/rate-limit-throttle.js';
import { handleSystemRateLimitStatus } from '../../../src/domain/ui-service/query/system.js';
import {
  _testReset as resetResumeRegistry,
  initResumeRegistry,
  recordResume,
} from '../../../src/domain/costs/resume-registry.js';

function adapterStub() {
  return { postMessage: async () => undefined, getAdminConduit: () => null } as any;
}

function persistenceStub() {
  let saved: RateLimitThrottleState | null = null;
  return {
    save: async (state: RateLimitThrottleState | null) => { saved = state; },
    load: async () => saved,
  };
}

afterEach(() => {
  _testReset();
  resetResumeRegistry();
});

test('system.rateLimitStatus returns active provider windows without collapsing reset times', async () => {
  await initRateLimitThrottle(adapterStub(), persistenceStub());
  const nowSec = Math.floor(Date.now() / 1000);
  await handleRateLimitEvent(
    { rateLimitType: 'seven_day', utilization: 0.97, resetsAt: nowSec + 900 },
    { provider: 'anthropic', displayName: 'Anthropic', mode: 'plan' },
  );
  await handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.94, resetsAt: nowSec + 300 },
    { provider: 'openai-codex', displayName: 'OpenAI', mode: 'codex' },
  );
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  recordResume({ kind: 'direct', provider: 'anthropic', channel: 'C1', userMessage: 'a', recordedAt: 1 });
  recordResume({ kind: 'thread', provider: 'anthropic', threadId: 'thr_a', channel: 'C2', userMessage: 'b', recordedAt: 2 });
  recordResume({ kind: 'thread', provider: 'openai-codex', threadId: 'thr_b', channel: 'C3', userMessage: 'c', recordedAt: 3 });

  const status = await handleSystemRateLimitStatus({});
  assert.deepEqual(status.providers.map((provider) => provider.provider), ['anthropic', 'openai-codex']);
  assert.deepEqual(status.providers.map((provider) => provider.windows[0].resetsAt), [nowSec + 900, nowSec + 300]);
  assert.equal(status.providers[0].windows[0].utilization, 0.97);
  assert.deepEqual(status.providers.map((provider) => [provider.waitingSessions, provider.waitingThreads]), [
    [1, 1], [0, 1],
  ]);
});

test('system.rateLimitStatus returns no placeholder when throttle is inactive', async () => {
  const status = await handleSystemRateLimitStatus({});
  assert.deepEqual(status, { providers: [] });
});
