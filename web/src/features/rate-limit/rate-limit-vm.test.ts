import { describe, expect, it } from 'vitest';
import { buildRateLimitView } from './rate-limit-vm';

const NOW = 1_800_000_000;

function window(type: string, seconds: number, utilization = 0.96, label?: string) {
  return { type, ...(label ? { label } : {}), utilization, resetsAt: NOW + seconds, activatedAt: (NOW - 30) * 1000 };
}

describe('buildRateLimitView', () => {
  it('hides the control for empty or fully expired records', () => {
    expect(buildRateLimitView({ providers: [] }, NOW, 'en')).toBeNull();
    expect(buildRateLimitView({
      providers: [{
        provider: 'anthropic', displayName: 'Anthropic', waitingSessions: 0, waitingThreads: 0,
        windows: [{ ...window('seven_day', -1), resetsAt: NOW - 1 }],
      }],
    }, NOW, 'en')).toBeNull();
  });

  it('uses earliest provider recovery for aggregate copy, not the earliest individual window', () => {
    const vm = buildRateLimitView({
      providers: [
        {
          provider: 'anthropic', displayName: 'Anthropic', waitingSessions: 0, waitingThreads: 0,
          windows: [window('five_hour', 5 * 60), window('seven_day', 60 * 60)],
        },
        {
          provider: 'openai-codex', displayName: 'OpenAI', waitingSessions: 0, waitingThreads: 0,
          windows: [window('five_hour', 42 * 60)],
        },
      ],
    }, NOW, 'en');

    expect(vm?.firstRecoveryAt).toBe(NOW + 42 * 60);
  });

  it('retains distinct reset times and deterministically orders providers and windows', () => {
    const vm = buildRateLimitView({
      providers: [
        { provider: 'z', displayName: 'Zulu', waitingSessions: 0, waitingThreads: 0, windows: [window('seven_day', 900)] },
        {
          provider: 'a', displayName: 'Alpha', waitingSessions: 0, waitingThreads: 0,
          windows: [window('seven_day', 600), window('five_hour', 300)],
        },
      ],
    }, NOW, 'en');

    expect(vm?.providers.map((provider) => provider.displayName)).toEqual(['Alpha', 'Zulu']);
    expect(vm?.providers[0].windows.map((item) => [item.typeLabel, item.resetsAt])).toEqual([
      ['5h', NOW + 300], ['7d', NOW + 600],
    ]);
  });
});
