import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import type { Backend } from '@core/types/agent-types.js';
import type { Session } from '@store/session-registry-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { createDirectSession } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import { isTeamLead, MAX_RUNNING_WORKERS, WORKER_NAME_RE } from '@domain/sessions/team.js';
import {
  applyChannelSelection, readChannelSelection, resolveBackendForChannel,
  type ApplySelectionRequest, type ApplySelectionResult, type ChannelSelection,
} from '@domain/agents/index.js';
import { getDefaultProfileForBackend } from '@domain/agents/profile-manager.js';
import { parseModelSpec } from '@domain/agents/subagent/runner.js';
import { deliverToSessionDetached, type DeliverToSessionOptions } from './session-gateway.js';
import { cancelChannelRuns } from './routing/commands/cancel.js';
import { interactionRecords, type InteractionRecords } from './interactions/interaction-records.js';
import { planApprovals } from './interactions/plan-approvals.js';
import { answerQuestion } from './interactions/answer-question.js';
import { getGroupByHookRequestId } from './interactions/ask-user-question.js';
import { respondToPlan } from './interactions/plan-response.js';
import {
  clearDispatch, describeTeam, formatAge, isWorkerBusy, noteDispatch, rosterLine, statusLabel,
  type WorkerView,
} from './team-state.js';

const log = createLogger('team-webhook');

export interface TeamWebhookReply {
  success: boolean;
  data?: unknown;
  error?: string;
}

type Outcome = 'resolved' | 'already-resolved' | 'not-found';

export interface TeamWebhookDeps {
  sessions: Pick<typeof sessionStore, 'getById' | 'listWorkers' | 'setWorkerRetired' | 'rename'>;
  /** Creates the worker on a channel whose selection is already written. Naming the same profile
   *  again only records it on the session; it leaves the channel's selection as written. */
  createSession: (opts: {
    projectId: string; sessionId: string; profileName: string; teamLeadId: string; workerName: string;
  }) => Promise<{ sessionId: string; channel: string }>;
  newSessionId: () => string;
  deliver: (opts: Pick<DeliverToSessionOptions, 'channel' | 'text' | 'origin'>) => void;
  cancel: (channel: string) => Promise<number>;
  readSelection: (channel: string) => ChannelSelection;
  defaultProfile: (backend: Backend) => string | null;
  applySelection: (request: ApplySelectionRequest) => Promise<ApplySelectionResult>;
  interactions: Pick<InteractionRecords, 'get'>;
  answerQuestion: (requestId: string, answers: Record<string, string>) => Outcome;
  /** The question texts of a pending ask, or null when it has no live group. */
  questionTexts: (requestId: string) => string[] | null;
  respondPlan: (requestId: string, approved: boolean, feedback: string) => Outcome;
  describeTeam: (leadSessionId: string) => Promise<WorkerView[]>;
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
  deliver: (opts) => deliverToSessionDetached(opts),
  cancel: (channel) => cancelChannelRuns(channel),
  readSelection: (channel) => readChannelSelection(channel),
  defaultProfile: (backend) => getDefaultProfileForBackend(backend),
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
  return team.filter(v => !v.retired && isWorkerBusy(v)).length;
}

function capError(): TeamError {
  return new TeamError(
    `${MAX_RUNNING_WORKERS} workers are already running; wait for a report or stop one (worker_stop) first`,
  );
}

type WorkerSelection = Required<Pick<ApplySelectionRequest, 'model' | 'provider' | 'thinking' | 'mode'>>
  & { profileName: string };

/**
 * What a new worker runs: the lead's own profile and selection, unless the call names a backend or
 * model. `model` is the `agent` tool's `provider/model[:thinking]`; a field it gives replaces the
 * lead's, a field it omits keeps it. Another backend starts from that backend's default profile,
 * since none of the lead's choices mean anything there.
 */
