// Pure view-model for the 1a 会话列表 screen: project-local Stars plus the existing direct
// and scheduled lists. Session rows keep desktop rail order (unread first, then most recent)
// and carry their own relative time, without day buckets.
import type { ScheduleInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { partitionStarredSessions } from '@/features/session/list/starred-sessions';
import { buildScheduleRows } from '@/features/session/list/schedule-rail';
import { orderSessions } from '@/features/session/list/session-groups';
import { groupWorkers, isRetiredWorker } from '@/features/team/worker-groups';
import { sessionRollup, workerRollup, type WorkerRollup } from '@/features/team/worker-rollup';
import { relTime } from '@/mobile/ui/format';

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

const STATUS_TEXT: Record<Lang, {
  awaiting: string;
  background: string;
  running: (turns: number | null) => string;
  waiting: (n: number) => string;
  waitingLead: string;
  idle: string;
  workerAwaiting: string;
  workersRunning: (n: number) => string;
  workersWaiting: (n: number) => string;
}> = {
  en: {
    awaiting: 'Needs your input',
    background: 'Running in background',
    running: (turns) => (turns != null ? `Running · ${turns} turns` : 'Running'),
    waiting: (n) => `Waiting on ${n} signal${n === 1 ? '' : 's'}`,
    waitingLead: 'Waiting on lead',
    idle: 'Idle',
    workerAwaiting: 'A worker needs your input',
    workersRunning: (n) => `${n} worker${n === 1 ? '' : 's'} running`,
    workersWaiting: (n) => `${n} worker${n === 1 ? '' : 's'} waiting`,
  },
  zh: {
    awaiting: '等待操作',
    background: '后台运行',
    running: (turns) => (turns != null ? `运行中 · ${turns} 轮` : '运行中'),
    waiting: (n) => `等 ${n} 个信号`,
    waitingLead: '等待主会话',
    idle: '空闲',
    workerAwaiting: 'Worker 等待操作',
    workersRunning: (n) => `${n} 个 worker 运行中`,
    workersWaiting: (n) => `${n} 个 worker 等待中`,
  },
};

/**
 * The status-line for a session row. Awaiting user action (pending ask-user / plan approval) wins
 * even while a turn or a background task is live — it is the ONLY amber「需要你」state. Background-held
 * (foreground turn done, background task still running) and running share the run-blue dot; an idle
 * session still expecting a waitpoint signal gets a hollow ring. Per-session cost has no DTO source
 * (SessionInfo carries none), so it is deliberately omitted.
 */
export function sessionStatusLine(s: SessionInfo, lang: Lang = 'en'): { kind: 'running' | 'background' | 'awaiting' | 'waiting-external' | 'idle'; text: string } {
  const t = STATUS_TEXT[lang];
  if (s.awaitingInput) return { kind: 'awaiting', text: t.awaiting };
  if ((s.waitingOnLead ?? 0) > 0) return { kind: 'waiting-external', text: t.waitingLead };
  if (s.running) {
    return s.backgroundRunning
      ? { kind: 'background', text: t.background }
      : { kind: 'running', text: t.running(s.numTurns) };
  }
  if ((s.waitingOn ?? 0) > 0) return { kind: 'waiting-external', text: t.waiting(s.waitingOn ?? 0) };
  return { kind: 'idle', text: t.idle };
}

function toRow(s: SessionInfo, now: number, lang: Lang): MSessionRow {
  return {
    id: s.sessionId,
    title: s.label || s.name || s.sessionId,
    time: relTime(s.lastUsedAt || s.createdAt, now, lang),
    unread: s.unread,
    status: sessionStatusLine(s, lang),
  };
}

/**
 * A lead's status line with its workers rolled up, in the dot's precedence: anything blocked on the
 * user first, then the lead's own run, then its workers' runs, then waits. The lead's own line wins
 * within each tier, since it says more.
 */
function leadStatusLine(own: MSessionStatus, workers: WorkerRollup[], lang: Lang): MSessionStatus {
  const t = STATUS_TEXT[lang];
  const up = workerRollup(workers);
  if (own.kind === 'awaiting') return own;
  if (up.awaitingInput) return { kind: 'awaiting', text: t.workerAwaiting };
  if (own.kind === 'running' || own.kind === 'background') return own;
  if (up.running) return { kind: 'running', text: t.workersRunning(workers.filter((w) => w.running).length) };
  if (own.kind === 'waiting-external') return own;
  if (up.waitingOn) return { kind: 'waiting-external', text: t.workersWaiting(workers.filter((w) => w.waitingOn).length) };
  return own;
}

function toLeadRow(s: SessionInfo, workers: SessionInfo[], now: number, lang: Lang): MSessionRow {
  const row = toRow(s, now, lang);
  // The workers the lead's chat offers (its worker strip leaves retired ones out): whatever the
  // row signals, the user can reach from there.
  const team = workers.filter((w) => !isRetiredWorker(w)).map(sessionRollup);
  if (team.length === 0) return row;
  return {
    ...row,
    unread: row.unread || workerRollup(team).unread,
    status: leadStatusLine(row.status, team, lang),
  };
}

/** Scope before partitioning: Stars never aggregate sessions from different projects. */
export function buildProjectSessionList(
  projectId: string | null, direct: SessionInfo[], scheduled: SessionInfo[],
  schedules: ScheduleInfo[], now: number = Date.now(), lang: Lang = 'en', team = false,
) {
  // While project selection is unresolved, retain the existing flat list, not a global Stars group.
  if (projectId === null) return {
    rows: buildSessionRows(direct, now, lang, team), starredRows: [],
    scheduleRows: buildScheduleRows(schedules, scheduled),
  };
  const own = (session: SessionInfo) => session.projectId === projectId;
  const partition = partitionStarredSessions(direct.filter(own), scheduled.filter(own));
  // Workers nest under their lead across both lists, so starring a lead does not spill its
  // workers into the plain list.
  const listed = [...partition.starred, ...partition.direct];
  return {
    rows: buildSessionRows(partition.direct, now, lang, team, listed),
    starredRows: buildSessionRows(partition.starred, now, lang, team, listed),
    scheduleRows: buildScheduleRows(schedules.filter(s => s.projectId === projectId), partition.scheduled),
  };
}

/** Rows for the 会话 list, in desktop rail-folder order. In team mode the workers whose lead is on
 *  the screen (`listed`, by default the rows themselves) are left out — they are opened from the
 *  lead's chat — and the lead's row carries their running, waiting and unread state; a worker whose
 *  lead is not on the screen stays a row. */
export function buildSessionRows(
  sessions: SessionInfo[], now: number = Date.now(), lang: Lang = 'en', team = false,
  listed: SessionInfo[] = sessions,
): MSessionRow[] {
  if (!team) return orderSessions(sessions).map((s) => toRow(s, now, lang));
  const { top, workers } = groupWorkers(listed);
  const shown = new Set(top.map((s) => s.sessionId));
  return orderSessions(sessions.filter((s) => shown.has(s.sessionId)))
    .map((s) => toLeadRow(s, workers.get(s.sessionId) ?? [], now, lang));
}
