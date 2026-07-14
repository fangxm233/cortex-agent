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

  const order: SessionGroupLabel[] = ['TODAY', 'YESTERDAY', 'EARLIER'];
  return order
    .map((label) => ({
      label,
      items: buckets[label].sort((a, b) => effectiveMs(b) - effectiveMs(a)),
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
export function sessionMeta(L: Vocab, s: SessionInfo): string {
  const d = new Date(effectiveMs(s));
  const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return s.kind === 'scheduled' ? clock + ' · ' + L.wbFromSchedule : clock;
}

// Avatar initials from a project id: first letter of the first two `-`/`_`-split segments, else the
// first two chars (single-segment). `quad-nav-sim2real` → `QN`, `nimbus` → `NI`.
export function projectInitials(id: string): string {
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length >= 2) return (segments[0][0] + segments[1][0]).toUpperCase();
  if (segments.length === 1) return segments[0].slice(0, 2).toUpperCase();
  return '?';
}
