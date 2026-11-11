// An account-failover resume is started as soon as it is recorded and, unlike a window-reset
// resume, is neither dropped by auto-resume being off nor lost to a busy channel.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchPendingResumes, registerResumeWakeOnAgentSettle } from '../../src/orchestration/resume-dispatcher.js';
import { EventBus } from '../../src/events/index.js';
import { MockAdapter } from '../../src/platform/testing.js';
import {
  initResumeRegistry, pendingResumes, recordResume, _testReset as resumeReset, type ResumeEntry,
} from '../../src/domain/costs/resume-registry.js';
import {
  clearThrottle, handleRateLimitEvent, initRateLimitThrottle, _testReset as throttleReset,
} from '../../src/domain/costs/rate-limit-throttle.js';
import { recordDirectResume } from '../../src/domain/runs/observers/resume-recorder.js';
import { startsOnFreeLogin, type FailoverDeps } from '../../src/domain/runs/account-failover.js';
import type { EngineSelection } from '../../src/domain/agents/engine-selection.js';
import { updateSettings } from '../../src/core/settings.js';

const entry = (channel: string, failover?: true): ResumeEntry => ({
  kind: 'direct', provider: 'anthropic::school', channel, userMessage: 'orig', recordedAt: 1,
  ...(failover ? { failover } : {}),
});

function deps(entries: ResumeEntry[], busy: string[] = []) {
  const routed: string[] = [];
  const requeued: string[] = [];
  return {
    routed, requeued,
    overrides: {
      takeReady: () => entries,
      activeProviders: () => [],
      route: async (ctx: { channel: string }) => { routed.push(ctx.channel); },
      channelBusy: (channel: string) => busy.includes(channel),
      acquireSessionUse: async () => () => {},
      delay: async () => {},
      requeue: (queued: ResumeEntry) => { requeued.push(queued.channel); },
    },
  };
}

const adapter = new MockAdapter({ adminChannel: 'admin' }) as never;

afterEach(async () => {
  throttleReset();
  resumeReset();
  await updateSettings({ autoResume: true });
});

describe('dispatching resumes', () => {
  it('starts only failover entries while auto-resume is off', async () => {
    await updateSettings({ autoResume: false });
    const d = deps([entry('web:wait'), entry('web:switch', true)]);
    await dispatchPendingResumes(adapter, d.overrides);
    expect(d.routed).toEqual(['web:switch']);
  });

  it('starts every ready entry while auto-resume is on', async () => {
    const d = deps([entry('web:wait'), entry('web:switch', true)]);
    await dispatchPendingResumes(adapter, d.overrides);
    expect(d.routed).toEqual(['web:wait', 'web:switch']);
  });

  it('starts a waiting entry as soon as its conversation can go on on another login, auto-resume off', async () => {
    await updateSettings({ autoResume: false });
    await initResumeRegistry({ save: async () => {}, load: async () => [] });
    recordResume(entry('web:wait'));
    recordResume(entry('web:switch'));
    const routed: string[] = [];
    await dispatchPendingResumes(adapter, {
      activeProviders: () => ['anthropic::school'],
      canContinue: async (waiting) => waiting.channel === 'web:switch',
      route: async (ctx) => { routed.push(ctx.channel); },
      channelBusy: () => false, acquireSessionUse: async () => () => {}, delay: async () => {},
    });
    expect(routed).toEqual(['web:switch']);
    expect(pendingResumes().map((waiting) => waiting.channel)).toEqual(['web:wait']);
  });

  it('puts a failover entry back when its channel is busy, and drops any other as before', async () => {
    const d = deps([entry('web:wait'), entry('web:switch', true)], ['web:wait', 'web:switch']);
    await dispatchPendingResumes(adapter, d.overrides);
    expect(d.routed).toEqual([]);
    expect(d.requeued).toEqual(['web:switch']);
  });
});

describe('waking the dispatcher', () => {
  it('wakes on a rate-limit change only while an entry waits', async () => {
    const bus = new EventBus();
    let pending = false;
    let wakes = 0;
    const stop = registerResumeWakeOnAgentSettle(bus, adapter, async () => { wakes++; }, () => pending);
    bus.publish({ type: 'rate-limit.changed' });
    pending = true;
    bus.publish({ type: 'rate-limit.changed' });
    await Promise.resolve();
    expect(wakes).toBe(1);
    stop();
  });
});

describe('a failover resume, end to end through the queue', () => {
  it('is started as soon as it is recorded, with auto-resume off', async () => {
    await updateSettings({ autoResume: false });
    const bus = new EventBus();
    await initResumeRegistry({ save: async () => {}, load: async () => [] }, () => bus.publish({ type: 'rate-limit.changed' }));
    await initRateLimitThrottle(adapter, { save: async () => {}, load: async () => null } as never);
    await handleRateLimitEvent(
      { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 },
      { provider: 'anthropic', displayName: 'Anthropic', mode: 'subscription' },
    );
    const routed: string[] = [];
    const stop = registerResumeWakeOnAgentSettle(bus, adapter, (target) => dispatchPendingResumes(target, {
      route: async (ctx) => { routed.push(ctx.channel); },
      channelBusy: () => false, acquireSessionUse: async () => () => {}, delay: async () => {},
    }));
    recordDirectResume({
      provider: 'anthropic', route: 'subscription', channel: 'web:c1', trackSessionId: null, userMessage: 'hi',
      selection: { backend: 'claude', provider: null, model: 'claude-sonnet-4-6', thinking: null, connection: 'subscription' },
    }, { enabled: () => true, logins: () => ['subscription', 'school'], billingOf: () => 'subscription' });
    await vi.waitFor(() => expect(routed).toEqual(['web:c1']));
    stop();
  });
});

describe('a resume queued while every login was limited', () => {
  const school: EngineSelection = {
    backend: 'claude', provider: null, model: 'claude-sonnet-4-6', thinking: null, connection: 'school',
  };
  const failover: FailoverDeps = { enabled: () => true, logins: () => ['subscription', 'school'], billingOf: () => 'subscription' };
  const limit = (mode: string, minutes: number) => handleRateLimitEvent(
    { rateLimitType: 'seven_day', utilization: 0.97, resetsAt: Math.floor(Date.now() / 1000) + minutes * 60 },
    { provider: 'anthropic', displayName: 'Anthropic', mode },
  );

  it('goes on once another login frees, without waiting for its own', async () => {
    const routed: string[] = [];
    const dispatch = () => dispatchPendingResumes(adapter, {
      route: async (ctx) => { routed.push(ctx.channel); },
      channelBusy: () => false, acquireSessionUse: async () => () => {}, delay: async () => {},
      canContinue: async () => startsOnFreeLogin(school, failover),
    });
    await initResumeRegistry({ save: async () => {}, load: async () => [] });
    await initRateLimitThrottle(adapter, { save: async () => {}, load: async () => null } as never, () => { void dispatch(); });
    await limit('school', 3000);
    await limit('subscription', 60);
    expect(recordDirectResume({
      provider: 'anthropic', route: 'school', channel: 'web:c1', trackSessionId: null, userMessage: 'hi', selection: school,
    }, failover)).toBe(true);
    await dispatch();
    expect(routed).toEqual([]);

    await clearThrottle('anthropic::subscription');
    await vi.waitFor(() => expect(routed).toEqual(['web:c1']));
    expect(pendingResumes()).toEqual([]);
  });
});
