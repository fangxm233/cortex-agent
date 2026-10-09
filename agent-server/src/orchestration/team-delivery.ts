//
// Worker → lead traffic in team mode. A worker's turn ending wakes its lead with a report only when
// the worker has SETTLED — nothing queued, no background work holding it, no open waitpoint, no
// question or plan pending — or when the turn failed or was stopped. A turn that ends while work is
// still pending is recorded in the lead's history as a `worker-progress` row instead (display only,
// it does not wake the lead) and its reply is owed: the next settle delivers the latest reply, once.
// A worker can also settle without a turn ending (a waitpoint cancelled from the UI, a hold that
// lapses); those paths are caught by re-checks on the worker's status and interaction events and by
// a slow sweep while a report is owed. Every question or plan a worker raises is forwarded to the
// lead as a notice it can answer with `worker_answer`. Reports and notices arrive as ordinary
// deliveries, so they fold into a running lead turn or wake an idle one. Nothing here runs while
// team mode is off or once the lead is gone.
//
// A report must survive a daemon restart. The handoff keeps the process busy from the moment the
// worker's turn ends until the lead has the report admitted, so a restart waiting for idle cannot
// land in between; and a report refused because a restart is already pending is written to the
// outbox and delivered once the server is back (or once the hold lifts without a restart).

import type { EventBus } from '@events/index.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { sessionState } from '@core/session-state.js';
import { sessionHolds } from '@core/session-holds.js';
import type { TeamWorkerRef } from '@core/team-action.js';
import type { Session } from '@store/session-registry-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { teamOutboxRepo, type TeamOutboxEntry, type TeamOutboxRepo } from '@store/team-outbox-repo.js';
import { trackPendingTask } from './busy-tracker.js';
import { conduitQueueDepth } from './conduit-queue.js';
import { interactionRecords } from './interactions/interaction-records.js';
import { deliverToSession, type DeliverToSessionOptions } from './session-gateway.js';
import { publishSessionMessage } from './session-events.js';
import { HOLD_OWNER_BG_CONTINUATION } from './turn/background-hold.js';
import {
  clearDispatch, countOpenWaitpoints, describeWorker, markUserTouched, noteWorkerRequest, recordWorkerReport,
  statusLabel, type WorkerReport, type WorkerTurnStatus, type WorkerView,
} from './team-state.js';

const log = createLogger('team-delivery');

/** Reports past this are cut; the full text stays available through `worker_list(worker)`. */
export const REPORT_MAX_CHARS = 16_000;
export const PLAN_MAX_CHARS = 12_000;

/** How often a report held back by a pending restart is retried, in case the restart never comes
 *  (an aborted rebuild lifts the hold and leaves this process running). */
const OUTBOX_RETRY_MS = 30_000;

/** A status or interaction change re-checks an owed report after this, so the ending turn's own
 *  report decision always goes first. */
const SETTLE_RECHECK_MS = 1_000;
/** The sweep that catches a worker settling with no event of its own (a waitpoint cancelled from
 *  the UI, a question that timed out). Runs only while a report is owed. */
const SETTLE_SWEEP_MS = 60_000;

/** What could still keep a worker busy, read at one instant. */
export interface WorkerActivity {
  /** A live execution, or a background hold's running status. */
  running: boolean;
  /** Entries on the worker's conduit queue, a turn running inside one included. */
  queueDepth: number;
  /** Background-hold owners still holding the session (`bg-continuation`, `agent-run:<id>`). */
  holdOwners: string[];
  /** Open waitpoints the worker armed. */
  waitpoints: number;
  /** Questions or plans it raised that are still pending. */
  interactions: number;
}

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
  activity: (worker: Session) => Promise<WorkerActivity>;
  /** Record a worker's interim reply in its lead's history and publish it to the lead's chat. */
  recordProgress: (lead: Session, row: { text: string; worker: TeamWorkerRef; ts: string }) => Promise<void>;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

async function readActivity(worker: Session): Promise<WorkerActivity> {
  return {
    running: sessionState(worker.sessionId).running,
    queueDepth: conduitQueueDepth(worker.channel),
    holdOwners: sessionHolds.holdOwners(worker.sessionId),
    waitpoints: await countOpenWaitpoints(worker.sessionId, worker.channel),
    interactions: interactionRecords.getPendingByChannel(worker.channel).length,
  };
}

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
  activity: readActivity,
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

