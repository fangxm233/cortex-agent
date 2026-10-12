//
// Worker → lead traffic in team mode. Delivery and waking are kept apart: nothing a worker says is
// lost, but only what needs the lead wakes it.
//
// - A worker turn's final reply is a REPORT by default: delivered to the lead at once, folding into
//   a running lead turn or waking an idle one. A failed or stopped turn always reports.
// - A turn the worker marked ROUTINE (`mark_routine`) wakes nobody: its reply becomes a
//   `worker-progress` row in the lead's chat and an unread item in the lead's inbox, which the lead
//   is given the next time it hears anything (team-inbox.ts).
// - Every question or plan a worker raises is forwarded to the lead as a notice it can answer with
//   `worker_answer`.
//
// Delivered reports and notices carry the lead's unread routine updates as a trailing section.
// Nothing here runs while team mode is off or once the lead is gone.
//
// A report must survive a daemon restart. The handoff keeps the process busy from the moment the
// worker's turn ends until the lead has the report admitted, so a restart waiting for idle cannot
// land in between; and a report refused because a restart is already pending is written to the
// outbox and delivered once the server is back (or once the hold lifts without a restart).

import type { EventBus } from '@events/index.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { sessionHolds } from '@core/session-holds.js';
import type { TeamWorkerRef } from '@core/team-action.js';
import type { Session } from '@store/session-registry-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { teamInboxRepo, type TeamInboxRepo } from '@store/team-inbox-repo.js';
import { teamOutboxRepo, type TeamOutboxEntry, type TeamOutboxRepo } from '@store/team-outbox-repo.js';
import { isRebuildHeld } from '@domain/system/rebuild-hold.js';
import { trackPendingTask } from './busy-tracker.js';
import { deliverToSession, type DeliverToSessionOptions } from './session-gateway.js';
import { publishSessionMessage } from './session-events.js';
import { HOLD_OWNER_BG_CONTINUATION } from './turn/background-hold.js';
import { inboxLine, takeUnreadDigest, withDigest } from './team-inbox.js';
import {
  clearDispatch, describeWorker, markUserTouched, noteWorkerRequest, recordWorkerReport, statusLabel,
  takeRoutineMark, type WorkerReport, type WorkerTurnStatus, type WorkerView,
} from './team-state.js';

const log = createLogger('team-delivery');

/** Reports past this are cut; the full text stays available through `worker_list(worker)`. */
export const REPORT_MAX_CHARS = 16_000;
export const PLAN_MAX_CHARS = 12_000;

/** How often a report held back by a pending restart is retried, in case the restart never comes
 *  (an aborted rebuild lifts the hold and leaves this process running). */
const OUTBOX_RETRY_MS = 30_000;

