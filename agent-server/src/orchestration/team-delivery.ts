//
// Worker → lead traffic in team mode: every worker turn that ends is reported to its lead, and
// every question or plan a worker raises is forwarded to the lead as a notice it can answer with
// `worker_answer`. Both arrive as ordinary deliveries, so they fold into a running lead turn or
// wake an idle one. Nothing here runs while team mode is off or once the lead is gone.

import type { EventBus } from '@events/index.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import type { Session } from '@store/session-registry-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { deliverToSessionDetached, type DeliverToSessionOptions } from './session-gateway.js';
import {
  clearDispatch, describeWorker, markUserTouched, recordWorkerReport, statusLabel,
  type WorkerTurnStatus, type WorkerView,
} from './team-state.js';

const log = createLogger('team-delivery');

/** Reports past this are cut; the full text stays available through `worker_list(worker)`. */
export const REPORT_MAX_CHARS = 16_000;
export const PLAN_MAX_CHARS = 12_000;

export interface TeamDeliveryDeps {
  enabled: () => boolean;
  getSession: (id: string) => Promise<Session | null>;
  deliver: (opts: Pick<DeliverToSessionOptions, 'channel' | 'text' | 'origin'>) => void;
  describe: (worker: Session) => Promise<WorkerView>;
  now: () => number;
}

const defaultDeps: TeamDeliveryDeps = {
  enabled: () => getSettings().teamEnabled,
  getSession: (id) => sessionStore.getById(id),
  deliver: (opts) => deliverToSessionDetached(opts),
  describe: (worker) => describeWorker(worker),
  now: () => Date.now(),
};

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
  const parts = [`status ${statusLabel(view)}`];
  if (view.contextPercent !== null) parts.push(`ctx ${view.contextPercent}%`);
  return parts.join(' · ');
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

export async function onWorkerTurnCompleted(
  event: { sessionId: string; status: WorkerTurnStatus; finalOutput: string; trigger: string },
  deps: TeamDeliveryDeps = defaultDeps,
): Promise<void> {
  const pair = await workerAndLead(event.sessionId, deps);
  if (!pair) return;
  const { worker, lead } = pair;
  clearDispatch(worker.sessionId);
  // A turn the user started by typing in the worker's own chat is theirs, not the lead's: it is
  // not reported, only flagged on the roster.
  if (event.trigger === 'web-user') {
    markUserTouched(worker.sessionId);
    return;
  }
  recordWorkerReport(worker.sessionId, { status: event.status, text: event.finalOutput, at: deps.now() });
  const name = worker.workerName ?? worker.name;
  const view = await deps.describe(worker);
  deps.deliver({
    channel: lead.channel, origin: 'worker-result',
    text: buildWorkerReport(name, event.status, view, event.finalOutput),
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

/** Forward a worker's question or plan to its lead. The worker's own card is created as usual. */
export async function notifyLeadOfWorkerRequest(
  request: WorkerRequest, deps: TeamDeliveryDeps = defaultDeps,
): Promise<boolean> {
  try {
    const pair = await workerAndLead(request.sessionId, deps);
    if (!pair) return false;
    const { worker, lead } = pair;
    const view = await deps.describe(worker);
    deps.deliver({
      channel: lead.channel, origin: 'worker-question',
      text: buildWorkerQuestionNotice(worker.workerName ?? worker.name, request, view, !!worker.commissionDraft),
    });
    return true;
  } catch (error) {
    log.warn(`worker request ${request.requestId} not forwarded: ${(error as Error).message}`);
    return false;
  }
}

/** Install the report subscriber. Called once at boot. */
export function installTeamDelivery(bus: EventBus, deps: TeamDeliveryDeps = defaultDeps): void {
  bus.subscribe('session.turn.completed', (event) => {
    void onWorkerTurnCompleted(event, deps).catch((error) => {
      log.warn(`worker report for ${event.sessionId} failed: ${(error as Error).message}`);
    });
  });
}
