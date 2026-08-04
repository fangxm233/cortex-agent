// input:  ScheduleInfo/SessionInfo DTOs, scheduled-chat + cost helpers
// output: buildScheduleRows / runOrdinals / row action + subline
// pos:    SCHEDULED rail-section view model (desktop 30a + mobile 8b)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { ScheduleInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { cadenceLabel, nextRunDelta } from './scheduled-chat';
import { sessionStamp } from './session-groups';
import { formatCost } from './right-panel-vm';

// Design 30a/8b: the SCHEDULED section shows ONE row per schedule (not per run). Rows union two
// sources: live schedule records (schedules.list) and orphan run groups — sessions whose scheduleId
// no longer resolves (a fired `once` schedule is deleted by the scheduler; a repeating schedule can
// be removed). Adopted runs (origin flipped to 'direct' by a reply) belong to the day timeline, and
// legacy runs without a scheduleId have no schedule identity — neither produces a row here.

export interface ScheduleRow {
  scheduleId: string;
  /** Live schedule record, or null for an orphan group (fired-once / deleted schedule). */
  schedule: ScheduleInfo | null;
  title: string;
  /** repeat → run-list modal; once → direct session open. Orphans infer from their run count. */
  kind: 'repeat' | 'once';
  /** This schedule's un-adopted runs, latest-first. */
  runs: SessionInfo[];
  latest: SessionInfo | null;
  unread: boolean;
}

export type ScheduleRowAction =
  | { type: 'modal' }
  | { type: 'open'; sessionId: string }
  | { type: 'edit' };

export type ScheduleSubline =
  | { kind: 'run'; stamp: string; cost: string | null }
  | { kind: 'pending'; cadence: string; nextDelta: string | null }
  | { kind: 'paused'; cadence: string };

function effectiveMs(s: SessionInfo): number {
  const t = Date.parse(s.lastUsedAt || s.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Group un-adopted runs by scheduleId (adopted / legacy runs excluded). */
function runsBySchedule(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const m = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (s.origin !== 'scheduled' || s.scheduleId == null) continue;
    const list = m.get(s.scheduleId) ?? [];
    list.push(s);
    m.set(s.scheduleId, list);
  }
  for (const list of m.values()) list.sort((a, b) => effectiveMs(b) - effectiveMs(a));
  return m;
}

/** Row activity for ordering: latest run, else the record's lastRun (runs may be purged), else 0
 *  (never fired — sinks last). */
function rowMs(row: ScheduleRow): number {
  if (row.latest) return effectiveMs(row.latest);
  const last = row.schedule?.lastRun;
  const t = last ? Date.parse(last) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function buildScheduleRows(
  schedules: ScheduleInfo[],
  scheduledSessions: SessionInfo[],
  _now: number,
): ScheduleRow[] {
  const grouped = runsBySchedule(scheduledSessions);
  const rows: ScheduleRow[] = [];
  for (const sched of schedules) {
    const runs = grouped.get(sched.id) ?? [];
    grouped.delete(sched.id);
    rows.push({
      scheduleId: sched.id,
      schedule: sched,
      title: sched.message.trim() || (runs[0]?.label ?? runs[0]?.name ?? sched.id),
      kind: sched.type === 'once' ? 'once' : 'repeat',
      runs,
      latest: runs[0] ?? null,
      unread: runs.some((r) => r.unread),
    });
  }
  for (const [scheduleId, runs] of grouped) {
    rows.push({
      scheduleId,
      schedule: null,
      title: runs[0].label ?? runs[0].name,
      kind: runs.length > 1 ? 'repeat' : 'once',
      runs,
      latest: runs[0],
      unread: runs.some((r) => r.unread),
    });
  }
  return rows.sort((a, b) => rowMs(b) - rowMs(a));
}

/** 1-based run numbers by createdAt ascending (oldest = #1). Honest caveat: numbering covers
 *  REGISTERED runs only — failed fires never register a session and purged runs compress the
 *  count — so #n is "nth surviving run", not a server-side fire counter. */
export function runOrdinals(runs: SessionInfo[]): Map<string, number> {
  const asc = [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const m = new Map<string, number>();
  asc.forEach((r, i) => m.set(r.sessionId, i + 1));
  return m;
}

/** Click routing (30a): repeat → run-list modal; once with a run → open it directly (no modal);
 *  a live schedule with nothing to show yet → edit modal. */
export function scheduleRowAction(row: ScheduleRow): ScheduleRowAction {
  if (row.runs.length === 0) return { type: 'edit' };
  if (row.kind === 'once') return { type: 'open', sessionId: row.runs[0].sessionId };
  return { type: 'modal' };
}

/** Second line under the row title — real data only: last fired stamp + that run's cost; a
 *  never-fired schedule shows its cadence + next-run delta; paused wins over both. */
export function scheduleSubline(row: ScheduleRow, now: number): ScheduleSubline {
  if (row.schedule?.paused) return { kind: 'paused', cadence: cadenceLabel(row.schedule) };
  if (row.latest) {
    return {
      kind: 'run',
      stamp: sessionStamp(row.latest, now),
      cost: row.latest.costUsd != null ? formatCost(row.latest.costUsd) : null,
    };
  }
  const sched = row.schedule;
  return {
    kind: 'pending',
    cadence: sched ? cadenceLabel(sched) : '',
    nextDelta: sched ? nextRunDelta(sched.nextRun, now) : null,
  };
}

/** 30c/8d chat title for an UN-ADOPTED run:「message · run #n」. Null when the schedule record is
 *  gone (fired-once / deleted — the plain session label stands) or the session is not a run. */
export function scheduledRunTitle(
  schedule: ScheduleInfo | null | undefined,
  runs: SessionInfo[],
  sessionId: string,
): string | null {
  if (!schedule) return null;
  const n = runOrdinals(runs).get(sessionId);
  return n == null ? null : `${schedule.message} · run #${n}`;
}

/** Collapsed-header「m 未读」/ mobile clock badge: unread ROWS (schedules), not unread runs. */
export function unreadScheduleCount(rows: ScheduleRow[]): number {
  return rows.filter((r) => r.unread).length;
}
