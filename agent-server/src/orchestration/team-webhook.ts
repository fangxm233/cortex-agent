import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import type { Backend } from '@core/types/agent-types.js';
import type { Session } from '@store/session-registry-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { boardRepo } from '@store/board-repo.js';
import { createDirectSession } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import { isTeamLead, isTeamWorker, MAX_RUNNING_WORKERS, WORKER_NAME_RE } from '@domain/sessions/team.js';
import { sessionState } from '@core/session-state.js';
import {
  applyChannelSelection, readChannelSelection, resolveBackendForChannel,
} from '@domain/agents/index.js';
import { getDefaultSelectionForBackend, resolveModelRef } from '@domain/agents/models.js';
import type { EngineSelection } from '@domain/agents/engine-selection.js';
import { parseModelSpec } from '@core/agents/subagent/model-spec.js';
import { isRebuildHeld } from '@domain/system/rebuild-hold.js';
import { deliverToSessionDetached, type DeliverToSessionOptions } from './session-gateway.js';
import { orchestrationBus } from './runtime.js';
import { cancelChannelRuns } from './routing/commands/cancel.js';
import { interactionRecords, type InteractionRecords } from './interactions/interaction-records.js';
import { planApprovals } from './interactions/plan-approvals.js';
import { answerQuestion } from './interactions/answer-question.js';
import { getGroupByHookRequestId } from './interactions/ask-user-question.js';
import { respondToPlan } from './interactions/plan-response.js';
import {
  briefOf, clearDispatch, describeTeam, formatAge, inactiveLine, isWorkerBusy, markTurnRoutine, noteDispatch,
  rosterLine, statusLabel, type WorkerView,
} from './team-state.js';

const log = createLogger('team-webhook');

export interface TeamWebhookReply {
  success: boolean;
  data?: unknown;
  error?: string;
}

type Outcome = 'resolved' | 'already-resolved' | 'not-found';

export interface TeamWebhookDeps {
  sessions: Pick<typeof sessionStore, 'getById' | 'listWorkers' | 'rename' | 'bindBoard'>;
  /** Create the worker with its materialized choice without moving the user's draft seed. */
  createSession: (opts: {
    projectId: string; sessionId: string; selection: EngineSelection; seedDefault: false; teamLeadId: string; workerName: string;
    workerBrief: string; boardId: string | null;
  }) => Promise<{ sessionId: string; channel: string }>;
  newSessionId: () => string;
  /** A worker joined `boardId`: tell clients its binding and the board's members changed. */
  boardJoined: (boardId: string, worker: { sessionId: string; channel: string }) => Promise<void>;
  deliver: (opts: Pick<DeliverToSessionOptions, 'channel' | 'text' | 'origin'>) => void;
  cancel: (channel: string) => Promise<number>;
  readSelection: (channel: string) => EngineSelection;
  defaultSelection: (backend: Backend) => EngineSelection | null;
  applySelection: typeof applyChannelSelection;
  interactions: Pick<InteractionRecords, 'get'>;
  answerQuestion: (requestId: string, answers: Record<string, string>) => Outcome;
  /** The question texts of a pending ask, or null when it has no live group. */
  questionTexts: (requestId: string) => string[] | null;
  respondPlan: (requestId: string, approved: boolean, feedback: string) => Outcome;
  describeTeam: (leadSessionId: string) => Promise<WorkerView[]>;
  /** True while the server refuses new turns ahead of a restart. */
  held: () => boolean;
  /** Mark the worker's current turn routine. */
  markRoutine: (workerId: string) => void;
  now: () => number;
}