/** Deliver one report to its lead. True when admitted; false when a rebuild hold refused it, in
 *  which case `keep` has run (the report is in the outbox). */
async function deliverReport(
  worker: Session, lead: Session, report: Omit<TeamOutboxEntry, 'id' | 'leadId' | 'workerId'>,
  deps: TeamDeliveryDeps, keep: () => Promise<void>, running?: boolean,
): Promise<boolean> {
  const view = await deps.describe(worker, running);
  let held = false;
  await deps.deliver({
    channel: lead.channel, origin: 'worker-result',
    text: buildWorkerReport(worker.workerName ?? worker.name, report.status, view, report.text),
    onRebuildHold: async () => { await keep(); held = true; },
  });
  return !held;
}

/** Latest reply of a worker that ended a turn while still busy; delivered on its next settle. */
const owed = new Map<string, WorkerReport>();
/** One report decision at a time per worker: a turn ending and a re-check never interleave. */
const chains = new Map<string, Promise<void>>();

export function _resetTeamDelivery(): void {
  owed.clear();
  chains.clear();
  for (const timer of recheckTimers.values()) clearTimeout(timer);
  recheckTimers.clear();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Whether a report is owed to this worker's lead (tests and the re-check triggers). */
export function hasOwedReport(workerId: string): boolean {
  return owed.has(workerId);
}

function serialized(workerId: string, work: () => Promise<void>): Promise<void> {
  const next = (chains.get(workerId) ?? Promise.resolve()).then(work, work);
  chains.set(workerId, next);
  void next.finally(() => { if (chains.get(workerId) === next) chains.delete(workerId); }).catch(() => {});
  return next;
}

/** Settled as of a turn's ending, the ending turn itself excluded: the queue slot it ran in (unless
 *  it ended from a hold's seal, which runs after that slot is released) and its own continuation
 *  hold, which seals right after it reports. */
export function settledAtTurnEnd(
  a: WorkerActivity, held: boolean,
): { settled: boolean; queued: boolean; workHeld: boolean } {
  const queued = a.queueDepth - (held ? 0 : 1) > 0;
  const workHeld = a.holdOwners.some(owner => owner !== HOLD_OWNER_BG_CONTINUATION);
  return { settled: !queued && !workHeld && a.waitpoints === 0 && a.interactions === 0, queued, workHeld };
}

/** Settled with no turn ending: nothing at all may be running, queued or held. */
export function settledNow(a: WorkerActivity): boolean {
  return !a.running && a.queueDepth === 0 && a.holdOwners.length === 0 && a.waitpoints === 0 && a.interactions === 0;
}

async function deliverOrKeep(
  worker: Session, lead: Session, report: WorkerReport, deps: TeamDeliveryDeps, running: boolean,
): Promise<void> {
  await deliverReport(worker, lead, report, deps, async () => {
    await deps.outbox.add({
      id: `${worker.sessionId}:${report.at}`, leadId: lead.sessionId, workerId: worker.sessionId, ...report,
    });
    deps.scheduleRetry();
    log.info(`worker ${worker.sessionId} report kept for lead ${lead.sessionId} until the restart is over`);
  }, running);
}

/**
 * Handle a finished worker turn. Called synchronously from the turn's ending, before the turn
 * releases its own busy count, so the bracket taken here leaves no idle moment between the worker's
 * turn and the lead's admission for a deferred restart to land in.
 *
 * A failed or stopped turn always wakes the lead, except a stop that only means a new turn took the
 * worker over. Otherwise the lead is woken only if the worker has settled; a busy worker's reply
 * becomes a progress row and is owed to the lead.
 */
export function onWorkerTurnCompleted(
  event: { sessionId: string; status: WorkerTurnStatus; finalOutput: string; trigger: string; held?: boolean },
  deps: TeamDeliveryDeps = defaultDeps,
): Promise<void> {
  if (!deps.enabled()) return Promise.resolve();
  return busyWhile(deps, () => serialized(event.sessionId, async () => {
    const pair = await workerAndLead(event.sessionId, deps);
    if (!pair) return;
    const { worker, lead } = pair;
    clearDispatch(worker.sessionId);
    // A turn the user started by typing in the worker's own chat is theirs, not the lead's: it is
    // not reported, only flagged on the roster. It may still have settled a report the lead is owed.
    if (event.trigger === 'web-user') {
      markUserTouched(worker.sessionId);
      if (owed.has(worker.sessionId)) scheduleSettleCheck(worker.sessionId, deps);
      return;
    }
    const report: WorkerReport = { status: event.status, text: event.finalOutput, at: deps.now() };
    recordWorkerReport(worker.sessionId, report);
    const { settled, queued, workHeld } = settledAtTurnEnd(await deps.activity(worker), event.held === true);
    const wake = event.status === 'failed' || (event.status === 'stopped' && !queued) || settled;
    if (wake) {
      owed.delete(worker.sessionId);
      await deliverOrKeep(worker, lead, report, deps, queued || workHeld);
      return;
    }
    owed.set(worker.sessionId, report);
    armSweep(deps);
    const text = event.finalOutput.trim();
    if (!text) return;
    await deps.recordProgress(lead, {
      text: cap(text, REPORT_MAX_CHARS, 'Truncated.'),
      worker: { name: worker.workerName ?? worker.name, sessionId: worker.sessionId },
      ts: new Date(report.at).toISOString(),
    });
  }));
}

/** Deliver a worker's owed report if it has settled since its turn ended. A no-op when nothing is
 *  owed or the worker is still busy (a turn that is running reports on its own when it ends). */
export function checkWorkerSettled(workerId: string, deps: TeamDeliveryDeps = defaultDeps): Promise<void> {
  if (!deps.enabled() || !owed.has(workerId)) return Promise.resolve();
  return busyWhile(deps, () => serialized(workerId, async () => {
    const report = owed.get(workerId);
    if (!report) return;
    const pair = await workerAndLead(workerId, deps);
    if (!pair) {
      owed.delete(workerId);
      return;
    }
    if (!settledNow(await deps.activity(pair.worker))) return;
    owed.delete(workerId);
    await deliverOrKeep(pair.worker, pair.lead, report, deps, false);
  }));
}

const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function scheduleSettleCheck(workerId: string, deps: TeamDeliveryDeps): void {
  const existing = recheckTimers.get(workerId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    recheckTimers.delete(workerId);
    void checkWorkerSettled(workerId, deps).catch((error) => {
      log.warn(`settle check for worker ${workerId} failed: ${(error as Error).message}`);
    });
  }, SETTLE_RECHECK_MS);
  timer.unref?.();
  recheckTimers.set(workerId, timer);
}

