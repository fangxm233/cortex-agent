import { describe, expect, it, vi } from 'vitest';
import {
  WARMUP_QUIET_MS, WARMUP_RETRY_MS, fiveHourEnd, newWarmupState, tickWindowWarmup,
  type WarmupDeps, type WindowEnd,
} from '../../src/orchestration/claude-window-warmup.js';

const MIN = 60_000;
const START = 1_000_000_000_000;

interface Harness {
  deps: WarmupDeps;
  clock: { now: number };
  end: { value: WindowEnd };
  running: { value: boolean };
  warm: ReturnType<typeof vi.fn>;
  collect: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<WarmupDeps> = {}): Harness {
  const clock = { now: START };
  const end: { value: WindowEnd } = { value: START };
  const running = { value: false };
  const warm = vi.fn(async (_mode: string) => {});
  const collect = vi.fn(async () => []);
  const deps: WarmupDeps = {
    enabled: () => true,
    mode: () => 'plan',
    windowEnd: async () => end.value,
    claudeRunning: () => running.value,
    warm,
    collectUsage: collect,
    now: () => clock.now,
    ...overrides,
  };
  return { deps, clock, end, running, warm, collect };
}

/** Tick once a minute from the current clock until `untilMs` past START. */
async function tickUntil(h: Harness, state: ReturnType<typeof newWarmupState>, untilMs: number): Promise<number> {
  let warmed = 0;
  while (h.clock.now < START + untilMs) {
    if (await tickWindowWarmup(state, h.deps)) warmed++;
    h.clock.now += MIN;
  }
  return warmed;
}

describe('fiveHourEnd', () => {
  it('reads the five-hour reset in epoch ms, null for an idle window, undefined without one', () => {
    const row = (windows: Array<{ type: string; resetsAt: number | null }>) => ({
      provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], observedAt: 1, freshness: 'live' as const,
      windows: windows.map((window) => ({ ...window, utilization: 0 })),
    });
    expect(fiveHourEnd(row([{ type: 'seven_day', resetsAt: 9 }, { type: 'five_hour', resetsAt: 5 }]))).toBe(5000);
    expect(fiveHourEnd(row([{ type: 'five_hour', resetsAt: null }]))).toBeNull();
    expect(fiveHourEnd(row([{ type: 'seven_day', resetsAt: 9 }]))).toBeUndefined();
    expect(fiveHourEnd(null)).toBeUndefined();
  });
});

describe('tickWindowWarmup', () => {
  it('warms up once the window has been closed and Claude quiet for ten minutes', async () => {
    const h = harness();
    const state = newWarmupState();
    expect(await tickUntil(h, state, WARMUP_QUIET_MS)).toBe(0);
    expect(await tickWindowWarmup(state, h.deps)).toBe(true);
    expect(h.warm).toHaveBeenCalledWith('plan');
    expect(h.collect).toHaveBeenCalledTimes(1);
  });

  it('does not warm up while the window is still open', async () => {
    const h = harness();
    h.end.value = START + 60 * MIN;
    expect(await tickUntil(h, newWarmupState(), 50 * MIN)).toBe(0);
    expect(h.warm).not.toHaveBeenCalled();
  });

  it('skips the window when a Claude run started after it closed', async () => {
    const h = harness();
    const state = newWarmupState();
    await tickUntil(h, state, 3 * MIN);
    h.running.value = true;
    await tickUntil(h, state, 4 * MIN);
    h.running.value = false;
    expect(await tickUntil(h, state, 60 * MIN)).toBe(0);
  });

  it('ignores a Claude run that ended before the window closed', async () => {
    const h = harness();
    h.end.value = START + 5 * MIN;
    const state = newWarmupState();
    h.running.value = true;
    await tickUntil(h, state, 2 * MIN);
    h.running.value = false;
    expect(await tickUntil(h, state, 16 * MIN)).toBe(1);
  });

  it('after a restart waits ten minutes of its own watching, even for a long-closed window', async () => {
    const h = harness();
    h.end.value = START - 3 * 60 * MIN;
    const state = newWarmupState();
    expect(await tickUntil(h, state, WARMUP_QUIET_MS)).toBe(0);
    expect(await tickWindowWarmup(state, h.deps)).toBe(true);
  });

  it('counts an idle window without a reset time from when it was first seen idle', async () => {
    const h = harness();
    h.end.value = null;
    const state = newWarmupState();
    expect(await tickUntil(h, state, WARMUP_QUIET_MS)).toBe(0);
    expect(await tickWindowWarmup(state, h.deps)).toBe(true);
  });

  it('warms up once per closed window', async () => {
    const h = harness();
    const state = newWarmupState();
    expect(await tickUntil(h, state, 60 * MIN)).toBe(1);
    h.end.value = h.clock.now + 5 * 60 * MIN;
    await tickWindowWarmup(state, h.deps);
    h.clock.now += 5 * 60 * MIN + MIN;
    expect(await tickUntil(h, state, 6 * 60 * MIN + 20 * MIN)).toBe(1);
  });

  it('retries a failed warm-up no sooner than the retry interval', async () => {
    const h = harness();
    h.warm.mockRejectedValue(new Error('rate limited'));
    const state = newWarmupState();
    await tickUntil(h, state, WARMUP_QUIET_MS + MIN);
    expect(h.warm).toHaveBeenCalledTimes(1);
    await tickUntil(h, state, WARMUP_QUIET_MS + WARMUP_RETRY_MS);
    expect(h.warm).toHaveBeenCalledTimes(1);
    await tickUntil(h, state, WARMUP_QUIET_MS + WARMUP_RETRY_MS + MIN);
    expect(h.warm).toHaveBeenCalledTimes(2);
    expect(h.collect).not.toHaveBeenCalled();
  });

  it('does nothing while disabled and watches afresh once enabled', async () => {
    let enabled = false;
    const h = harness({ enabled: () => enabled });
    const state = newWarmupState();
    expect(await tickUntil(h, state, 30 * MIN)).toBe(0);
    enabled = true;
    expect(await tickUntil(h, state, 30 * MIN + WARMUP_QUIET_MS)).toBe(0);
    expect(await tickWindowWarmup(state, h.deps)).toBe(true);
  });

  it('does nothing without a Claude subscription mode or a five-hour reading', async () => {
    const noMode = harness({ mode: () => null });
    expect(await tickUntil(noMode, newWarmupState(), 60 * MIN)).toBe(0);
    const noWindow = harness();
    noWindow.end.value = undefined;
    expect(await tickUntil(noWindow, newWarmupState(), 60 * MIN)).toBe(0);
  });
});