export interface TeamDeliveryDeps {
  enabled: () => boolean;
  getSession: (id: string) => Promise<Session | null>;
  /** Resolves once the message is admitted (queued or folded into a live turn), or refused. */
  deliver: (opts: Pick<DeliverToSessionOptions, 'channel' | 'text' | 'origin' | 'onRebuildHold'>) => Promise<void>;
  /** `running` overrides the live busy test (see `describeWorker`). */
  describe: (worker: Session, running?: boolean) => Promise<WorkerView>;
  now: () => number;
  /** Busy bracket (`trackPendingTask`): a deferred restart waits while it is held. */
  track: (delta: number) => void;
  outbox: Pick<TeamOutboxRepo, 'add' | 'remove' | 'list'>;
  /** Retry the outbox later; production arms one timer. */
  scheduleRetry: () => void;
  /** Whether the worker marked the turn of this run routine; consumes the mark. */
  takeRoutineMark: (workerId: string, executionId: string | null) => boolean;
  /** Background work (a backgrounded agent) still running for the worker after its turn. */
  backgroundWork: (workerId: string) => boolean;
  inbox: Pick<TeamInboxRepo, 'add' | 'take' | 'restore'>;
  /** True while the server refuses new turns ahead of a restart. */
  rebuildHeld: () => boolean;
  /** Record a worker's routine reply in its lead's history and publish it to the lead's chat. */
  recordProgress: (lead: Session, row: { text: string; worker: TeamWorkerRef; ts: string }) => Promise<void>;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

async function recordProgressRow(lead: Session, row: { text: string; worker: TeamWorkerRef; ts: string }): Promise<void> {
  await conversationHistory.appendWorkerProgress(lead.sessionId, row);
  publishSessionMessage({
    sessionId: lead.sessionId, channel: lead.channel, role: 'worker-progress',
    text: row.text, worker: row.worker, ts: row.ts,
  });
}

const defaultDeps: TeamDeliveryDeps = {
  enabled: () => getSettings().teamEnabled,
  getSession: (id) => sessionStore.getById(id),
  deliver: (opts) => deliverToSession(opts),
  describe: (worker, running) => describeWorker(worker, undefined, { running }),
  now: () => Date.now(),
  track: (delta) => trackPendingTask(delta),
  outbox: teamOutboxRepo,
  scheduleRetry: () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushTeamOutbox().catch((error) => log.warn(`team outbox retry failed: ${(error as Error).message}`));
    }, OUTBOX_RETRY_MS);
    retryTimer.unref?.();
  },
  takeRoutineMark: (workerId, executionId) => takeRoutineMark(workerId, executionId),
  backgroundWork: (workerId) => sessionHolds.hasHoldHandles(workerId, HOLD_OWNER_BG_CONTINUATION),
  inbox: teamInboxRepo,
  rebuildHeld: () => isRebuildHeld(),
  recordProgress: recordProgressRow,
};

/** Hold the process busy until `work` settles; the +1 is taken before `work` starts. */
async function busyWhile<T>(deps: TeamDeliveryDeps, work: () => Promise<T>): Promise<T> {
  deps.track(+1);
  try {
    return await work();
  } finally {
    deps.track(-1);
  }
}

/** The worker and its lead, or null when this session is not a worker the lead can still hear. */
async function workerAndLead(
  sessionId: string, deps: TeamDeliveryDeps,
): Promise<{ worker: Session; lead: Session } | null> {
  if (!deps.enabled()) return null;
  const worker = await deps.getSession(sessionId);
  if (!worker?.teamLeadId) return null;
  const lead = await deps.getSession(worker.teamLeadId);
  return lead ? { worker, lead } : null;
}

/** The status line every report and notice carries: a message injected into a running lead turn
 *  skips prompt assembly, so the roster line has to travel with it. */
function statusLine(view: WorkerView): string {
  return `status ${statusLabel(view)}`;
}

