import { randomUUID } from 'node:crypto';
import type { DownloadedFile } from '@platform/index.js';
import type { AttachmentFailure } from './routing/file-handler.js';
import { getDefaultAgent } from '@domain/agents/index.js';
import { getDefaultProfileName, type ResolvedProfileConfig } from '@domain/agents/profile-manager.js';
import { effectiveProfile, resolveRunConfig } from '@domain/runs/config-resolver.js';
import { FALLBACK_ENVIRONMENT, resolveEnvironmentByName } from '@domain/agents/environments/index.js';
import { composeUserPrompt, userProfileBlock } from '@domain/runs/prompt.js';
import { resolveSystemVars } from '@core/prompt-template.js';
import { sessionEvidenceContext } from '@domain/benchmark/session-evidence.js';
import { fromAgentSlot } from '@domain/runs/spec-loader.js';
import { DIRECT_RUN_POLICY } from '@domain/runs/builders.js';
import { projectStore } from '@domain/projects/index.js';
import type { Project } from '@domain/projects/index.js';
import {
  loadCommissionDraftContext, loadCommissionPromptContext,
  type CommissionPromptContext,
} from '@domain/commissions/commission-context.js';
import { sessionStore, type Session } from '@store/session-registry-repo.js';
import { CONVERSATION_HISTORY_DIR } from '@store/conversation-history-repo.js';
import { isTeamLead, isTeamWorker } from '@domain/sessions/team.js';
import { describeTeam, rosterLine, type WorkerView } from './team-state.js';
import { takeUnreadDigest } from './team-inbox.js';
import { getSettings } from '@core/settings.js';
import type { AgentSpec, RunRequest } from '@domain/runs/request.js';
import type { ResolvedEnvironment } from '@core/types/environment-types.js';
import {
  buildPrompt as buildAgentPrompt, formatAttachmentFailures,
} from '../agent-adapter/normalize/prompt-builder.js';

/** The ids the caller has already resolved for this turn — the Turn's own `TurnSessionIds`. */
export interface ConversationSessionIds {
  /** Stable Cortex tracking id for this session (UI identity, execution-record + publish key).
   *  Null only on the degenerate edit retry of a channel that has no session. */
  sessionId: string | null;
  /** Backend resume target (the backend CLI's own session id), or null for a fresh session. */
  backendSessionId: string | null;
  /** Resolved session name for this turn. */
  sessionName: string | null;
  /** The project this session is bound to (from the session registry record). */
  projectId: string;
}

/**
 * One turn on a session's live engine. Every surface that opens such a turn — a user message, an
 * edit retry, an ask-user answer — builds its request here, because the pool respawns the engine
 * when two requests disagree on anything that decides it (agent tools and plugins, worker tools,
 * the commission skill, the browser, the interaction bridge).
 */
export interface PrepareConversationRequestOptions {
  ids: ConversationSessionIds;
  channel: string;
  /** The session record, read once by the caller for the whole turn; null when there is none. */
  session: Session | null;
  /** The text the agent answers (without the default agent's directive). */
  userMessage: string;
  files?: DownloadedFile[];
  /** Attachments the platform refused to hand over; named in the prompt so the agent cannot
   *  answer as though the user had sent nothing. */
  failedFiles?: AttachmentFailure[];
  /** CDP endpoint of the browser this session opted into, or null for the usual no-browser session. */
  browserCdpEndpoint?: string | null;
  /** Execution trigger of a surface other than a plain message (`edit-retry`, `ask-user-question`).
   *  Absent ⇒ the session's own (see {@link conversationTrigger}). */
  trigger?: string;
  /** Receives the backend-ready prompt after context and attachment paths are assembled. */
  onPromptBuilt?: ((prompt: string) => void) | null;
}

export interface PreparedRequest {
  request: RunRequest;
  /** The backend-ready prompt (context + attachment paths); debug/history use only. */
  backendPrompt: string;
}

function buildBackendPrompt(prompt: string, files: DownloadedFile[]): string {
  return buildAgentPrompt(prompt, files.map(attachmentOf));
}

/**
 * Whether the surface wants a background hold. The conversation path never waits inline, so both
 * `hold` and `none` resolve `awaitBackground:false`; this only names the surface's intent for the
 * run record. `shouldHoldForBg` / `shouldHoldWebForBg` still make the final call once the result
 * (and its pending-task counts) is known.
 */
