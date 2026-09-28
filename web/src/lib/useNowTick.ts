import { useEffect, useState } from 'react';

/** Wall clock that re-renders its caller every `intervalMs` while `active`, and holds still
 *  otherwise. Refreshed the moment it activates, so a clock mounted long ago never starts stale. */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => setNow(Date.now()), intervalMs);
    return () => globalThis.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
