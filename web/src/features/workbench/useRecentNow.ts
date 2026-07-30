// input:  React effects, clock state, browser interval functions
// output: minute-resolution current time for recent lists
// pos:    Shared recent-list clock hook
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useState } from 'react';

export const RECENT_TICK_MS = 60_000;

type ScheduleTicker = (callback: () => void, intervalMs: number) => number;
type CancelTicker = (timerId: number) => void;

export function startRecentTicker(
  onTick: () => void,
  schedule: ScheduleTicker = (callback, intervalMs) => window.setInterval(callback, intervalMs),
  cancel: CancelTicker = (timerId) => window.clearInterval(timerId),
): () => void {
  const timerId = schedule(onTick, RECENT_TICK_MS);
  return () => cancel(timerId);
}

export function useRecentNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return startRecentTicker(() => setNow(Date.now()));
  }, [active]);
  return now;
}