function conversationBackgroundPolicy(channel: string): 'hold' | 'none' {
  return channel.startsWith('slack:') || channel.startsWith('feishu:') || channel.startsWith('web:')
    ? 'hold'
    : 'none';
}

/**
 * Decide whether (and which) project context to inject into the conversation prompt.
 * Returns the {id, contextDir} pair for composeUserPrompt, or null to inject nothing.
 *
 * Injection is deliberately narrow: only the FIRST turn (fresh backend session — resume keeps it
 * in history) of a Web UI direct session (`web:` channel — the only path where the user explicitly
 * binds the session to a project at create time), and only for real user projects (the `general`
 * umbrella carries no signal). Unknown/deleted project ids inject nothing rather than a dead path.
 * An agent with `projectContext: false` opts out of the block entirely — "record your findings in
 * the project" is operational noise in an environment built for something else.
 */
export function resolveConversationProject(args: {
  channel: string;
  projectId: string;
  isFreshSession: boolean;
  projectContext?: boolean;
  store?: Pick<typeof projectStore, 'get'>;
}): { id: string; contextDir: string } | null {
  const store = args.store ?? projectStore;
  if (args.projectContext === false) return null;
  if (!args.isFreshSession) return null;
  if (!args.channel.startsWith('web:')) return null;
  const project: Project | undefined = store.get(args.projectId);
  if (!project || project.kind === 'general') return null;
  return { id: project.id, contextDir: project.contextDir };
}

/**
 * The policy one conversation turn opens under: the shared direct-run policy, the surface's own
 * background intent, and the execution-environment fields the agent template declares.
 *
 * Every environment default equals what {@link DIRECT_RUN_POLICY} already said, so an agent that
 * declares none of them produces that constant field for field — which is why adding the fields
 * changed no existing session. `skills` and `settingSources` stay `undefined` rather than being
 * defaulted here: absent means "whatever the backend loads on its own", and only the agent that
 * opts out has an opinion.
 */
export function conversationRunPolicy(
  agentConfig: ResolvedEnvironment,
  opts: { channel: string; browserCdpEndpoint?: string | null },
): RunRequest['policy'] {
  return {
    ...DIRECT_RUN_POLICY,
    background: conversationBackgroundPolicy(opts.channel),
    hooks: agentConfig.disableHooks !== true,
    loadRules: agentConfig.loadRules !== false,
    skills: agentConfig.skills,
    settingSources: agentConfig.settingSources,
    mcpComposition: agentConfig.mcpComposition ?? 'direct',
    mcpToolAllowlist: agentConfig.mcpToolAllowlist,
    browserCdpEndpoint: opts.browserCdpEndpoint ?? null,
  };
}

/**
 * Which agent — which execution environment — a conversation turn opens under.
 *
 * The chain is the profile chain's twin: the session's own choice (what the composer set, or what
 * `!agent` recorded on the session), then the channel's selection, then the global default, then
 * `main`. `getDefaultAgent(channel)` already folds the middle two together.
 *
 * A candidate that no longer resolves is SKIPPED rather than fatal: an agent renamed or deleted
 * since it was persisted must not kill every turn of the session that named it, exactly as an
 * unknown channel profile falls back instead of throwing (see the run-config resolution below).
 */
export function resolveConversationAgent(
  candidates: ReadonlyArray<string | null | undefined>,
  resolve: (name: string) => ResolvedEnvironment | null = resolveEnvironmentByName,
): { agentName: string; agentConfig: ResolvedEnvironment } {
  for (const name of [...candidates, FALLBACK_ENVIRONMENT]) {
    if (!name) continue;
    const agentConfig = resolve(name);
    if (agentConfig) return { agentName: name, agentConfig };
  }
  throw new Error(`Unknown default agent: ${FALLBACK_ENVIRONMENT}`);
}

/** The parts of the session record that decide how a turn is attributed. */
type SessionRunFacts = Pick<Session, 'origin' | 'scheduleId'>;

/**
 * How a turn is attributed. A schedule's run — a session its fire opened, not yet adopted by a reply
 * — runs as a scheduled execution of that schedule: that is what the scheduler reads to skip a fire
 * while the previous run is still going, and what cost and the gateway attribute to the schedule.
 * Every other turn is the user's.
 */
export function conversationTrigger(session: Partial<SessionRunFacts> | null): Pick<
  RunRequest['context'], 'trigger' | 'executionKind' | 'scheduleTaskId'
