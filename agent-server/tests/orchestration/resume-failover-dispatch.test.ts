// An account-failover resume is started as soon as it is recorded and, unlike a window-reset
// resume, is neither dropped by auto-resume being off nor lost to a busy channel.
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchPendingResumes, registerResumeWakeOnAgentSettle } from '../../src/orchestration/resume-dispatcher.js';
import { EventBus } from '../../src/events/index.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { ResumeEntry } from '../../src/domain/costs/resume-registry.js';
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

afterEach(() => updateSettings({ autoResume: true }));

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

  it('puts a failover entry back when its channel is busy, and drops any other as before', async () => {
    const d = deps([entry('web:wait'), entry('web:switch', true)], ['web:wait', 'web:switch']);
    await dispatchPendingResumes(adapter, d.overrides);
    expect(d.routed).toEqual([]);
    expect(d.requeued).toEqual(['web:switch']);
  });
});

describe('waking the dispatcher', () => {
  it('wakes on a rate-limit change only while a failover entry waits', async () => {
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
