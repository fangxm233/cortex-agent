//
// What the daemon knows about a lead's workers beyond their session records: the last report each
// one sent, its one-line brief, whether the user talked to it directly, and whether the lead has
// just handed it work that has not started yet. In memory only — a restart forgets the reports and
// the user-touched marks, and the brief is recovered from the worker's transcript. A report the
// restart kept from its lead is re-recorded when it is delivered after the restart (team-delivery).

import type { Session } from '@store/session-registry-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationHistory, type SessionHistory } from '@store/conversation-history-repo.js';
import { waitpointRepo, type Waitpoint } from '@store/waitpoint-repo.js';
import { ownsWaitpoint } from '@domain/waitpoints/view.js';
import { sessionState } from '@core/session-state.js';
import { conduitQueues } from './conduit-queue.js';
import { interactionRecords, type InteractionIndexEntry } from './interactions/interaction-records.js';

export type WorkerTurnStatus = 'completed' | 'failed' | 'stopped';

export interface WorkerReport {
  status: WorkerTurnStatus;
  /** The worker's full final reply for that turn. */
  text: string;
  at: number;
}

/** `waiting`: on a question or plan of its own. `external`: no turn running, but an open
 *  waitpoint will wake it. */
export type WorkerStatus = 'running' | 'idle' | 'waiting' | 'external' | 'error' | 'retired';

export interface WorkerView {
  name: string;
  sessionId: string;
  channel: string;
  status: WorkerStatus;
  /** Pending interaction ids, when `waiting`. */
  waitingOn: string[];
  /** Open waitpoints the worker armed (armed, or fired with the wake not yet delivered). */
  waitpoints: number;
  brief: string | null;
  lastReport: WorkerReport | null;
  userTouched: boolean;
  retired: boolean;
}

/** A dispatch counts as running until its turn opens, so back-to-back spawns respect the cap. */
const DISPATCH_PENDING_MS = 2 * 60 * 1000;
const BRIEF_MAX = 120;

const reports = new Map<string, WorkerReport>();
const briefs = new Map<string, string>();
const userTouched = new Set<string>();
const dispatchedAt = new Map<string, number>();
const historyLoaded = new Set<string>();
/** sessionId → worker name, learned whenever a worker is described. */
const workerNames = new Map<string, string>();
/** Request id of a forwarded question or plan → the worker that raised it. */
const requestWorkers = new Map<string, string>();
const REQUEST_WORKERS_MAX = 500;

export function briefOf(prompt: string): string {
  const line = prompt.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.length > BRIEF_MAX ? `${line.slice(0, BRIEF_MAX - 1)}…` : line;
}

/** The lead handed this worker work. Clears the user-touched mark: the user's direct turns are
 *  flagged until the lead next engages the worker, which is when the lead has seen the roster. */
export function noteDispatch(workerId: string, prompt: string | null, now = Date.now()): void {
  dispatchedAt.set(workerId, now);
  userTouched.delete(workerId);
  if (prompt && !briefs.has(workerId)) briefs.set(workerId, briefOf(prompt));
}

export function clearDispatch(workerId: string): void {
  dispatchedAt.delete(workerId);
}

export function markUserTouched(workerId: string): void {
  userTouched.add(workerId);
}

/** Keeps the newest: a report delivered late (after a restart) does not replace a later one. */
export function recordWorkerReport(workerId: string, report: WorkerReport): void {
  const current = reports.get(workerId);
  if (current && current.at > report.at) return;
  reports.set(workerId, report);
}

/** workerId → the run whose turn the worker marked routine (null when no run was registered). */
const routineMarks = new Map<string, string | null>();

/** The worker called `mark_routine`: its current turn's final reply is a routine update. */
export function markTurnRoutine(workerId: string, executionId: string | null): void {
  routineMarks.set(workerId, executionId);
}

/** Whether the turn of this run was marked routine. Consumes the mark either way, so a mark left by a
 *  turn that never reported (an auto-resumed rate limit) cannot leak into a later run. */
export function takeRoutineMark(workerId: string, executionId: string | null): boolean {
  if (!routineMarks.has(workerId)) return false;
  const marked = routineMarks.get(workerId)!;
  routineMarks.delete(workerId);
  return marked === null || executionId === null || marked === executionId;
}

/** A worker's question or plan was forwarded to its lead under this request id. */
export function noteWorkerRequest(requestId: string, workerName: string): void {
  requestWorkers.delete(requestId);
  requestWorkers.set(requestId, workerName);
  if (requestWorkers.size > REQUEST_WORKERS_MAX) requestWorkers.delete(requestWorkers.keys().next().value!);
}

/** The worker behind a request id the lead answers, or null when it is not known. Falls back to
 *  the interaction's session for a request forwarded before a restart. */
export function workerNameForRequest(
  requestId: string,
  sessionOfRequest: (id: string) => string | null = (id) => interactionRecords.get(id)?.sessionId ?? null,
): string | null {
  const known = requestWorkers.get(requestId);
  if (known) return known;
  const sessionId = sessionOfRequest(requestId);
  return sessionId ? workerNames.get(sessionId) ?? null : null;
}

export function _resetTeamState(): void {
  reports.clear(); briefs.clear(); userTouched.clear(); dispatchedAt.clear(); historyLoaded.clear();
  workerNames.clear(); requestWorkers.clear(); routineMarks.clear();
}

/** A waitpoint that will still wake its owner: armed, or fired with the wake not yet delivered. */
export function isOpenWaitpoint(wp: Waitpoint): boolean {
  return wp.state === 'armed' || wp.delivery.pending;
}

