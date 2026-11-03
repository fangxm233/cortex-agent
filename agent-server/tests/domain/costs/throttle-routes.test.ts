// A throttle is filed under provider and route, so one account's limit never holds another's work.
import { afterEach, describe, expect, it } from 'vitest';
import {
  _testReset, activateOutageWindow, clearThrottle, getThrottleState, handleRateLimitEvent,
  initRateLimitThrottle, isProviderModeRateLimited, isProviderRateLimited, releaseRecoveredQuota,
  type RateLimitThrottleState,
} from '../../../src/domain/costs/rate-limit-throttle.js';
import {
  _testReset as resetResumes, initResumeRegistry, recordResume, takeReadyResumes,
} from '../../../src/domain/costs/resume-registry.js';
import { throttleKey, throttleKeyBlocked } from '../../../src/domain/costs/throttle-key.js';
import { MockAdapter } from '../../../src/platform/testing.js';

const resetsAt = () => Math.floor(Date.now() / 1000) + 3600;
const anthropic = (mode: string) => ({ provider: 'anthropic', displayName: 'Anthropic', mode });

async function init(stored: RateLimitThrottleState | null = null) {
  const saved: Array<RateLimitThrottleState | null> = [];
  const resumed: string[][] = [];
  await initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }), {
    save: async (state) => { saved.push(state); }, load: async () => stored,
  }, (keys) => resumed.push(keys));
  return { saved, resumed };
}

async function limit(mode: string): Promise<void> {
  await handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.99, resetsAt: resetsAt() }, anthropic(mode));
}

afterEach(() => {
  _testReset();
  resetResumes();
});

describe('throttle keys', () => {
  it('file a route under its provider; a route-less entry covers every route', () => {
    expect(throttleKey('anthropic', 'school')).toBe('anthropic::school');
    expect(throttleKey('anthropic')).toBe('anthropic');
    expect(throttleKeyBlocked('anthropic::school', new Set(['anthropic::subscription']))).toBe(false);
    expect(throttleKeyBlocked('anthropic::school', new Set(['anthropic::school']))).toBe(true);
    expect(throttleKeyBlocked('anthropic::school', new Set(['anthropic']))).toBe(true);
    expect(throttleKeyBlocked('anthropic', new Set(['anthropic::school']))).toBe(true);
    expect(throttleKeyBlocked('anthropic', new Set(['openai-codex::openai-codex']))).toBe(false);
  });
});

describe('a throttle per account', () => {
  it('holds only the limited account', async () => {
    await init();
    await limit('school');
    expect(isProviderModeRateLimited('anthropic', 'school')).toBe(true);
    expect(isProviderModeRateLimited('anthropic', 'subscription')).toBe(false);
    expect(isProviderRateLimited('anthropic', 'subscription')).toBe(false);
    expect(isProviderRateLimited('anthropic')).toBe(true);
    expect(getThrottleState().providers.map((entry) => [entry.route, entry.modes])).toEqual([['school', ['school']]]);
  });

  it('keeps two accounts\' windows apart', async () => {
    await init();
    await limit('school');
    await limit('subscription');
    expect(getThrottleState().providers.map((entry) => entry.route)).toEqual(['school', 'subscription']);
    const result = await clearThrottle('anthropic::school');
    expect(result.cleared.map((entry) => [entry.route, entry.displayName])).toEqual([['school', 'Anthropic (school)']]);
    expect(isProviderModeRateLimited('anthropic', 'subscription')).toBe(true);
    expect((await clearThrottle('anthropic')).cleared.map((entry) => entry.route)).toEqual(['subscription']);
  });

  it('holds every route during an outage', async () => {
    await init();
    await activateOutageWindow('anthropic', 60_000);
    expect(isProviderModeRateLimited('anthropic', 'school')).toBe(true);
    expect(isProviderModeRateLimited('anthropic', 'subscription')).toBe(true);
  });

  it('releases only the account a reading belongs to', async () => {
    const { resumed } = await init();
    await limit('school');
    await limit('subscription');
    expect(await releaseRecoveredQuota('anthropic', [{ type: 'five_hour', utilization: 0.1 }], 'subscription')).toBe(true);
    expect(getThrottleState().providers.map((entry) => entry.route)).toEqual(['school']);
    expect(resumed).toEqual([['anthropic::subscription']]);
  });

  it('splits a throttle stored before routes into one entry per route', async () => {
    const at = resetsAt();
    await init({ providers: [{
      provider: 'anthropic', displayName: 'Anthropic', modes: ['school', 'subscription'],
      windows: [
        { type: 'five_hour', utilization: 0.95, resetsAt: at, activatedAt: 1 },
        { type: 'outage', utilization: null, resetsAt: at, activatedAt: 1 },
      ],
    }] });
    expect(getThrottleState().providers.map((entry) => [entry.route ?? null, entry.windows.map((w) => w.type)])).toEqual([
      [null, ['outage']], ['school', ['five_hour']], ['subscription', ['five_hour']],
    ]);
  });
});

describe('resuming per account', () => {
  it('resumes work on one account while another is still limited', async () => {
    await initResumeRegistry({ save: async () => {}, load: async () => [] });
    const entry = (channel: string, provider: string) => ({ kind: 'direct' as const, provider, channel, userMessage: 'go', recordedAt: 1 });
    recordResume(entry('c-school', 'anthropic::school'));
    recordResume(entry('c-default', 'anthropic::subscription'));
    recordResume(entry('c-legacy', 'anthropic'));
    expect(takeReadyResumes(['anthropic::subscription']).map((e) => e.channel)).toEqual(['c-school']);
    expect(takeReadyResumes([]).map((e) => e.channel).sort()).toEqual(['c-default', 'c-legacy']);
  });
});
