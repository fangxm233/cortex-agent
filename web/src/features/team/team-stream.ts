import type { SessionInfo } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';
import {
  messageTimeLabel, openRequest, updateCounts, type WorkerThread, type WorkerUpdate,
} from '@/features/session/transcript/transcript-vm';
import { isRetiredWorker } from './worker-groups';
import { workerState } from './worker-roster';

// What a lead's chat needs from its live team to draw the transcript's team rows: which session a
// worker name stands for, who the lead is still waiting on, and the card's summary text.

/** The session behind a worker name (or id). A name a retired worker freed may be in use again, so
 *  the active holder wins. */
export function findWorker(workers: SessionInfo[], name: string | null, sessionId?: string | null): SessionInfo | null {
  if (sessionId) {
    const byId = workers.find((w) => w.sessionId === sessionId);
    if (byId) return byId;
  }
  if (!name) return null;
  const named = workers.filter((w) => w.workerName === name);
  return named.find((w) => !isRetiredWorker(w)) ?? named[0] ?? null;
}

const MIN_BRIEF = 12;

function normalized(text: string): string {
  return text.replace(/…$/, '').replace(/\s+/g, ' ').trim();
}

/** The worker a spawn row started, when the row does not name it: older history keeps only the
 *  prompt, and the worker record keeps that prompt's first line. */
export function spawnedWorker(workers: SessionInfo[], prompt: string | null): SessionInfo | null {
  if (!prompt) return null;
  const p = normalized(prompt);
  if (p.length < MIN_BRIEF) return null;
  return workers.find((w) => {
    const brief = w.workerBrief ? normalized(w.workerBrief) : '';
    return brief.length >= MIN_BRIEF && (p.startsWith(brief) || brief.startsWith(p));
  }) ?? null;
}

/** Workers the lead is waiting to hear from: active ones still working, on their own or on a
 *  machine. One blocked on the lead or on the user is waiting for someone else, not the reverse. */
export function waitedWorkers(workers: SessionInfo[]): SessionInfo[] {
  return workers.filter((w) => {
    if (isRetiredWorker(w)) return false;
    const state = workerState(w);
    return state === 'running' || state === 'waiting';
  });
}

/** `10:05 – 11:20`, or one time when the updates share it. */
export function updateTimeRange(updates: WorkerUpdate[], now: Date = new Date()): string | null {
  const first = messageTimeLabel(updates[0]?.ts ?? undefined, now);
  const last = messageTimeLabel(updates.at(-1)?.ts ?? undefined, now);
  if (!first || !last) return first ?? last;
  return first === last ? first : `${first} – ${last}`;
}

/** The state of the thread's last question or plan, as the card's summary names it. */
export function requestState(thread: WorkerThread, L: Vocab, worker: SessionInfo | null = null): string | null {
  const request = [...thread.updates].reverse().find((u) => u.kind === 'question' || u.kind === 'plan');
  if (!request) return null;
  if (!request.answer && !waitingRequest(thread, worker)) return null;
  if (request.kind === 'plan') {
    if (!request.answer) return L.wbTeamPlanAwaiting;
    return request.answer.approved === false ? L.wbTeamPlanRejected : L.wbTeamPlanApproved;
  }
  return request.answer ? L.wbTeamQuestionAnswered : L.wbTeamQuestionOpen;
}

/** "Plan approved · 3 reports · 5 routine" — the right side of a one-worker card. */
export function threadSummary(thread: WorkerThread, L: Vocab, worker: SessionInfo | null = null): string {
  const { reports, routine } = updateCounts(thread.updates);
  return [
    requestState(thread, L, worker),
    reports > 0 ? (reports === 1 ? L.wbTeamReportsOne : fmt(L.wbTeamReportsMany, { n: reports })) : null,
    routine > 0 ? (routine === 1 ? L.wbTeamRoutineOne : fmt(L.wbTeamRoutineMany, { n: routine })) : null,
  ].filter(Boolean).join(' · ');
}

/** The request a worker is blocked on in its latest card, which turns its row amber. An older card
 *  never does: whatever it asked was settled one way or another before the worker spoke again. */
export function waitingRequest(thread: WorkerThread, worker: SessionInfo | null): WorkerUpdate | null {
  if (!thread.latest || (worker && (isRetiredWorker(worker) || !worker.awaitingInput))) return null;
  return openRequest(thread);
}