const defaultDeps: TeamWebhookDeps = {
  sessions: sessionStore,
  createSession: (opts) => createDirectSession({
    sessionStore,
    setChannelSession: setSessionAsync,
    initConversation: async (channel, a) => { await conversationLedger.initConversation(channel, a); },
    resolveBackend: resolveBackendForChannel,
  }, opts),
  newSessionId: () => randomUUID(),
  boardJoined: async (boardId, worker) => {
    const bus = orchestrationBus();
    bus?.publish({ type: 'session.board', sessionId: worker.sessionId, channel: worker.channel });
    const board = await boardRepo.find(boardId);
    if (board) bus?.publish({ type: 'board.updated', boardId: board.id, projectId: board.projectId });
  },
  deliver: (opts) => deliverToSessionDetached(opts),
  cancel: (channel) => cancelChannelRuns(channel),
  readSelection: (channel) => readChannelSelection(channel),
  defaultSelection: getDefaultSelectionForBackend,
  applySelection: (request) => applyChannelSelection(request),
  interactions: interactionRecords,
  answerQuestion: (requestId, answers) => answerQuestion(requestId, answers, 'agent'),
  questionTexts: (requestId) => {
    const group = getGroupByHookRequestId(requestId) as { questions?: Array<{ question: string }> } | null;
    return group?.questions ? group.questions.map(q => q.question) : null;
  },
  respondPlan: (requestId, approved, feedback) => respondToPlan(
    { planApprovals, interactionRecords }, requestId, approved, feedback, 'agent',
  ),
  describeTeam: (leadSessionId) => describeTeam(leadSessionId),
  held: () => isRebuildHeld(),
  markRoutine: (workerId) => markTurnRoutine(workerId, sessionState(workerId).executionId),
  now: () => Date.now(),
};

class TeamError extends Error {}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function ok(text: string, extra: Record<string, unknown> = {}): TeamWebhookReply {
  return { success: true, data: { text, ...extra } };
}

async function requireLead(data: Record<string, any>, deps: TeamWebhookDeps): Promise<Session> {
  const sessionId = str(data.sessionId);
  const lead = sessionId ? await deps.sessions.getById(sessionId) : null;
  if (!isTeamLead(lead)) {
    throw new TeamError('worker tools are only available to a web session while team mode is enabled');
  }
  return lead!;
}

async function findWorker(lead: Session, name: string, deps: TeamWebhookDeps): Promise<Session> {
  if (!name) throw new TeamError('worker name required');
  const worker = (await deps.sessions.listWorkers(lead.sessionId)).find(w => w.workerName === name);
  if (!worker) throw new TeamError(`no worker named "${name}"; see worker_list`);
  return worker;
}

function runningCount(team: WorkerView[]): number {
  return team.filter(isWorkerBusy).length;
}

/** A worker cannot start a turn while the server is about to restart: say so instead of claiming
 *  a delivery the runner is going to refuse. */
function refuseWhileRestarting(deps: TeamWebhookDeps, what: string): void {
  if (!deps.held()) return;
  throw new TeamError(`the server is about to restart and is not starting new turns, so ${what}. `
    + 'Tell the user, end your turn (the restart waits for it), and try again after the restart.');
}

function capError(): TeamError {
  return new TeamError(
    `${MAX_RUNNING_WORKERS} workers are already running; wait for a report or stop one (worker_stop) first`,
  );
}

/** Copy the lead's exact choice; another backend starts from its default or first favorite. */
function resolveWorkerSelection(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): EngineSelection {
  const own = lead.selection ?? deps.readSelection(lead.channel);
  const requested = str(data.backend);
  if (requested && requested !== 'claude' && requested !== 'pi') {
    throw new TeamError('backend must be "claude" or "pi"');
  }
  const spec = parseModelSpec(str(data.model) || undefined);
  const backend: Backend = (requested as Backend) || (spec.provider ? 'pi' : own.backend);
  const base = backend === own.backend ? own : deps.defaultSelection(backend);
  if (!base) throw new TeamError(`no default or favorite for the ${backend} backend; favorite a model first`);
  const ref = spec.model ? resolveModelRef(spec.provider && backend === 'pi'
    ? `${spec.provider}/${spec.model}` : spec.model, backend) : base;
  const provider = backend === 'pi' ? (spec.provider ?? (backend === own.backend ? own.provider : ref.provider)) : null;
  return {
    ...base, backend, provider, model: ref.model,
    thinking: spec.thinking ?? base.thinking,
    mode: backend === 'pi' && provider !== base.provider ? provider ?? base.mode : base.mode,
  };
}

