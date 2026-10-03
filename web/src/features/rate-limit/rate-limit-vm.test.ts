import { describe, expect, it } from 'vitest';
import type { SystemRateLimitStatus } from '@cortex-agent/ui-contract';
import { buildRateLimitView } from './rate-limit-vm';

type RawProvider = SystemRateLimitStatus['providers'][number];

const NOW = 1_800_000_000;

function window(type: string, seconds: number, utilization = 0.96, label?: string) {
  return { type, ...(label ? { label } : {}), utilization, resetsAt: NOW + seconds, activatedAt: (NOW - 30) * 1000 };
}

function provider(fields: Pick<RawProvider, 'provider' | 'displayName' | 'windows'> & { waitingSessions?: number }): RawProvider {
  return { waitingSessions: 0, ...fields } as RawProvider;
}

describe('buildRateLimitView', () => {
  it('hides the control for empty or fully expired records', () => {
    expect(buildRateLimitView({ providers: [] }, NOW, 'en')).toBeNull();
    expect(buildRateLimitView({
      providers: [provider({
        provider: 'anthropic', displayName: 'Anthropic',
        windows: [{ ...window('seven_day', -1), resetsAt: NOW - 1 }],
      })],
    }, NOW, 'en')).toBeNull();
  });

  it('uses earliest provider recovery for aggregate copy, not the earliest individual window', () => {
    const vm = buildRateLimitView({
      providers: [
        provider({
          provider: 'anthropic', displayName: 'Anthropic',
          windows: [window('five_hour', 5 * 60), window('seven_day', 60 * 60)],
        }),
        provider({
          provider: 'openai-codex', displayName: 'OpenAI',
          windows: [window('five_hour', 42 * 60)],
        }),
      ],
    }, NOW, 'en');

    expect(vm?.label).toBe('2 providers limited · first 42m');
  });

  it('retains distinct reset times and deterministically orders providers and windows', () => {
    const vm = buildRateLimitView({
      providers: [
        provider({ provider: 'z', displayName: 'Zulu', windows: [window('seven_day', 900)] }),
        provider({
          provider: 'a', displayName: 'Alpha',
          windows: [window('seven_day', 600), window('five_hour', 300)],
        }),
      ],
    }, NOW, 'en');

    expect(vm?.providers.map((provider) => provider.displayName)).toEqual(['Alpha', 'Zulu']);
    expect(vm?.providers[0].windows.map((item) => [item.typeLabel, item.resetsAt])).toEqual([
      ['5h', NOW + 300], ['7d', NOW + 600],
    ]);
  });

  it('labels only the sessions waiting on recovery', () => {
    const raw = (waitingSessions: number) => ({
      providers: [provider({ provider: 'a', displayName: 'Alpha', waitingSessions, windows: [window('five_hour', 300)] })],
    });
    expect(buildRateLimitView(raw(1), NOW, 'en')?.providers[0].waitingLabel).toBe('1 session waiting');
    expect(buildRateLimitView(raw(3), NOW, 'en')?.providers[0].waitingLabel).toBe('3 sessions waiting');
    expect(buildRateLimitView(raw(2), NOW, 'zh')?.providers[0].waitingLabel).toBe('2 个会话等待恢复');
  });
});
