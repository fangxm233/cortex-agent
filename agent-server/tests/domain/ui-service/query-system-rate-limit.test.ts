import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _testReset,
  activateOutageWindow,
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
    { rateLimitType: 'model_scoped', rateLimitLabel: 'Sonnet', utilization: 0.98, resetsAt: nowSec + 1_200 },
    { provider: 'anthropic', displayName: 'Anthropic', mode: 'plan' },
  );
  await handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.94, resetsAt: nowSec + 300 },
    { provider: 'openai-codex', displayName: 'OpenAI', mode: 'subscription' },
  );
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  recordResume({ kind: 'direct', provider: 'anthropic', channel: 'C1', userMessage: 'a', recordedAt: 1 });
  recordResume({ kind: 'direct', provider: 'openai-codex', channel: 'C3', userMessage: 'c', recordedAt: 3 });

  const status = await handleSystemRateLimitStatus({});
  assert.deepEqual(status.providers.map((provider) => provider.provider), ['anthropic', 'openai-codex']);
  assert.deepEqual(status.providers.map((provider) => provider.windows[0].resetsAt), [nowSec + 900, nowSec + 300]);
  assert.equal(status.providers[0].windows[0].utilization, 0.97);
  assert.equal(status.providers[0].windows[1].label, 'Sonnet');
  assert.deepEqual(status.providers.map((provider) => provider.waitingSessions), [1, 1]);
  assert.deepEqual(status.providers.map((provider) => [provider.route, provider.key]),
    [['plan', 'anthropic::plan'], ['subscription', 'openai-codex::subscription']]);
});

test('system.rateLimitStatus lists each account of a provider on its own row', async () => {
  await initRateLimitThrottle(adapterStub(), persistenceStub());
  const resetsAt = Math.floor(Date.now() / 1000) + 900;
  for (const mode of ['school', 'subscription']) {
    await handleRateLimitEvent(
      { rateLimitType: 'five_hour', utilization: 0.97, resetsAt },
      { provider: 'anthropic', displayName: 'Anthropic', mode },
    );
  }
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  recordResume({ kind: 'direct', provider: 'anthropic::school', channel: 'C1', userMessage: 'a', recordedAt: 1 });

  const status = await handleSystemRateLimitStatus({});
  assert.deepEqual(status.providers.map((provider) => [provider.key, provider.waitingSessions]),
    [['anthropic::school', 1], ['anthropic::subscription', 0]]);
});

test('an outage row counts the sessions waiting on every account of its provider', async () => {
  await initRateLimitThrottle(adapterStub(), persistenceStub());
  await activateOutageWindow('anthropic', 600_000);
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  recordResume({ kind: 'direct', provider: 'anthropic::school', channel: 'C1', userMessage: 'a', recordedAt: 1 });
  recordResume({ kind: 'direct', provider: 'anthropic::subscription', channel: 'C2', userMessage: 'b', recordedAt: 2 });
  recordResume({ kind: 'direct', provider: 'openai-codex', channel: 'C3', userMessage: 'c', recordedAt: 3 });

  const status = await handleSystemRateLimitStatus({});
  assert.deepEqual(status.providers.map((provider) => [provider.key, provider.waitingSessions]), [['anthropic', 2]]);
});

test('system.rateLimitStatus returns no placeholder when throttle is inactive', async () => {
  const status = await handleSystemRateLimitStatus({});
  assert.deepEqual(status, { providers: [] });
});
