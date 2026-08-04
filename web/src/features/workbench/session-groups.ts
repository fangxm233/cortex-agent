// input:  SessionInfo DTO, i18n Vocab
// output: groupSessions + row meta helpers
// pos:    Day-grouped session-list view model (desktop + mobile)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { SessionInfo } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

// Pure structural helpers for the left-rail session list (prototype L60–85). The design groups
// sessions under TODAY / YESTERDAY headers; real `sessions.list` can carry older sessions, so an
// EARLIER bucket (same header style) absorbs anything before yesterday. All time reasoning is
// local calendar day / wall-clock (matching the prototype's local `07:05` metas).

export type SessionGroupLabel = 'TODAY' | 'YESTERDAY' | 'EARLIER';

export interface SessionGroup {
  label: SessionGroupLabel;
  items: SessionInfo[];
}

// Effective timestamp: prefer lastUsedAt, fall back to createdAt.
function effectiveMs(s: SessionInfo): number {
  const t = Date.parse(s.lastUsedAt || s.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

// Whole-day index in local time (days since epoch by local midnight).
function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000,
  );
}

export function groupSessions(sessions: SessionInfo[], now: Date | number): SessionGroup[] {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const today = localDayIndex(nowMs);

  const buckets: Record<SessionGroupLabel, SessionInfo[]> = { TODAY: [], YESTERDAY: [], EARLIER: [] };
  for (const s of sessions) {
    const day = localDayIndex(effectiveMs(s));
    const label: SessionGroupLabel = day >= today ? 'TODAY' : day === today - 1 ? 'YESTERDAY' : 'EARLIER';
    buckets[label].push(s);
  }

  // Within each day group, UNREAD sessions float to the top (both halves stay recency-sorted).
  // Grouping stays day-based — an unread YESTERDAY session does not hoist into TODAY.
  const order: SessionGroupLabel[] = ['TODAY', 'YESTERDAY', 'EARLIER'];
  return order
    .map((label) => ({
      label,
      items: buckets[label].sort(
        (a, b) => Number(!!b.unread) - Number(!!a.unread) || effectiveMs(b) - effectiveMs(a),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

/** Display label for a session group (i18n-aware). */
export function groupLabel(L: Vocab, label: SessionGroupLabel): string {
  switch (label) {
    case 'TODAY': return L.wbSessionToday;
    case 'YESTERDAY': return L.wbSessionYesterday;
    case 'EARLIER': return L.wbSessionEarlier;
  }
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

// Meta line: local HH:MM of the effective timestamp, plus a "from schedule" marker for scheduled
// sessions. SessionInfo carries no turns/cost/running fields (GAP-2) so the meta is time + kind only.
// A bare clock is only unambiguous while the group header still dates the row: TODAY and YESTERDAY
// say which day it was, EARLIER does not. So rows that fall into the EARLIER bucket — anything
// before yesterday, by the same local-calendar-day test `groupSessions` uses — carry the date too,
// as `MM-DD HH:MM`, widening to `YYYY-MM-DD HH:MM` once the year no longer matches the current one.
export function sessionMeta(L: Vocab, s: SessionInfo, now: Date | number = Date.now()): string {
  const stamp = sessionStamp(s, now);
  return s.kind === 'scheduled' ? stamp + ' · ' + L.wbFromSchedule : stamp;
}

/** Raw time stamp of a session (no kind marker) — schedule-group run sub-rows use this directly. */
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
// first two chars (single-segment). `quad-nav-sim2real` → `QN`, `nimbus` → `NI`.
export function projectInitials(id: string): string {
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length >= 2) return (segments[0][0] + segments[1][0]).toUpperCase();
  if (segments.length === 1) return segments[0].slice(0, 2).toUpperCase();
  return '?';
}