/** How many open waitpoints this session owns (the ownership rule `SessionInfo.waitingOn` uses). */
export async function countOpenWaitpoints(sessionId: string, channel: string | null): Promise<number> {
  const all = await waitpointRepo.list();
  return all.filter(wp => isOpenWaitpoint(wp) && ownsWaitpoint(wp, sessionId, channel)).length;
}

export interface WorkerViewDeps {
  isRunning: (sessionId: string) => boolean;
  isQueued: (channel: string) => boolean;
  pendingInteractions: (channel: string) => Pick<InteractionIndexEntry, 'id'>[];
  openWaitpoints: (sessionId: string, channel: string) => Promise<number>;
  history: (sessionId: string) => Promise<SessionHistory | null>;
  now: () => number;
}

const defaultViewDeps: WorkerViewDeps = {
  isRunning: (id) => sessionState(id).running,
  isQueued: (channel) => conduitQueues.has(channel),
  pendingInteractions: (channel) => interactionRecords.getPendingByChannel(channel),
  openWaitpoints: (id, channel) => countOpenWaitpoints(id, channel),
  history: (id) => conversationHistory.getHistory(id, { includeToolDebug: false }),
  now: () => Date.now(),
};

/** After a restart: the brief from the session record (or, for a worker spawned before the record
 *  carried one, the first lead message), the last report from the last reply. */
async function recoverFromHistory(worker: Session, deps: WorkerViewDeps): Promise<void> {
  if (historyLoaded.has(worker.sessionId)) return;
  historyLoaded.add(worker.sessionId);
  if (worker.workerBrief && !briefs.has(worker.sessionId)) briefs.set(worker.sessionId, worker.workerBrief);
  if (briefs.has(worker.sessionId) && reports.has(worker.sessionId)) return;
  let history: SessionHistory | null = null;
  try { history = await deps.history(worker.sessionId); } catch { return; }
  const events = history?.events ?? [];
  if (!briefs.has(worker.sessionId)) {
    const first = events.find(e => e.type === 'user' && e.systemOrigin === 'team-lead');
    if (first?.text) briefs.set(worker.sessionId, briefOf(first.text));
  }
  if (!reports.has(worker.sessionId)) {
    const last = [...events].reverse()
      .find(e => e.type === 'assistant' && !e.subagentId && !e.noticeLevel && e.text);
    if (last?.text) {
      reports.set(worker.sessionId, { status: 'completed', text: last.text, at: Date.parse(last.ts) || 0 });
    }
  }
}

/** `running` overrides the live busy test: a report written as a turn ends knows better than the
 *  run registry, which still holds the ending turn. */
export async function describeWorker(
  worker: Session, deps: WorkerViewDeps = defaultViewDeps, opts: { running?: boolean } = {},
): Promise<WorkerView> {
  await recoverFromHistory(worker, deps);
  const retired = worker.workerRetiredAt != null;
  const dispatched = dispatchedAt.get(worker.sessionId);
  const running = opts.running ?? (deps.isRunning(worker.sessionId) || deps.isQueued(worker.channel)
    || (dispatched !== undefined && deps.now() - dispatched < DISPATCH_PENDING_MS));
  const waitingOn = deps.pendingInteractions(worker.channel).map(e => e.id);
  const waitpoints = await deps.openWaitpoints(worker.sessionId, worker.channel);
  const lastReport = reports.get(worker.sessionId) ?? null;
  const status: WorkerStatus = waitingOn.length > 0 ? 'waiting'
    : running ? 'running'
      : waitpoints > 0 ? 'external'
        : retired ? 'retired'
          : lastReport?.status === 'failed' ? 'error'
            : 'idle';
  const name = worker.workerName ?? worker.name;
  workerNames.set(worker.sessionId, name);
  return {
    name,
    sessionId: worker.sessionId,
    channel: worker.channel,
    status,
    waitingOn,
    waitpoints,
    brief: briefs.get(worker.sessionId) ?? null,
    lastReport,
    userTouched: userTouched.has(worker.sessionId),
    retired,
  };
}

/** Every worker of a lead, active first (most recent first within each group). */
export async function describeTeam(
  leadSessionId: string,
  deps: WorkerViewDeps = defaultViewDeps,
  listWorkers: (id: string) => Promise<Session[]> = (id) => sessionStore.listWorkers(id),
): Promise<WorkerView[]> {
  const views = await Promise.all((await listWorkers(leadSessionId)).map(w => describeWorker(w, deps)));
  return [...views.filter(v => !v.retired), ...views.filter(v => v.retired)];
}

export function isWorkerBusy(view: WorkerView): boolean {
  return view.status === 'running' || view.status === 'waiting';
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function statusLabel(view: WorkerView): string {
  if (view.status === 'waiting') return `waiting(${view.waitingOn.join(', ')})`;
  if (view.status === 'external') {
    return `waiting on external (${view.waitpoints} waitpoint${view.waitpoints === 1 ? '' : 's'})`;
  }
  return view.status;
}

/** One compact roster line: name · status · last report · user-touched — brief. */
export function rosterLine(view: WorkerView, now = Date.now()): string {
  const parts = [view.name, statusLabel(view)];
  if (view.lastReport) parts.push(`last report ${formatAge(now - view.lastReport.at)}`);
  else parts.push('no report yet');
  if (view.userTouched) parts.push('user talked to it directly');
  return `- ${parts.join(' · ')}${view.brief ? ` — ${view.brief}` : ''}`;
}
