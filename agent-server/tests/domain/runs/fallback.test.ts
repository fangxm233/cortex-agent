import { afterAll, afterEach, expect, test } from 'vitest';
import { loadThrottleHome } from './throttle-fixture.js';
const home = await loadThrottleHome('runs-provider-test');
const { configIsRateLimited, shouldSkipAttempt, attemptProvider, attemptAuthType } = await import('../../../src/domain/runs/fallback.js');
const selection = { backend: 'claude' as const, provider: null, model: 'sonnet', thinking: null, mode: 'plan' };
afterAll(() => home.dispose());
afterEach(() => home.rl._testReset());
test('unthrottled selection runs normally', () => {
  expect(configIsRateLimited(selection)).toBe(false);
  expect(shouldSkipAttempt(selection, {})).toBe(false);
});
test('only the selected route determines whether background work is blocked', async () => {
  await home.initThrottle(['plan']);
  expect(configIsRateLimited(selection)).toBe(true);
  expect(shouldSkipAttempt(selection, {})).toBe(true);
  expect(configIsRateLimited({ ...selection, mode: 'api' })).toBe(false);
});
test('user-initiated runs bypass cached throttle state', async () => {
  await home.initThrottle(['plan']);
  expect(shouldSkipAttempt(selection, { isUserInitiated: true })).toBe(false);
});
test('provider attribution and credential classification use the selected backend', () => {
  expect(attemptProvider(selection)).toBe('anthropic');
  expect(attemptAuthType(selection)).toBe('oauth');
  expect(attemptAuthType({ ...selection, mode: 'api' })).toBe('api_key');
  const pi = { ...selection, backend: 'pi' as const, provider: 'deepseek', mode: 'deepseek' };
  expect(attemptProvider(pi)).toBe('deepseek');
  expect(attemptAuthType(pi)).toBeNull();
});
