// input:  facade.ts, rate-limit-throttle, MockAdapter
// output: provider identity, exact pre-flight, notice regressions
// pos:    Facade pre-flight policy tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Rate-limit-throttle is a mutable singleton (module-level state). Tests use regular
// await import() (not importFresh) so facade imports the same module instance and
// sees the injected state. _testReset() before/after each test prevents leakage.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/platform/testing.js';

// --- Helpers ---

async function getRl() {
  return await import('../src/domain/costs/rate-limit-throttle.js');
}

/** Init throttle with one or more rate-limited modes, returning the rl module.
 *  handleRateLimitEvent only adds a mode on the extension path (resetsAt > current),
 *  so each mode gets a slightly later resetsAt. */
async function initThrottle(modes: string[]) {
  const rl = await getRl();
  rl._testReset();
  const adapter = new MockAdapter({ adminChannel: 'test-admin' });
  const persistence = {
    save: async () => {},
    load: async () => null as any,
  };
  await rl.initRateLimitThrottle(adapter, persistence);
  const baseReset = Math.floor(Date.now() / 1000) + 300; // 5 min in future
  for (let i = 0; i < modes.length; i++) {
    await rl.handleRateLimitEvent(
      { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: baseReset + i * 60 },
      { provider: 'anthropic', displayName: 'Anthropic', mode: modes[i] },
    );
  }
  return rl;
}

/// --- allConfigsRateLimited ---

test('allConfigsRateLimited returns false when not throttled', async (t) => {
  const rl = await getRl();
  rl._testReset();
  t.onTestFinished(() => rl._testReset());

  const facade = await import('../src/domain/agents/facade.js');
  assert.equal(facade.allConfigsRateLimited('plan'), false);
  assert.equal(facade.allConfigsRateLimited('scan'), false);
  assert.equal(facade.allConfigsRateLimited(null), false);
});

test('allConfigsRateLimited returns true when all modes in profile are rate-limited', async (t) => {
  // plan profile: mode=plan, fallback=[{mode:api}, {mode:plan}]
  // Need plan and api both rate-limited
  const rl = await initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  const facade = await import('../src/domain/agents/facade.js');
  assert.equal(facade.allConfigsRateLimited('plan'), true);
});

test('allConfigsRateLimited returns false when only some modes rate-limited', async (t) => {
  // plan profile: mode=plan, fallback=[api, plan]
  // Only rate-limit plan — api still available
  const rl = await initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());

  const facade = await import('../src/domain/agents/facade.js');
  assert.equal(facade.allConfigsRateLimited('plan'), false);
});

test('allConfigsRateLimited returns false on unknown profile', async (t) => {
  await initThrottle(['plan']);
  const rl = await getRl();
  t.onTestFinished(() => rl._testReset());

  const facade = await import('../src/domain/agents/facade.js');
  // Unknown profile — catch in resolveProfileConfig -> return false (conservative)
  assert.equal(facade.allConfigsRateLimited('nonexistent-profile'), false);
});

/// --- runAgent pre-flight skip ---

test('runAgent single-config path skips runAgentOnce when mode rate-limited', async (t) => {
  // scan profile has no fallback (single config, mode=plan)
  const rl = await initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());

  const facade = await import('../src/domain/agents/facade.js');
  const notices: Array<{ text: string; level?: string }> = [];
  const handle = facade.runAgent('test', {
    profileName: 'scan',
    channel: 'web:rate-limit',
    onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
  });
  const result = await handle.promise;

  assert.equal(result.rateLimited, true);
  assert.ok(result.rateLimitMessage?.includes('plan'));
  assert.equal(result.rateLimitProvider, 'anthropic');
  // No adapter was spawned — synthetic return
  assert.equal(result.sessionId, null);
  assert.deepEqual(notices, [{ text: 'Rate limited', level: 'error' }]);
});

test('runAgent fallback loop skips rate-limited configs and returns synthetic result when all exhausted', async (t) => {
  // plan profile: mode=plan, fallback=[mode=api, mode=plan]
  // Rate-limit both plan and api — all 3 configs skipped
  const rl = await initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  const facade = await import('../src/domain/agents/facade.js');
  const handle = facade.runAgent('test', { profileName: 'plan' });
  const result = await handle.promise;

  assert.equal(result.rateLimited, true);
  // Last attempted mode was 'plan' (third config)
  assert.ok(result.rateLimitMessage?.includes('plan'));
  assert.equal(result.rateLimitProvider, 'anthropic');
  assert.equal(result.sessionId, null);
});

test('provider identity accepts arbitrary configured providers and generic backend fallback', async () => {
  const facade = await import('../src/domain/agents/facade.js');
  assert.equal(facade._test.resolveRateLimitProvider({ backend: 'pi', provider: 'provider-z' } as any), 'provider-z');
  assert.equal(facade._test.resolveRateLimitProvider({ backend: 'custom-backend', provider: null } as any), 'custom-backend');
});

test('provider wrapper attributes results and retryable thrown errors', async () => {
  const facade = await import('../src/domain/agents/facade.js');
  const baseResult = {
    sessionId: 's', total_cost_usd: 0, num_turns: 1,
    rateLimited: false, rateLimitMessage: null, planFilePath: null,
    enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
  };
  const wrappedResult = facade._test.withRateLimitProvider({
    promise: Promise.resolve(baseResult), kill: () => false, sessionId: 's',
  } as any, 'provider-z');
  assert.equal((await wrappedResult.promise).rateLimitProvider, 'provider-z');

  const error = new Error('rate limit exceeded');
  const wrappedError = facade._test.withRateLimitProvider({
    promise: Promise.reject(error), kill: () => false, sessionId: null,
  } as any, 'provider-z');
  await assert.rejects(wrappedError.promise, (caught: any) => caught.rateLimitProvider === 'provider-z');
});

test('runAgent fallback loop calls onFallback for each skipped config', async (t) => {
  const rl = await initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  const facade = await import('../src/domain/agents/facade.js');
  const fallbackCalls: Array<{ current: any; next: any; result: any }> = [];

  const handle = facade.runAgent('test', {
    profileName: 'plan',
    onFallback: async (current, next, result) => {
      fallbackCalls.push({ current, next, result });
    },
  });
  await handle.promise;

  // 3 configs → 2 fallback transitions (skip from 0→1, skip from 1→2)
  assert.equal(fallbackCalls.length, 2);
  assert.equal(fallbackCalls[0].result, null); // no real result — synthetic skip
  assert.equal(fallbackCalls[1].result, null);
});
