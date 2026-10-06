import type { SessionInfo, SessionsPendingInteraction } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';
import { formatSpan, type TimeLang } from '@/i18n/time-format';
import { isRetiredWorker } from './worker-groups';

// A lead's team as its chat shows it: one summary (the desktop header capsule, the mobile row) that
// opens one list (a popover on desktop, a sheet on mobile). Workers that need attention come first.

/** The rail's dot language as a state: blocked on you, running, blocked on the lead, waiting on a
 *  machine, idle. A worker blocked on its lead is mid-turn but not progressing, so it is not running. */
export type WorkerState = 'you' | 'running' | 'lead' | 'waiting' | 'idle';

export function workerState(s: SessionInfo): WorkerState {
  if (s.awaitingInput) return 'you';
  if ((s.waitingOnLead ?? 0) > 0) return 'lead';
  if (s.running) return 'running';
  if ((s.waitingOn ?? 0) > 0) return 'waiting';
  return 'idle';
}

const ATTENTION: Record<WorkerState, number> = { you: 0, running: 1, lead: 2, waiting: 2, idle: 3 };

export function workerTitle(s: SessionInfo): string {
  return s.workerName || s.label || s.name || s.sessionId;
}

export interface TeamRoster {
  /** Needs you → running → waiting → idle; the list's own order (unread, then recency) within each. */
  active: SessionInfo[];
  retired: SessionInfo[];
}

export function teamRoster(workers: SessionInfo[]): TeamRoster {
  const active = workers.filter((w) => !isRetiredWorker(w));
  return {
    active: [...active].sort((a, b) => ATTENTION[workerState(a)] - ATTENTION[workerState(b)]),
    retired: workers.filter(isRetiredWorker),
  };
}

export interface TeamSummary {
  workers: string;
  running: string | null;
  needsYou: string | null;
}

/** "8 workers · 5 running · 1 needs you", in parts so the needs-you count can carry its own tone. */
export function teamSummary(active: SessionInfo[], L: Vocab): TeamSummary {
  const states = active.map(workerState);
  const running = states.filter((s) => s === 'running').length;
  const you = states.filter((s) => s === 'you').length;
  return {
    workers: fmt(active.length === 1 ? L.wbTeamCountOne : L.wbTeamCountMany, { n: active.length }),
    running: running > 0 ? fmt(L.wbTeamRunningCount, { n: running }) : null,
    needsYou: you > 0 ? fmt(L.wbTeamNeedsYouCount, { n: you }) : null,
  };
}

export function teamSummaryText(active: SessionInfo[], L: Vocab): string {
  const s = teamSummary(active, L);
  return [s.workers, s.running, s.needsYou].filter(Boolean).join(' · ');
}

/** The row's status: what the worker is doing and, where the record says, for how long. The
 *  registry stamps `lastUsedAt` when a turn opens and again when it ends, so it is the running
 *  turn's start and the idle worker's last activity. A background hold has no start of its own. */
export function workerStatusText(s: SessionInfo, now: number, L: Vocab, lang: TimeLang): string {
  const at = Date.parse(s.lastUsedAt);
  const span = Number.isNaN(at) ? null : formatSpan(now - at, lang);
  switch (workerState(s)) {
    case 'you': return L.wbTeamStatusYou;
    case 'running': return span && !s.backgroundRunning ? fmt(L.wbTeamStatusRunningFor, { span }) : L.wbTeamStatusRunning;
    case 'lead': return L.wbTeamStatusLead;
    case 'waiting': return L.wbTeamStatusWaiting;
    case 'idle': return span ? fmt(L.wbTeamStatusIdleFor, { span }) : L.wbTeamStatusIdle;
  }
}

/** The row's second line: the question it is blocked on, its current task while it runs, the
 *  lead's brief, then a name the user gave it. Null when none of these is known. */
export function workerDoing(s: SessionInfo, question: string | null): string | null {
  if (question) return question;
  if (workerState(s) === 'running' && s.todos?.activeLabel) return s.todos.activeLabel;
  if (s.workerBrief) return s.workerBrief;
  return s.label && s.label !== workerTitle(s) ? s.label : null;
}

/** The pending question (or plan title) a worker that needs you is blocked on. */
export function pendingQuestionText(pending: SessionsPendingInteraction | null | undefined, L: Vocab): string | null {
  const question = pending?.askUser?.questions[0]?.question?.trim();
  if (question) return fmt(L.wbTeamAsks, { text: question });
  const plan = pending?.plan?.planContent.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean);
  return plan ? fmt(L.wbTeamPlan, { text: plan }) : null;
}