> {
  if (session?.origin === 'scheduled' && session.scheduleId) {
    return { trigger: 'scheduled', executionKind: 'scheduled', scheduleTaskId: session.scheduleId };
  }
  return { trigger: 'user', executionKind: 'local', scheduleTaskId: null };
}

/** The delivery key for a session's current commission binding, or null outside the mode. Bound
 *  wins over drafting: finalize clears the draft, and the two are never both meaningful. */
export function commissionBindingKey(
  session: { commissionId?: string | null; commissionDraft?: string | null } | null,
): string | null {
  if (session?.commissionId) return `active:${session.commissionId}`;
  if (session?.commissionDraft) return `draft:${session.commissionDraft}`;
  return null;
}

type CommissionSessionFields = Pick<
  Session, 'sessionId' | 'commissionId' | 'commissionDraft' | 'projectId' | 'commissionBlockFor'
>;

/**
 * Load the [Commission] injection payload for this turn, or null when nothing needs delivering.
 *
 * Delivery follows the STATE, not the session's age (DR-0037 v4). v3 injected on the first turn
 * only, on the same economics as USER.md / [Session Project]: resume keeps the block in backend
 * history, so re-sending it every turn is waste. True — but it silently assumed the binding is
 * decided before the first turn, and it is not: a session can enter the mode mid-conversation (the
 * agent calls `cortex_commission_start`, or the user switches it on) and it always binds its
 * contract mid-conversation. Those sessions received the block never. So the marker records WHICH
 * binding was delivered, and a turn injects when the current binding differs from it.
 *
 * `isFreshSession` still forces delivery: a spawn that died before writing history leaves the
 * marker set against a conversation that does not contain the block. `enabled` is the global
 * feature switch: off means no contract block reaches any prompt, matching the skill gate and the
 * refusal in the commission tools.
 *
 * Best-effort throughout: any failure injects nothing rather than failing the turn.
 */
export async function resolveConversationCommission(
  session: CommissionSessionFields | null,
  args: { isFreshSession?: boolean; enabled: boolean },
  deps: {
    load?: typeof loadCommissionPromptContext;
    loadDraft?: typeof loadCommissionDraftContext;
    markDelivered?: (sessionId: string, key: string) => Promise<unknown>;
  } = {},
): Promise<CommissionPromptContext | null> {
  try {
    const key = commissionBindingKey(session);
    if (!args.enabled || !session || !key) return null;
    if (!args.isFreshSession && key === session.commissionBlockFor) return null;
    const context = await loadCommissionContext(session, deps);
    // Nothing loadable (contract still empty, directory gone) — leave the marker alone so the next
    // turn tries again rather than recording a delivery that never happened.
    if (!context) return null;
    const mark = deps.markDelivered
      ?? ((id: string, value: string) => sessionStore.markCommissionBlockDelivered(id, value));
    await mark(session.sessionId, key);
    return context;
  } catch {
    return null;
  }
}

async function loadCommissionContext(
  session: CommissionSessionFields,
  deps: { load?: typeof loadCommissionPromptContext; loadDraft?: typeof loadCommissionDraftContext },
): Promise<CommissionPromptContext | null> {
  if (session.commissionId) return (deps.load ?? loadCommissionPromptContext)(session.commissionId);
  // A session still drafting has no commission id yet — it is the FIRST session of the
  // commission, and the one that most needs to be told what it is here to do.
  if (session.commissionDraft && session.projectId) {
    return (deps.loadDraft ?? loadCommissionDraftContext)(session.projectId, session.commissionDraft);
  }
  return null;
}

type TeamSessionFields = Pick<Session, 'sessionId' | 'teamLeadId' | 'workerName' | 'name'>;

/**
 * The team-mode blocks for this turn. A lead with at least one active worker, or with unread routine
 * updates, gets the [Team] block on every turn (its state changes between turns, and a lead with no
 * workers sees nothing new); the unread updates it carries are read from then on. A worker gets the
 * [Worker] orientation on its first turn only; resume keeps it in history. Best-effort: a failure
 * injects nothing.
 */
