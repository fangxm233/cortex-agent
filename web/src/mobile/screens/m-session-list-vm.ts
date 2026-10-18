// Pure view-model for the 1a 会话列表 screen: project-local Stars plus the existing direct
// and scheduled lists. Session rows keep desktop rail order (unread first, then most recent)
// and carry their own relative time, without day buckets; the screen sections them by status
// (`sessionSections`).
import type { ScheduleInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { partitionStarredSessions } from '@/features/session/list/starred-sessions';
import { buildScheduleRows } from '@/features/session/list/schedule-rail';
import { shortSessionId } from '@/features/session/metadata/short-session-id';
import { orderSessions } from '@/features/session/list/session-groups';
import { groupWorkers, isInactiveWorker } from '@/features/team/worker-groups';
import { sessionRollup, workerRollup, type WorkerRollup } from '@/features/team/worker-rollup';
import { relTime } from '@/i18n/time-format';
import { en, fmt, type Vocab } from '@/i18n';

type Lang = 'en' | 'zh';

export type MSessionStatus = ReturnType<typeof sessionStatusLine>;

export interface MSessionRow {
  id: string;
  title: string;
  /** Relative time label (real, from lastUsedAt||createdAt). */
  time: string;
  unread: boolean;
  status: MSessionStatus;
}

// English pluralizes the count; Chinese uses one form.
function plural(L: Vocab, n: number, one: keyof Vocab, many: keyof Vocab): string {
  return fmt(n === 1 ? L[one] : L[many], { n });
}

/**
 * The status-line for a session row. Awaiting user action (pending ask-user / plan approval) wins
 * even while a turn or a background task is live — it is the ONLY amber「需要你」state. Background-held
 * (foreground turn done, background task still running) and running share the run-blue dot; an idle
 * session still expecting a waitpoint signal gets a hollow ring. Per-session cost has no DTO source
 * (SessionInfo carries none), so it is deliberately omitted.
 */
export function sessionStatusLine(s: SessionInfo, L: Vocab = en): { kind: 'running' | 'background' | 'awaiting' | 'waiting-external' | 'idle'; text: string } {
  if (s.awaitingInput) return { kind: 'awaiting', text: L.slAwaiting };
  if (s.running) {
    if (s.backgroundRunning) return { kind: 'background', text: L.slBackground };
    return { kind: 'running', text: s.numTurns != null ? fmt(L.slRunningTurns, { n: s.numTurns }) : L.slRunning };
  }
  const waitingOn = s.waitingOn ?? 0;
  if (waitingOn > 0) return { kind: 'waiting-external', text: plural(L, waitingOn, 'slWaitingOne', 'slWaitingMany') };
  return { kind: 'idle', text: L.slIdle };
}

function toRow(s: SessionInfo, now: number, lang: Lang, L: Vocab): MSessionRow {
  return {
    id: s.sessionId,
    title: s.label || shortSessionId(s.sessionId),
    time: relTime(s.lastUsedAt || s.createdAt, now, lang),
    unread: s.unread,
    status: sessionStatusLine(s, L),
  };
}

/**
 * A lead's status line with its workers rolled up, in the dot's precedence: anything blocked on the
 * user first, then the lead's own run, then its workers' runs, then waits. The lead's own line wins
 * within each tier, since it says more.
 */
function leadStatusLine(own: MSessionStatus, workers: WorkerRollup[], L: Vocab): MSessionStatus {
  const up = workerRollup(workers);
  if (own.kind === 'awaiting') return own;
  if (up.awaitingInput) return { kind: 'awaiting', text: L.slWorkerAwaiting };
  if (own.kind === 'running' || own.kind === 'background') return own;
  if (up.running) return { kind: 'running', text: plural(L, workers.filter((w) => w.running).length, 'slWorkersRunningOne', 'slWorkersRunningMany') };
  if (own.kind === 'waiting-external') return own;
  if (up.waitingOn) return { kind: 'waiting-external', text: plural(L, workers.filter((w) => w.waitingOn).length, 'slWorkersWaitingOne', 'slWorkersWaitingMany') };
  return own;
}

function toLeadRow(s: SessionInfo, workers: SessionInfo[], now: number, lang: Lang, L: Vocab): MSessionRow {
  const row = toRow(s, now, lang, L);
  // The workers the lead's chat offers (its worker strip leaves inactive ones out): whatever the
  // row signals, the user can reach from there.
  const team = workers.filter((w) => !isInactiveWorker(w, now)).map(sessionRollup);
  if (team.length === 0) return row;
  return {
    ...row,
    unread: row.unread || workerRollup(team).unread,
    status: leadStatusLine(row.status, team, L),
  };
}

export type MSessionSectionKey = 'needsYou' | 'active' | 'recent';

export interface MSessionSection {
  key: MSessionSectionKey;
  rows: MSessionRow[];
}

const SECTION_OF: Record<MSessionStatus['kind'], MSessionSectionKey> = {
  awaiting: 'needsYou',
  running: 'active',
  background: 'active',
  'waiting-external': 'active',
  idle: 'recent',
};

/** The list's sections, by what each row's status dot already says: blocked on the user first, then
 *  whatever is still moving or waiting on a machine, then the rest. Rows keep their rail order within
 *  a section; empty sections are left out. */
export function sessionSections(rows: MSessionRow[]): MSessionSection[] {
  const by: Record<MSessionSectionKey, MSessionRow[]> = { needsYou: [], active: [], recent: [] };
  for (const row of rows) by[SECTION_OF[row.status.kind]].push(row);
  return (['needsYou', 'active', 'recent'] as const)
    .filter((key) => by[key].length > 0)
    .map((key) => ({ key, rows: by[key] }));
}

/** Scope before partitioning: Stars never aggregate sessions from different projects. */
export function buildProjectSessionList(
  projectId: string | null, direct: SessionInfo[], scheduled: SessionInfo[],
  schedules: ScheduleInfo[], now: number = Date.now(), lang: Lang = 'en', L: Vocab = en, team = false,
) {
  // While project selection is unresolved, retain the existing flat list, not a global Stars group.
  if (projectId === null) return {
    rows: buildSessionRows(direct, now, lang, L, team), starredRows: [],
    scheduleRows: buildScheduleRows(schedules, scheduled),
  };
  const own = (session: SessionInfo) => session.projectId === projectId;
  const partition = partitionStarredSessions(direct.filter(own), scheduled.filter(own));
  // Workers nest under their lead across both lists, so starring a lead does not spill its
  // workers into the plain list.
  const listed = [...partition.starred, ...partition.direct];
  return {
    rows: buildSessionRows(partition.direct, now, lang, L, team, listed),
    starredRows: buildSessionRows(partition.starred, now, lang, L, team, listed),
    scheduleRows: buildScheduleRows(schedules.filter(s => s.projectId === projectId), partition.scheduled),
  };
}

/** Rows for the 会话 list, in desktop rail-folder order. In team mode the workers whose lead is on
 *  the screen (`listed`, by default the rows themselves) are left out — they are opened from the
 *  lead's chat — and the lead's row carries their running, waiting and unread state; a worker whose
 *  lead is not on the screen stays a row. */
export function buildSessionRows(
  sessions: SessionInfo[], now: number = Date.now(), lang: Lang = 'en', L: Vocab = en, team = false,
  listed: SessionInfo[] = sessions,
): MSessionRow[] {
  if (!team) return orderSessions(sessions).map((s) => toRow(s, now, lang, L));
  const { top, workers } = groupWorkers(listed, now);
  const shown = new Set(top.map((s) => s.sessionId));
  return orderSessions(sessions.filter((s) => shown.has(s.sessionId)))
    .map((s) => toLeadRow(s, workers.get(s.sessionId) ?? [], now, lang, L));
}
