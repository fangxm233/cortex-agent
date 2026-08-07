// input:  provider throttle snapshots, language, current time
// output: compact-label, countdown, expiry, and order assertions
// pos:    Regression tests for the shared rate-limit view model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { buildRateLimitView } from './rate-limit-vm';

const NOW = 1_800_000_000;

function window(type: string, seconds: number, utilization = 0.96) {
  return { type, utilization, resetsAt: NOW + seconds, activatedAt: (NOW - 30) * 1000 };
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

  it('keeps the compact label window-free while retaining window detail', () => {
    const vm = buildRateLimitView({
      providers: [{
        provider: 'anthropic', displayName: 'Anthropic', waitingSessions: 1, waitingThreads: 2,
        windows: [window('seven_day', 14 * 3600 + 43 * 60)],
      }],
    }, NOW, 'en');

    expect(vm?.label).toBe('Anthropic · 14h 43m');
    expect(vm?.providers[0].windows[0]).toMatchObject({ typeLabel: '7d', countdown: '14h 43m' });
    expect(vm?.providers[0].waitingLabel).toBe('1 session · 2 threads waiting');
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

    expect(vm?.label).toBe('2 providers limited · first 42m');
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

  it('uses the approved Chinese aggregate copy', () => {
    const vm = buildRateLimitView({
      providers: [
        { provider: 'a', displayName: 'Anthropic', waitingSessions: 1, waitingThreads: 0, windows: [window('seven_day', 3600)] },
        { provider: 'o', displayName: 'OpenAI', waitingSessions: 0, waitingThreads: 3, windows: [window('five_hour', 42 * 60)] },
      ],
    }, NOW, 'zh');

    expect(vm?.label).toBe('2 个 provider 限流 · 首个 42m');
    expect(vm?.providers.map((provider) => provider.waitingLabel)).toEqual([
      '1 个会话 · 0 个线程等待恢复',
      '0 个会话 · 3 个线程等待恢复',
    ]);
  });
});
