//
// What the daemon knows about a lead's workers beyond their session records: the last report each
// one sent, its one-line brief, whether the user talked to it directly, and whether the lead has
// just handed it work that has not started yet. In memory only — a restart forgets the reports and
// the user-touched marks, and the brief is recovered from the worker's transcript. A report the
// restart kept from its lead is re-recorded when it is delivered after the restart (team-delivery).

import type { Session } from '@store/session-registry-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationHistory, type SessionHistory } from '@store/conversation-history-repo.js';
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

export type WorkerStatus = 'running' | 'idle' | 'waiting' | 'error' | 'retired';

export interface WorkerView {
  name: string;
  sessionId: string;
  channel: string;
  status: WorkerStatus;
  /** Pending interaction ids, when `waiting`. */
  waitingOn: string[];
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

export function _resetTeamState(): void {
  reports.clear(); briefs.clear(); userTouched.clear(); dispatchedAt.clear(); historyLoaded.clear();
}

export interface WorkerViewDeps {
  isRunning: (sessionId: string) => boolean;
  isQueued: (channel: string) => boolean;
  pendingInteractions: (channel: string) => Pick<InteractionIndexEntry, 'id'>[];
  history: (sessionId: string) => Promise<SessionHistory | null>;
  now: () => number;
}

const defaultViewDeps: WorkerViewDeps = {
  isRunning: (id) => sessionState(id).running,
  isQueued: (channel) => conduitQueues.has(channel),
  pendingInteractions: (channel) => interactionRecords.getPendingByChannel(channel),
  history: (id) => conversationHistory.getHistory(id, { includeToolDebug: false }),
  now: () => Date.now(),
};

/** After a restart: the brief from the first lead message, the last report from the last reply. */
async function recoverFromHistory(worker: Session, deps: WorkerViewDeps): Promise<void> {
  if (historyLoaded.has(worker.sessionId)) return;
  historyLoaded.add(worker.sessionId);
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

export async function describeWorker(worker: Session, deps: WorkerViewDeps = defaultViewDeps): Promise<WorkerView> {
  await recoverFromHistory(worker, deps);
  const retired = worker.workerRetiredAt != null;
  const dispatched = dispatchedAt.get(worker.sessionId);
  const running = deps.isRunning(worker.sessionId) || deps.isQueued(worker.channel)
    || (dispatched !== undefined && deps.now() - dispatched < DISPATCH_PENDING_MS);
  const waitingOn = deps.pendingInteractions(worker.channel).map(e => e.id);
  const lastReport = reports.get(worker.sessionId) ?? null;
  const status: WorkerStatus = waitingOn.length > 0 ? 'waiting'
    : running ? 'running'
      : retired ? 'retired'
        : lastReport?.status === 'failed' ? 'error'
          : 'idle';
  return {
    name: worker.workerName ?? worker.name,
    sessionId: worker.sessionId,
    channel: worker.channel,
    status,
    waitingOn,
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
  return view.status === 'waiting' ? `waiting(${view.waitingOn.join(', ')})` : view.status;
}

/** One compact roster line: name · status · last report · user-touched — brief. */
export function rosterLine(view: WorkerView, now = Date.now()): string {
  const parts = [view.name, statusLabel(view)];
  if (view.lastReport) parts.push(`last report ${formatAge(now - view.lastReport.at)}`);
  else parts.push('no report yet');
  if (view.userTouched) parts.push('user talked to it directly');
  return `- ${parts.join(' · ')}${view.brief ? ` — ${view.brief}` : ''}`;
}