function armSweep(deps: TeamDeliveryDeps): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (owed.size === 0) {
      clearInterval(sweepTimer!);
      sweepTimer = null;
      return;
    }
    for (const workerId of owed.keys()) scheduleSettleCheck(workerId, deps);
  }, SETTLE_SWEEP_MS);
  sweepTimer.unref?.();
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
      await deps.deliver({
        channel: lead.channel, origin: 'worker-question',
        text: buildWorkerQuestionNotice(name, request, view, !!worker.commissionDraft),
      });
      return true;
    });
  } catch (error) {
    log.warn(`worker request ${request.requestId} not forwarded: ${(error as Error).message}`);
    return false;
  }
}

/** Install the report subscribers. Called once at boot. The bus calls the turn subscriber
 *  synchronously from the turn's ending, which is what lets the busy bracket close the gap before
 *  the turn's own release. A worker going idle, or one of its questions resolving, re-checks a
 *  report it owes. */
export function installTeamDelivery(bus: EventBus, deps: TeamDeliveryDeps = defaultDeps): void {
  bus.subscribe('session.turn.completed', (event) => {
    void onWorkerTurnCompleted(event, deps).catch((error) => {
      log.warn(`worker report for ${event.sessionId} failed: ${(error as Error).message}`);
    });
  });
  bus.subscribe('session.status', (event) => {
    if (!event.running && owed.has(event.sessionId)) scheduleSettleCheck(event.sessionId, deps);
  });
  bus.subscribe('session.interaction', (event) => {
    if (event.status !== 'pending' && owed.has(event.sessionId)) scheduleSettleCheck(event.sessionId, deps);
  });
}
