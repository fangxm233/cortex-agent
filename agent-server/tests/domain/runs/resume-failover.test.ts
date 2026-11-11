// A conversation that hit its login's limit continues at once on another login when account
// failover is on: its resume entry waits on the free login (so it is ready now) and says it is a
// failover; the run's notice says it continues now. Off, both are what they always were.
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import type { FailoverDeps } from '../../../src/domain/runs/account-failover.js';
import { AttemptNoticeTracker } from '../../../src/domain/runs/notices.js';
import { recordDirectResume } from '../../../src/domain/runs/observers/resume-recorder.js';
import {
  initRateLimitThrottle, handleRateLimitEvent, _testReset as throttleReset,
} from '../../../src/domain/costs/rate-limit-throttle.js';
import {
  initResumeRegistry, pendingResumes, takeReadyResumes, _testReset as resumeReset,
} from '../../../src/domain/costs/resume-registry.js';
import { MockAdapter } from '../../../src/platform/testing.js';

const SELECTION: EngineSelection = {
  backend: 'claude', provider: null, model: 'claude-sonnet-4-6', thinking: null, connection: 'subscription',
};
const direct = { channel: 'web:c1', trackSessionId: 'cortex-abcd', userMessage: 'hello' };

async function limit(...routes: string[]): Promise<void> {
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  await initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }) as never, { save: async () => {}, load: async () => null } as never);
  for (const [index, mode] of routes.entries()) {
    await handleRateLimitEvent(
      { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 + index * 60 },
      { provider: 'anthropic', displayName: 'Anthropic', mode },
    );
  }
}

const failover = (enabled: boolean): FailoverDeps => ({
  enabled: () => enabled, logins: () => ['subscription', 'school'], billingOf: () => 'subscription',
});

const hasFailoverResume = () => pendingResumes().some((entry) => entry.failover === true);

afterEach(() => { throttleReset(); resumeReset(); });

describe('the resume entry of a limited conversation', () => {
  it('continues on the free login at once with failover on', async () => {
    await limit('subscription');
    const hit = { provider: 'anthropic', route: 'subscription', ...direct, selection: SELECTION };
    expect(recordDirectResume(hit, failover(true))).toBe(true);
    expect(hasFailoverResume()).toBe(true);
    const [entry] = takeReadyResumes(['anthropic::subscription']);
    expect(entry).toMatchObject({ provider: 'anthropic::school', failover: true, channel: 'web:c1' });
  });

  it('waits for its own login with failover off, exactly as before', async () => {
    await limit('subscription');
    const hit = { provider: 'anthropic', route: 'subscription', ...direct, selection: SELECTION };
    expect(recordDirectResume(hit, failover(false))).toBe(true);
    expect(hasFailoverResume()).toBe(false);
    expect(takeReadyResumes(['anthropic::subscription'])).toEqual([]);
    const [entry] = takeReadyResumes([]);
    expect(entry).toEqual({ kind: 'direct', provider: 'anthropic::subscription', ...direct, recordedAt: entry!.recordedAt });
  });

  it('waits when the run was already on another login, so one continuation switches once', async () => {
    await limit('subscription', 'school');
    const hit = { provider: 'anthropic', route: 'school', ...direct, selection: SELECTION };
    expect(recordDirectResume(hit, failover(true))).toBe(true);
    expect(hasFailoverResume()).toBe(false);
    expect(takeReadyResumes(['anthropic::subscription', 'anthropic::school'])).toEqual([]);
  });

  it('waits when every other login is limited too', async () => {
    await limit('subscription', 'school');
    const hit = { provider: 'anthropic', route: 'subscription', ...direct, selection: SELECTION };
    expect(recordDirectResume(hit, failover(true))).toBe(true);
    expect(hasFailoverResume()).toBe(false);
  });
});

describe('the notice of a limited run', () => {
  function notice(failoverResume?: () => boolean): string[] {
    const lines: string[] = [];
    const tracker = new AttemptNoticeTracker(
      { channel: 'web:c1', isUserInitiated: true, trigger: 'user', ...(failoverResume ? { failoverResume } : {}) },
      (text) => { lines.push(text); },
    );
    tracker.emitTerminalRateLimit({
      sessionId: null, total_cost_usd: null, num_turns: null, rateLimited: true, rateLimitMessage: null,
      rateLimitProvider: 'anthropic', rateLimitRoute: 'subscription',
      planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
    });
    return lines;
  }

  it('says the chat continues now on a failover, and waits for the reset otherwise', async () => {
    await limit('subscription');
    expect(notice(() => true)).toEqual(['Rate limited — this chat continues on another account now.']);
    expect(notice(() => false)).toEqual(['Rate limited — this chat will resume automatically when the limit resets.']);
    expect(notice()).toEqual(['Rate limited — this chat will resume automatically when the limit resets.']);
  });
});