export async function resolveConversationTeam(
  session: TeamSessionFields | null,
  args: { teamLead?: boolean; isFreshSession?: boolean },
  deps: {
    getSession?: (id: string) => Promise<Pick<Session, 'name' | 'label'> | null>;
    describeTeam?: (leadSessionId: string) => Promise<WorkerView[]>;
    /** The lead's unread routine updates section, now marked read ('' when none). */
    takeUnread?: (leadSessionId: string) => Promise<string>;
    now?: () => number;
  } = {},
): Promise<{ team: { roster: string[]; unread?: string } | null; worker: { name: string; lead: string } | null }> {
  const none = { team: null, worker: null };
  try {
    if (!session) return none;
    if (args.teamLead) {
      const team = (await (deps.describeTeam ?? describeTeam)(session.sessionId)).filter(v => !v.retired);
      const unread = await (deps.takeUnread ?? (async (id: string) => (await takeUnreadDigest(id)).text))(session.sessionId);
      if (team.length === 0 && !unread) return none;
      const now = (deps.now ?? Date.now)();
      return { team: { roster: team.map(v => rosterLine(v, now)), ...(unread ? { unread } : {}) }, worker: null };
    }
    if (!args.isFreshSession || !isTeamWorker(session)) return none;
    const getSession = deps.getSession ?? ((id: string) => sessionStore.getById(id));
    const lead = await getSession(session.teamLeadId!);
    if (!lead) return none;
    return { team: null, worker: { name: session.workerName ?? session.name, lead: lead.label ?? lead.name } };
  } catch {
    return none;
  }
}

/** The profile a turn runs on: the agent's own, or the channel's when it says `__active__`. */
function conversationProfile(channel: string, agentConfig: ResolvedEnvironment): ResolvedProfileConfig {
  // D5: one resolution for name, profile and the channel's `!model` override. A hardcoded agent
  // profile is an explicit override; `__active__` means "whatever this channel resolves to".
  const runConfig = resolveRunConfig({
    channel,
    override: agentConfig.profile === '__active__' ? null : agentConfig.profile,
  });
  if (runConfig.resolved) return effectiveProfile(runConfig);
  // An unknown name here is not the user naming a bad profile — it is a channel profile that was
  // renamed or deleted since it was persisted, so the turn falls back to the default rather than
  // dying. (Named-profile errors surface through `!profile`, which validates before it writes.)
  return effectiveProfile(resolveRunConfig({ channel, override: getDefaultProfileName() }));
}

/** The user prompt with the ambient blocks this turn owes the session. */
async function composeConversationPrompt(
  opts: PrepareConversationRequestOptions,
  agent: { config: ResolvedEnvironment; spec: AgentSpec },
  state: { commissionEnabled: boolean; teamLead: boolean },
): Promise<string> {
  const { backendSessionId, projectId } = opts.ids;
  // USER.md, the project and the transcript location go out on a session's FIRST turn only (no
  // backend session yet): resume keeps them in history, so re-sending them just wastes tokens.
  const isFreshSession = backendSessionId === null;
  const composed = composeUserPrompt(agent.spec, opts.userMessage, {
    userContext: userProfileBlock(isFreshSession),
    project: resolveConversationProject({
      channel: opts.channel, projectId, isFreshSession, projectContext: agent.config.projectContext,
    }),
    transcriptDir: isFreshSession ? CONVERSATION_HISTORY_DIR : null,
    // Once per commission binding rather than once per session (see resolveConversationCommission).
    commission: await resolveConversationCommission(opts.session, {
      isFreshSession, enabled: state.commissionEnabled,
    }),
    // Team mode: the lead's roster every turn while it has workers, a worker's orientation once.
    ...(await resolveConversationTeam(opts.session, { teamLead: state.teamLead, isFreshSession })),
  });
  // The backend composes the real prompt from `prompt.text` + `prompt.attachments`, so a download
  // failure has to ride the TEXT to reach the model — `backendPrompt` is the debug echo.
  return `${formatAttachmentFailures(opts.failedFiles ?? [])}${composed}`;
}

/** The options that decide a turn's engine: whose session, on which channel, with which browser,
 *  opened by which surface. A command on the live engine (compaction) has exactly these. */
export type ConversationEngineOptions = Pick<
  PrepareConversationRequestOptions, 'ids' | 'channel' | 'session' | 'browserCdpEndpoint' | 'trigger'
>;

interface ConversationShape {
  /** The turn's request with an empty prompt. */
  request: RunRequest;
  agentConfig: ResolvedEnvironment;
  commissionEnabled: boolean;
  teamLead: boolean;
}

