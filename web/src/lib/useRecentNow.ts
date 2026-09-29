import { useEffect, useState } from 'react';

const RECENT_TICK_MS = 60_000;

export function useRecentNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timerId = window.setInterval(() => setNow(Date.now()), RECENT_TICK_MS);
    return () => window.clearInterval(timerId);
  }, [active]);
  return now;
}
