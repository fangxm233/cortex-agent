// input:  recent clock scheduler with injected timer functions
// output: minute tick and cleanup regressions
// pos:    Recent-list clock unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import { RECENT_TICK_MS, startRecentTicker } from './useRecentNow';

describe('startRecentTicker', () => {
  it('ticks once per minute and clears its timer', () => {
    let tick: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void, intervalMs: number) => {
      tick = callback;
      expect(intervalMs).toBe(RECENT_TICK_MS);
      return 17;
    });
    const cancel = vi.fn();
    const onTick = vi.fn();

    const cleanup = startRecentTicker(onTick, schedule, cancel);
    tick?.();
    cleanup();

    expect(schedule).toHaveBeenCalledOnce();
    expect(onTick).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(17);
  });
});