function cap(text: string, max: number, note: string): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[${note}]` : text;
}

export function buildWorkerReport(name: string, status: WorkerTurnStatus, view: WorkerView, finalOutput: string): string {
  const body = finalOutput.trim()
    ? cap(finalOutput, REPORT_MAX_CHARS, `Truncated. Call worker_list("${name}") for the full report.`)
    : status === 'stopped' ? '(stopped before a final reply)' : '(no final reply)';
  return `[Worker ${name} · ${status}]\n${statusLine(view)}\n\n${body}`;
}

/** Deliver one report to its lead, with the lead's unread routine updates appended. True when
 *  admitted; false when a rebuild hold refused it, in which case `keep` has run (the report is in
 *  the outbox) and the updates are unread again. */
async function deliverReport(
  worker: Session, lead: Session, report: Omit<TeamOutboxEntry, 'id' | 'leadId' | 'workerId'>,
  deps: TeamDeliveryDeps, keep: () => Promise<void>, running?: boolean,
): Promise<boolean> {
  const view = await deps.describe(worker, running);
  const digest = await takeUnreadDigest(lead.sessionId, deps.inbox, deps.now());
  let held = false;
  await deps.deliver({
    channel: lead.channel, origin: 'worker-result',
    text: withDigest(buildWorkerReport(worker.workerName ?? worker.name, report.status, view, report.text), digest.text),
    onRebuildHold: async () => { await keep(); held = true; },
  });
  if (held) await digest.restore();
  return !held;
}

async function deliverOrKeep(
  worker: Session, lead: Session, report: WorkerReport, deps: TeamDeliveryDeps,
): Promise<void> {
  // The ending turn still counts as running here; only a backgrounded agent outlives it.
  await deliverReport(worker, lead, report, deps, async () => {
    await deps.outbox.add({
      id: `${worker.sessionId}:${report.at}`, leadId: lead.sessionId, workerId: worker.sessionId, ...report,
    });
    deps.scheduleRetry();
    log.info(`worker ${worker.sessionId} report kept for lead ${lead.sessionId} until the restart is over`);
  }, deps.backgroundWork(worker.sessionId));
}

/** A routine reply: a progress row in the lead's chat and an unread item in its inbox. No wake. */
async function recordRoutine(worker: Session, lead: Session, report: WorkerReport, deps: TeamDeliveryDeps): Promise<void> {
  const text = report.text.trim();
  if (!text) return;
  const name = worker.workerName ?? worker.name;
  await deps.recordProgress(lead, {
    text: cap(text, REPORT_MAX_CHARS, 'Truncated.'),
    worker: { name, sessionId: worker.sessionId },
    ts: new Date(report.at).toISOString(),
  });
  await deps.inbox.add(lead.sessionId, { workerId: worker.sessionId, name }, { at: report.at, text: inboxLine(text) });
}

/**
 * Handle a finished worker turn. Called synchronously from the turn's ending, before the turn
 * releases its own busy count, so the bracket taken here leaves no idle moment between the worker's
 * turn and the lead's admission for a deferred restart to land in.
 */
export function onWorkerTurnCompleted(
  event: { sessionId: string; status: WorkerTurnStatus; finalOutput: string; trigger: string; executionId?: string | null },
  deps: TeamDeliveryDeps = defaultDeps,
): Promise<void> {
  if (!deps.enabled()) return Promise.resolve();
  return busyWhile(deps, async () => {
    const pair = await workerAndLead(event.sessionId, deps);
    if (!pair) return;
    const { worker, lead } = pair;
    clearDispatch(worker.sessionId);
    const routine = deps.takeRoutineMark(worker.sessionId, event.executionId ?? null);
    // A turn the user started by typing in the worker's own chat is theirs, not the lead's: it is
    // not reported, only flagged on the roster.
    if (event.trigger === 'web-user') {
      markUserTouched(worker.sessionId);
      return;
    }
    const report: WorkerReport = { status: event.status, text: event.finalOutput, at: deps.now() };
    recordWorkerReport(worker.sessionId, report);
    if (routine && event.status === 'completed') {
      await recordRoutine(worker, lead, report, deps);
      return;
    }
    await deliverOrKeep(worker, lead, report, deps);
  });
}

let flushing: Promise<number> | null = null;

/**
 * Deliver the reports a restart kept from their leads, oldest first. Run at boot and retried while
 * a hold keeps refusing them; an entry leaves the outbox only once its lead has it admitted. Reports
 * whose worker or lead is gone, or that arrive with team mode off, are dropped. Returns how many
 * were delivered.
 */
export function flushTeamOutbox(deps: TeamDeliveryDeps = defaultDeps): Promise<number> {
  flushing ??= runOutboxFlush(deps).finally(() => { flushing = null; });
  return flushing;
}

async function runOutboxFlush(deps: TeamDeliveryDeps): Promise<number> {
  const entries = await deps.outbox.list();
  if (entries.length === 0) return 0;
  if (!deps.enabled()) {
    await deps.outbox.remove(entries.map(e => e.id));
    log.info(`dropped ${entries.length} kept worker report(s): team mode is off`);
    return 0;
  }
  return busyWhile(deps, async () => {
    let delivered = 0;
    for (const entry of entries) {
      const pair = await workerAndLead(entry.workerId, deps);
      if (!pair || pair.lead.sessionId !== entry.leadId) {
        await deps.outbox.remove([entry.id]);
        continue;
      }
      // worker_list shows the report the lead is about to read, not one recovered from the transcript.
      recordWorkerReport(entry.workerId, { status: entry.status, text: entry.text, at: entry.at });
      const admitted = await deliverReport(pair.worker, pair.lead, entry, deps, async () => {});
      if (!admitted) {
        deps.scheduleRetry();
        break;
      }
      await deps.outbox.remove([entry.id]);
      delivered += 1;
    }
    return delivered;
  });
}

export interface WorkerRequest {
  requestId: string;
  sessionId: string;
  kind: 'ask-user' | 'plan-approval';
  blocking: boolean;
  questions?: Array<{ question: string; header?: string; options?: Array<string | { label?: string }>; multiSelect?: boolean }>;
  planContent?: string;
  planFilePath?: string | null;
}

function optionLabel(option: string | { label?: string }): string {
  return typeof option === 'string' ? option : option?.label ?? '';
}

export function buildWorkerQuestionNotice(name: string, request: WorkerRequest, view: WorkerView, commission: boolean): string {
  const what = request.kind === 'ask-user' ? 'question' : commission ? 'commission contract approval' : 'plan approval';
  const head = `[Worker ${name} · ${what} · request_id=${request.requestId} · ${request.blocking ? 'blocking' : 'non-blocking'}]`;
  const lines = [head, statusLine(view), ''];
  if (request.kind === 'ask-user') {
    (request.questions ?? []).forEach((q, i) => {
      lines.push(`Q${i + 1}: ${q.question}${q.multiSelect ? ' (multiple choice)' : ''}`);
      const options = (q.options ?? []).map(optionLabel).filter(Boolean);
      if (options.length > 0) lines.push(`   Options: ${options.join(' | ')}`);
    });
    lines.push('', `Answer with worker_answer(request_id="${request.requestId}", answers={"<question text>": "<answer>"}).`);
  } else {
    if (request.planFilePath) lines.push(`Plan file: ${request.planFilePath}`);
    lines.push(cap(request.planContent ?? '', PLAN_MAX_CHARS, 'Truncated. Read the plan file for the rest.'));
    lines.push('', `Approve or reject with worker_answer(request_id="${request.requestId}", approved=true|false, feedback="...").`);
  }
  lines.push('The user may also answer on the worker\'s own card; the first answer wins. '
    + 'If you are unsure what the user would want, ask them with cortex_ask_user first.');
  return lines.join('\n');
}

/** Forward a worker's question or plan to its lead. The worker's own card is created as usual. A
 *  notice refused by a rebuild hold is not kept: the question it carries does not survive the
 *  restart either. */
export async function notifyLeadOfWorkerRequest(
  request: WorkerRequest, deps: TeamDeliveryDeps = defaultDeps,
): Promise<boolean> {
  if (!deps.enabled()) return false;
  try {
    return await busyWhile(deps, async () => {
      const pair = await workerAndLead(request.sessionId, deps);
      if (!pair) return false;
      const { worker, lead } = pair;
      const name = worker.workerName ?? worker.name;
      noteWorkerRequest(request.requestId, name);
      const view = await deps.describe(worker);
      // A notice a rebuild hold would refuse carries no updates: they stay unread for the next one.
      const digest = deps.rebuildHeld()
        ? { text: '', restore: async () => {} }
        : await takeUnreadDigest(lead.sessionId, deps.inbox, deps.now());
      await deps.deliver({
        channel: lead.channel, origin: 'worker-question',
        text: withDigest(buildWorkerQuestionNotice(name, request, view, !!worker.commissionDraft), digest.text),
      });
      if (deps.rebuildHeld()) await digest.restore();
      return true;
    });
  } catch (error) {
    log.warn(`worker request ${request.requestId} not forwarded: ${(error as Error).message}`);
    return false;
  }
}

/** Install the report subscriber. Called once at boot. The bus calls it synchronously from the
 *  turn's ending, which is what lets the busy bracket close the gap before the turn's own release. */
export function installTeamDelivery(bus: EventBus, deps: TeamDeliveryDeps = defaultDeps): void {
  bus.subscribe('session.turn.completed', (event) => {
    void onWorkerTurnCompleted(event, deps).catch((error) => {
      log.warn(`worker report for ${event.sessionId} failed: ${(error as Error).message}`);
    });
  });
}