async function spawn(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): Promise<TeamWebhookReply> {
  const name = str(data.name);
  const prompt = str(data.prompt);
  if (!WORKER_NAME_RE.test(name)) {
    throw new TeamError('name must be a short slug: lowercase letters, digits and hyphens, at most 32 characters');
  }
  if (!prompt) throw new TeamError('prompt required');
  const existing = (await deps.sessions.listWorkers(lead.sessionId)).find(w => w.workerName === name);
  if (existing) {
    throw new TeamError(`a worker named "${name}" already exists; continue it with worker_send, or pick another name`);
  }
  if (runningCount(await deps.describeTeam(lead.sessionId)) >= MAX_RUNNING_WORKERS) throw capError();
  refuseWhileRestarting(deps, 'the worker was not created');

  const selection = resolveWorkerSelection(lead, data, deps);
  // The selection is written before the session exists, so its first turn already runs on it. A
  // lead's spawn is not a user's pick, so it leaves what the next new conversation opens on alone.
  const sessionId = deps.newSessionId();
  const applied = await deps.applySelection({ channel: `web:${sessionId}`, ...selection, seedDefault: false });
  if (!applied.ok) {
    const allowed = applied.allowed?.length ? ` (allowed: ${applied.allowed.join(', ')})` : '';
    throw new TeamError(`cannot run the worker on that model: ${applied.reason}${allowed}`);
  }
  const created = await deps.createSession({
    projectId: lead.projectId,
    sessionId,
    selection: { backend: applied.backend, provider: applied.provider, model: applied.model, thinking: applied.thinking, mode: applied.mode },
    seedDefault: false,
    teamLeadId: lead.sessionId,
    workerName: name,
    workerBrief: briefOf(prompt),
    // A worker joins its lead's board, if any.
    boardId: lead.boardId ?? null,
  });
  await deps.sessions.rename(created.sessionId, name);
  if (lead.boardId) await deps.boardJoined(lead.boardId, created);
  noteDispatch(created.sessionId, prompt, deps.now());
  deps.deliver({ channel: created.channel, text: prompt, origin: 'team-lead' });
  return ok(
    `Worker "${name}" started (session ${created.sessionId}). Its report will arrive as a new message; `
    + 'end your turn now unless you have other work to do.',
    { name, sessionId: created.sessionId, status: 'running' },
  );
}

async function send(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): Promise<TeamWebhookReply> {
  const message = str(data.message);
  if (!message) throw new TeamError('message required');
  const worker = await findWorker(lead, str(data.worker), deps);
  const team = await deps.describeTeam(lead.sessionId);
  const view = team.find(v => v.sessionId === worker.sessionId);
  const busy = !!view && isWorkerBusy(view);
  if (!busy && runningCount(team) >= MAX_RUNNING_WORKERS) throw capError();
  refuseWhileRestarting(deps, 'the message was not delivered');
  // Inactive when the lead opened its board, so it was left out; it joins now that it works again.
  if (!worker.boardId && lead.boardId) {
    await deps.sessions.bindBoard(worker.sessionId, lead.boardId);
    await deps.boardJoined(lead.boardId, worker);
  }
  noteDispatch(worker.sessionId, null, deps.now());
  deps.deliver({ channel: worker.channel, text: message, origin: 'team-lead' });
  return ok(busy
    ? `Delivered into "${worker.workerName}"'s running turn.`
    : `Delivered to "${worker.workerName}"; it starts a new turn. Its report will arrive as a new message.`);
}

function modelLabel(selection: EngineSelection): string {
  const model = selection.provider ? `${selection.provider}/${selection.model}` : selection.model;
  return `${selection.backend} ${model}${selection.thinking ? `:${selection.thinking}` : ''}`;
}

function describeOne(view: WorkerView, selection: EngineSelection, now: number): string {
  const lines = [
    `Worker "${view.name}" (session ${view.sessionId})`,
    `Status: ${statusLabel(view)}${view.inactive ? ' (inactive)' : ''}`,
    `Model: ${modelLabel(selection)}`,
  ];
  if (view.brief) lines.push(`Brief: ${view.brief}`);
  if (view.userTouched) lines.push('The user has talked to this worker directly since you last engaged it.');
  if (view.lastReport) {
    lines.push('', `Last report (${view.lastReport.status}, ${formatAge(now - view.lastReport.at)}):`,
      view.lastReport.text || '(no final reply)');
  } else {
    lines.push('', 'No report yet.');
  }
  return lines.join('\n');
}

