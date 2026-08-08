import { describe, expect, it, vi } from 'vitest';

import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';

function fixedSource<T>(values: T[]): () => T {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe('DeterministicClock (§7.2 P17)', () => {
  it('reads wall time from the injected source, never from Date.now()', () => {
    const clock = createTrialClock({
      deadlineEpochMs: 5_000,
      now: fixedSource([1_000, 2_000, 3_000]),
    });
    const drift = vi.spyOn(Date, 'now').mockReturnValue(999_999_999);
    try {
      expect(clock.nowMs()).toBe(1_000);
      expect(clock.nowMs()).toBe(2_000);
      expect(clock.nowDate().getTime()).toBe(3_000);
    } finally {
      drift.mockRestore();
    }
  });

  it('nowDate returns a fresh Date each call so a caller cannot mutate the clock', () => {
    const clock = createTrialClock({ deadlineEpochMs: 10, now: () => 7 });
    const first = clock.nowDate();
    first.setTime(1_234);
    expect(clock.nowDate().getTime()).toBe(7);
  });

  it('remainingMs counts down against the frozen deadline', () => {
    const clock = createTrialClock({
      deadlineEpochMs: 1_500,
      now: fixedSource([1_000, 1_400]),
    });
    expect(clock.remainingMs()).toBe(500);
    expect(clock.remainingMs()).toBe(100);
  });

  it('remainingMs() <= 0 exactly at the deadline — the D5 boundary is inclusive', () => {
    const atDeadline = createTrialClock({ deadlineEpochMs: 2_000, now: () => 2_000 });
    expect(atDeadline.remainingMs()).toBe(0);
    expect(atDeadline.remainingMs() <= 0).toBe(true);
  });

  it('remainingMs goes negative past the deadline rather than clamping', () => {
    const clock = createTrialClock({ deadlineEpochMs: 2_000, now: () => 2_750 });
    expect(clock.remainingMs()).toBe(-750);
  });

  it('monotonicNs reports nanoseconds elapsed from the clock origin, not the raw source', () => {
    const clock = createTrialClock({
      deadlineEpochMs: 10,
      now: () => 0,
      monotonic: fixedSource([500n, 900n, 1_400n] as unknown as number[]) as unknown as () => bigint,
    });
    expect(clock.monotonicNs()).toBe(400n);
    expect(clock.monotonicNs()).toBe(900n);
  });

  it('monotonicNs never decreases across successive reads on the shipped default source', () => {
    const clock = createTrialClock({ deadlineEpochMs: 10 });
    const reads = [clock.monotonicNs(), clock.monotonicNs(), clock.monotonicNs()];
    expect(reads[1] >= reads[0]).toBe(true);
    expect(reads[2] >= reads[1]).toBe(true);
    expect(reads[0] >= 0n).toBe(true);
  });

  it('sleep resolves after the requested delay', async () => {
    vi.useFakeTimers();
    try {
      const clock = createTrialClock({ deadlineEpochMs: 10_000, now: () => 0 });
      let settled = false;
      const pending = clock.sleep(50).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sleep rejects with the abort reason and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      const clock = createTrialClock({ deadlineEpochMs: 10_000, now: () => 0 });
      const controller = new AbortController();
      const reason = new Error('trial cancelled');
      const pending = clock.sleep(1_000, controller.signal);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sleep rejects immediately when handed an already-aborted signal', async () => {
    const clock = createTrialClock({ deadlineEpochMs: 10_000, now: () => 0 });
    const reason = new Error('already gone');
    await expect(clock.sleep(1_000, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  it('is a zero-dependency value object: the module imports nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../../src/domain/benchmark/trial-clock.ts', import.meta.url), 'utf8',
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