/** How a turn on the session is attributed and which engine-side features it carries. */
function conversationContext(
  opts: ConversationEngineOptions,
  state: { commissionEnabled: boolean; teamLead: boolean; teamWorker: boolean },
): RunRequest['context'] {
  const own = conversationTrigger(opts.session);
  return {
    channel: opts.channel,
    // Cost/execution go to the session's bound project, never a re-derivation from the text.
    project: opts.ids.projectId,
    // A scheduled run stays user-initiated: it is an ordinary session the user reads and may reply
    // to, so it pauses and resumes on a rate limit exactly like one.
    isUserInitiated: true,
    // Set once a contract has landed — the state that loads the commission skill (DR-0037 v4).
    commissionMode: state.commissionEnabled && !!opts.session?.commissionId,
    ...(state.teamLead ? { teamLead: true } : {}),
    ...(state.teamWorker ? { teamWorker: true } : {}),
    ...own,
    // Another surface records itself as the trigger, but the route keeps the session's own: the
    // live engine was spawned on it, and a different route would respawn it for this one turn.
    ...(opts.trigger ? { trigger: opts.trigger, routeTrigger: own.trigger } : {}),
  };
}

/** Everything about a turn's request except what it says. */
function conversationShape(opts: ConversationEngineOptions): ConversationShape {
  const { session, channel } = opts;
  const { agentConfig } = resolveConversationAgent([session?.agentName ?? null, getDefaultAgent(channel)]);
  const policy = conversationRunPolicy(agentConfig, { channel, browserCdpEndpoint: opts.browserCdpEndpoint });
  // settings.commissionEnabled is the global switch for the feature. With it off, a session that
  // was bound while it was on reverts to an ordinary session: no commission skill, no contract
  // block, and the commission tools refuse.
  const commissionEnabled = getSettings().commissionEnabled;
  // Team mode: a lead's engine loads the worker tools, a worker's loads `mark_routine`.
  const teamLead = isTeamLead(session);
  const teamWorker = isTeamWorker(session);
  const request: RunRequest = {
    runId: randomUUID(),
    session: {
      sessionId: opts.ids.sessionId,
      backendSessionId: opts.ids.backendSessionId,
      sessionName: opts.ids.sessionName,
      // Hazard (a): the pool key must stay the channel, byte-identical to what every interactive
      // turn has opened its engine under — changing it would silently re-pool every live session.
      engineKey: channel,
    },
    profile: conversationProfile(channel, agentConfig),
    spec: fromAgentSlot(agentConfig, { mcpComposition: policy.mcpComposition }),
    prompt: { text: '' },
    context: conversationContext(opts, { commissionEnabled, teamLead, teamWorker }),
    policy,
  };
  attachBenchmarkEvidence(request);
  return { request, agentConfig, commissionEnabled, teamLead };
}

/** Assemble the `RunRequest` for one turn on a session's live engine (see the options' doc). */
export async function prepareConversationRequest(
  opts: PrepareConversationRequestOptions,
): Promise<PreparedRequest> {
  const { request, agentConfig, commissionEnabled, teamLead } = conversationShape(opts);
  const prompt = await composeConversationPrompt(
    opts, { config: agentConfig, spec: request.spec }, { commissionEnabled, teamLead },
  );
  const files = opts.files ?? [];
  const backendPrompt = buildBackendPrompt(prompt, files);
  opts.onPromptBuilt?.(backendPrompt);
  request.prompt = { text: prompt, attachments: files.map(attachmentOf) };
  return { request, backendPrompt };
}

/**
 * The request a command on a session's live engine runs under: the request the session's next turn
 * would run under, without a prompt. The pool compares identities, so this is the only way such a
 * command is handed the session's own engine rather than a respawned one. Composes no prompt, and
 * so delivers no ambient block (the [Commission] marker is left alone).
 */
export function conversationEngineRequest(opts: ConversationEngineOptions): RunRequest {
  return conversationShape(opts).request;
}

function attachmentOf(file: DownloadedFile): { mimeType: string; path: string; name: string } {
  return { mimeType: file.mimetype, path: file.localPath, name: file.name };
}

/** A production benchmark session: every run it opens is an attempt the trial's evidence records. */
function attachBenchmarkEvidence(request: RunRequest): void {
  const evidenceContext = request.session.sessionId ? sessionEvidenceContext(request.session.sessionId) : null;
  if (!evidenceContext) return;
  request.benchmark = {
    evidenceContext,
    identityDirective: request.spec.directive ? resolveSystemVars(request.spec.directive) : '',
  };
}
