// Shared TTL countdown hook for interaction cards (desktop 13b/13c + mobile 5b/6a). Derives the
// remaining time from the row's REAL ts + the server's 30m expiry constant (interaction-vm
// INTERACTION_TTL_MS) — a derivation of server behavior, not a fabricated deadline. Ticks once a
// second while active and > 0.
import { useEffect, useState } from 'react';
import { interactionTtlMsLeft } from './interaction-vm';

export function useTtlSeconds(ts: string | null, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  const left = active ? interactionTtlMsLeft(ts, now) : null;
  const ticking = active && left != null && left > 0;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return left == null ? null : Math.floor(left / 1000);
}
