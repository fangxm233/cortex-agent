import type { SessionInfo } from '@cortex-agent/ui-contract';

// Pure session display helpers shared by the rail, schedule runs and the mobile screens. All time
// reasoning is local calendar day / wall-clock.

// Effective timestamp: prefer lastUsedAt, fall back to createdAt.
function effectiveMs(s: SessionInfo): number {
  const t = Date.parse(s.lastUsedAt || s.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Unread first, then most recent — the order inside every desktop rail folder, and the mobile
 *  session list, so the two chromes list a project's sessions identically. */
export function orderSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort(
    (a, b) => Number(!!b.unread) - Number(!!a.unread) || effectiveMs(b) - effectiveMs(a),
  );
}

// Whole-day index in local time (days since epoch by local midnight).
function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000,
  );
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

// Today and yesterday show a bare `HH:MM`. Anything before yesterday (by local calendar day)
// carries the date too, as `MM-DD HH:MM`, widening to `YYYY-MM-DD HH:MM` once the year no longer
// matches the current one.
export function sessionStamp(s: SessionInfo, now: Date | number = Date.now()): string {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const ms = effectiveMs(s);
  const d = new Date(ms);
  const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const earlier = localDayIndex(ms) < localDayIndex(nowMs) - 1;
  const date = earlier
    ? (d.getFullYear() === new Date(nowMs).getFullYear() ? '' : d.getFullYear() + '-') +
      pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
    : '';
  return date + clock;
}

// Avatar initials from a project id: first letter of the first two `-`/`_`-split segments, else the
// first two chars (single-segment). `orchard-nav-sim` → `ON`, `nimbus` → `NI`.
export function projectInitials(id: string): string {
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length >= 2) return (segments[0][0] + segments[1][0]).toUpperCase();
  if (segments.length === 1) return segments[0].slice(0, 2).toUpperCase();
  return '?';
}
