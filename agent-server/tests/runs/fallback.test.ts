import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { loadThrottleHome } from './throttle-fixture.js';

const home = await loadThrottleHome('runs-fallback-test');
const { allConfigsRateLimited, planAttempts, attemptLabel } = await import('../../src/domain/runs/fallback.js');
const { resolveProfileConfig } = await import('../../src/domain/agents/profile-manager.js');

afterAll(() => home.dispose());

// --- planAttempts ---

test('planAttempts puts the profile itself first, then its declared fallbacks', () => {
  const attempts = planAttempts(resolveProfileConfig('plan'));

  assert.equal(attempts.length, 3, 'the profile is its own first attempt');
  assert.deepEqual(attempts.map(attemptLabel), [
    'claude-sonnet-4-6/plan',
    'claude-sonnet-4-6/api',
    'claude-sonnet-4-6/plan',
  ]);
  // The head must not carry chain metadata: an attempt describes one engine selection only.
  assert.equal('fallback' in attempts[0], false);
  assert.equal('name' in attempts[0], false);
});

test('planAttempts on a profile with no fallback is a one-element chain', () => {
  assert.deepEqual(planAttempts(resolveProfileConfig('scan')).map(attemptLabel), [
    'claude-sonnet-4-6/plan',
  ]);
});

// --- allConfigsRateLimited ---

test('allConfigsRateLimited returns false when not throttled', (t) => {
  home.rl._testReset();
  t.onTestFinished(() => home.rl._testReset());

  assert.equal(allConfigsRateLimited('plan'), false);
  assert.equal(allConfigsRateLimited('scan'), false);
  assert.equal(allConfigsRateLimited(null), false);
});

test('allConfigsRateLimited returns true when every attempt in the chain is blocked', async (t) => {
  // plan profile: mode=plan, fallback=[{mode:api}, {mode:plan}] — plan and api cover all three.
  const rl = await home.initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  assert.equal(allConfigsRateLimited('plan'), true);
});

test('allConfigsRateLimited returns false while one attempt is still open', async (t) => {
  const rl = await home.initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());

  assert.equal(allConfigsRateLimited('plan'), false, 'the api fallback is still available');
});

test('allConfigsRateLimited returns false on an unknown profile', async (t) => {
  const rl = await home.initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  // An unresolvable profile is not evidence that everything is blocked — fail open.
  assert.equal(allConfigsRateLimited('does-not-exist'), false);
});