function resolveWorkerSelection(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): WorkerSelection {
  const own = deps.readSelection(lead.channel);
  const requested = str(data.backend);
  if (requested && requested !== 'claude' && requested !== 'pi') {
    throw new TeamError('backend must be "claude" or "pi"');
  }
  const backend: Backend = (requested as Backend) || own.backend;
  const spec = parseModelSpec(str(data.model) || undefined);
  // A bare Claude model id has no provider segment; one written for PI is dropped, not smuggled in.
  if (backend === 'claude') delete spec.provider;

  if (backend === own.backend) {
    const base = own.override ?? {};
    // A route belongs to its provider's endpoint, so it does not survive a move to another one.
    const movesProvider = spec.provider !== undefined && spec.provider !== own.provider;
    return {
      profileName: own.profileName,
      model: spec.model ?? base.model ?? null,
      provider: spec.provider ?? base.provider ?? null,
      thinking: spec.thinking ?? base.thinking ?? null,
      mode: movesProvider ? null : base.mode ?? null,
    };
  }
  const profileName = deps.defaultProfile(backend);
  if (!profileName) throw new TeamError(`no profile is configured for the ${backend} backend`);
  return {
    profileName,
    model: spec.model ?? null,
    provider: spec.provider ?? null,
    thinking: spec.thinking ?? null,
    mode: null,
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
    throw new TeamError(existing.workerRetiredAt != null
      ? `a retired worker is already named "${name}"; revive it with worker_send, or pick another name`
      : `a worker named "${name}" already exists; continue it with worker_send, or pick another name`);
  }
  if (runningCount(await deps.describeTeam(lead.sessionId)) >= MAX_RUNNING_WORKERS) throw capError();

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
    profileName: applied.profileName,
    teamLeadId: lead.sessionId,
    workerName: name,
  });
  await deps.sessions.rename(created.sessionId, name);
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
  if (worker.workerRetiredAt != null) await deps.sessions.setWorkerRetired(worker.sessionId, null);
  noteDispatch(worker.sessionId, null, deps.now());
  deps.deliver({ channel: worker.channel, text: message, origin: 'team-lead' });
  return ok(busy
    ? `Delivered into "${worker.workerName}"'s running turn.`
    : `Delivered to "${worker.workerName}"; it starts a new turn. Its report will arrive as a new message.`);
}

function modelLabel(selection: ChannelSelection): string {
  const model = selection.provider ? `${selection.provider}/${selection.model}` : selection.model;
  return `${selection.backend} ${model}${selection.thinking ? `:${selection.thinking}` : ''}`;
}

function describeOne(view: WorkerView, selection: ChannelSelection, now: number): string {
  const lines = [
    `Worker "${view.name}" (session ${view.sessionId})`,
    `Status: ${statusLabel(view)}${view.retired ? ' (retired)' : ''}`,
    `Model: ${modelLabel(selection)}`,
  ];
  if (view.brief) lines.push(`Brief: ${view.brief}`);
  if (view.contextPercent !== null) lines.push(`Context: ${view.contextPercent}%`);
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
  const active = team.filter(v => !v.retired);
  const retired = team.filter(v => v.retired);
  if (team.length === 0) return ok('No workers yet.');
  const lines = active.length > 0 ? active.map(v => rosterLine(v, now)) : ['No active workers.'];
  if (retired.length > 0) lines.push(`Retired: ${retired.map(v => v.name).join(', ')}`);
  return ok(lines.join('\n'));
}

async function stop(lead: Session, data: Record<string, any>, deps: TeamWebhookDeps): Promise<TeamWebhookReply> {
  const worker = await findWorker(lead, str(data.worker), deps);
  const stopped = await deps.cancel(worker.channel);
  clearDispatch(worker.sessionId);
  const retire = data.retire === true;
  if (retire) await deps.sessions.setWorkerRetired(worker.sessionId, deps.now());
  const what = stopped > 0 ? 'Stopped its running turn' : 'It had nothing running';
  return ok(`${what}${retire ? '; retired' : ''}.`);
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

/** `/webhook/team`: the daemon side of the `cortex-workers` tools. Every action re-checks that the
 *  caller is a lead under the current setting, and every action returns without waiting on a worker. */
export async function handleTeamWebhook(
  data: Record<string, any>,
  deps: TeamWebhookDeps = defaultDeps,
): Promise<TeamWebhookReply> {
  try {
    const action = ACTIONS[str(data?.action)];
    if (!action) return { success: false, error: `unknown action: ${String(data?.action)}` };
    const lead = await requireLead(data, deps);
    return await action(lead, data, deps);
  } catch (error) {
    if (!(error instanceof TeamError)) log.error(`team ${String(data?.action)} failed: ${(error as Error).message}`);
    return { success: false, error: (error as Error).message };
  }
}