async function list(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): Promise<TeamWebhookReply> {
  const team = await deps.describeTeam(lead.sessionId);
  const now = deps.now();
  const name = str(data.worker);
  if (name) {
    const view = team.find(v => v.name === name);
    if (!view) throw new TeamError(`no worker named "${name}"`);
    return ok(describeOne(view, deps.readSelection(view.channel), now));
  }
  if (team.length === 0) return ok('No workers yet.');
  const active = team.filter(v => !v.inactive);
  const lines = active.length > 0 ? active.map(v => rosterLine(v, now)) : ['No active workers.'];
  const inactive = inactiveLine(team, 'names');
  if (inactive) lines.push(inactive);
  return ok(lines.join('\n'));
}

async function stop(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): Promise<TeamWebhookReply> {
  const worker = await findWorker(lead, str(data.worker), deps);
  const stopped = await deps.cancel(worker.channel);
  clearDispatch(worker.sessionId);
  return ok(stopped > 0 ? 'Stopped its running turn.' : 'It had nothing running.');
}

async function answer(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): Promise<TeamWebhookReply> {
  const requestId = str(data.request_id);
  if (!requestId) throw new TeamError('request_id required');
  const record = deps.interactions.get(requestId);
  if (!record) return ok('not-found: no pending request with that id.', { outcome: 'not-found' });
  const workers = await deps.sessions.listWorkers(lead.sessionId);
  if (!workers.some(w => w.sessionId === record.sessionId)) {
    throw new TeamError('that request does not belong to one of your workers');
  }
  let outcome: Outcome;
  if (record.kind === 'ask-user') {
    const answers = data.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new TeamError('answers required for a question: an object keyed by the question text');
    }
    const normalized = Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, String(a)]));
    const missing = (deps.questionTexts(requestId) ?? []).filter(q => !(q in normalized));
    if (missing.length > 0) {
      throw new TeamError(`answers must be keyed by the exact question text; unanswered: ${missing.map(q => JSON.stringify(q)).join(', ')}`);
    }
    outcome = deps.answerQuestion(requestId, normalized);
  } else {
    if (typeof data.approved !== 'boolean') throw new TeamError('approved (true/false) required for a plan');
    outcome = deps.respondPlan(requestId, data.approved, str(data.feedback));
  }
  const text = outcome === 'resolved' ? 'resolved: the worker has your answer.'
    : outcome === 'already-resolved' ? 'already-resolved: the request was answered already (possibly by the user).'
      : 'not-found: the request is no longer pending.';
  return ok(text, { outcome });
}

const ACTIONS: Record<string, (lead: Session, data: Record<string, any>, deps: TeamWebhookDeps) => Promise<TeamWebhookReply>> = {
  spawn, send, list, stop, answer,
};

/** `mark_routine`, the one action a worker calls: its current turn's reply will not wake the lead. */
async function routine(data: Record<string, any>, deps: TeamWebhookDeps): Promise<TeamWebhookReply> {
  const sessionId = str(data.sessionId);
  const worker = sessionId ? await deps.sessions.getById(sessionId) : null;
  if (!isTeamWorker(worker)) throw new TeamError('mark_routine is only available to a team worker');
  deps.markRoutine(worker!.sessionId);
  return ok('Marked routine: your final reply this turn is recorded for the lead as a routine update '
    + 'and does not wake it. Keep that reply to one or two lines.');
}

/** `/webhook/team`: the daemon side of the `cortex-workers` tools and of a worker's `mark_routine`.
 *  Every action re-checks the caller's role under the current setting, and every action returns
 *  without waiting on a worker. */
export async function handleTeamWebhook(
  data: Record<string, any>,
  deps: TeamWebhookDeps = defaultDeps,
): Promise<TeamWebhookReply> {
  try {
    if (str(data?.action) === 'routine') return await routine(data, deps);
    const action = ACTIONS[str(data?.action)];
    if (!action) return { success: false, error: `unknown action: ${String(data?.action)}` };
    const lead = await requireLead(data, deps);
    return await action(lead, data, deps);
  } catch (error) {
    if (!(error instanceof TeamError)) log.error(`team ${String(data?.action)} failed: ${(error as Error).message}`);
    return { success: false, error: (error as Error).message };
  }
}
