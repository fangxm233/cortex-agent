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

// ── Mixed rail items (design 27a-B) ─────────────────────────────────────────
// Scheduled runs share the manual-session timeline. Runs of one schedule auto-collapse into a
// single group row once there are ≥2; the group sits in the day bucket of its LATEST run. A lone
// run, a legacy run without scheduleId, and an adopted run (origin flipped to 'direct' after a
// reply) all stay plain session rows.

export type RailItem =
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'schedule-group'; scheduleId: string; runs: SessionInfo[]; latest: SessionInfo; unread: boolean };

export interface RailGroup {
  label: SessionGroupLabel;
  items: RailItem[];
}

function itemMs(i: RailItem): number {
  return effectiveMs(i.kind === 'session' ? i.session : i.latest);
}

function itemUnread(i: RailItem): boolean {
  return i.kind === 'session' ? !!i.session.unread : i.unread;
}

/** Partition sessions into plain rows + per-schedule collapsed groups (unbucketed). */
function buildRailItems(sessions: SessionInfo[]): RailItem[] {
  const bySchedule = new Map<string, SessionInfo[]>();
  const singles: SessionInfo[] = [];
  for (const s of sessions) {
    if (s.origin === 'scheduled' && s.scheduleId != null) {
      const runs = bySchedule.get(s.scheduleId) ?? [];
      runs.push(s);
      bySchedule.set(s.scheduleId, runs);
    } else {
      singles.push(s);
    }
  }
  const items: RailItem[] = singles.map((session) => ({ kind: 'session' as const, session }));
  for (const [scheduleId, runs] of bySchedule) {
    if (runs.length < 2) {
      items.push({ kind: 'session', session: runs[0] });
      continue;
    }
    runs.sort((a, b) => effectiveMs(b) - effectiveMs(a));
    items.push({ kind: 'schedule-group', scheduleId, runs, latest: runs[0], unread: runs.some((r) => !!r.unread) });
  }
  return items;
}

/** Day-bucketed mixed rail: same TODAY/YESTERDAY/EARLIER + unread-float rules as groupSessions,
 *  with schedule groups participating via their latest run / aggregated unread. */
export function groupRailItems(sessions: SessionInfo[], now: Date | number): RailGroup[] {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const today = localDayIndex(nowMs);
  const buckets: Record<SessionGroupLabel, RailItem[]> = { TODAY: [], YESTERDAY: [], EARLIER: [] };
  for (const item of buildRailItems(sessions)) {
    const day = localDayIndex(itemMs(item));
    const label: SessionGroupLabel = day >= today ? 'TODAY' : day === today - 1 ? 'YESTERDAY' : 'EARLIER';
    buckets[label].push(item);
  }
  const order: SessionGroupLabel[] = ['TODAY', 'YESTERDAY', 'EARLIER'];
  return order
    .map((label) => ({
      label,
      items: buckets[label].sort(
        (a, b) => Number(itemUnread(b)) - Number(itemUnread(a)) || itemMs(b) - itemMs(a),
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
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const ms = effectiveMs(s);
  const d = new Date(ms);
  const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const earlier = localDayIndex(ms) < localDayIndex(nowMs) - 1;
  const date = earlier
    ? (d.getFullYear() === new Date(nowMs).getFullYear() ? '' : d.getFullYear() + '-') +
      pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
    : '';
  const stamp = date + clock;
  return s.kind === 'scheduled' ? stamp + ' · ' + L.wbFromSchedule : stamp;
}

// Avatar initials from a project id: first letter of the first two `-`/`_`-split segments, else the
// first two chars (single-segment). `quad-nav-sim2real` → `QN`, `nimbus` → `NI`.
export function projectInitials(id: string): string {
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length >= 2) return (segments[0][0] + segments[1][0]).toUpperCase();
  if (segments.length === 1) return segments[0].slice(0, 2).toUpperCase();
  return '?';
}
