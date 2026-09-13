// input:  agent facade, tool gates, prompts, run service
// output: gated plain turns and backend-ready prompt callbacks
// pos:    Thread-free user-turn execution
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Why this exists: plain user chat messages used to be wrapped in a `templateName:'default'`
// ThreadRecord and run through runThread() with ~12 `isDefault` short-circuits. That coupled
// conversations to the thread machinery (workspace, artifact.md, threads.json) for no benefit —
// none of the thread concepts (artifact comms, transitions, hooks, multi-agent) apply to a single
// conversation turn. This module runs the default agent directly through `startRun`. Session
// continuity (channel session), cost/execution tracking and turn tracking (conversation ledger) are
// all thread-independent and handled by the caller (agent-runner).

import { randomUUID } from 'node:crypto';
import type { Destination, PlatformAdapter, MessageRef, DownloadedFile } from '@platform/index.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { getDefaultAgent } from '@domain/agents/index.js';
import { getDefaultProfileName } from '@domain/agents/profile-manager.js';
import { effectiveProfile, resolveRunConfig } from '@domain/runs/config-resolver.js';
import { resolveAgentSlotConfigByName } from '@domain/threads/index.js';
import { composeUserPrompt, userProfileBlock } from '@domain/runs/prompt.js';
import { fromAgentSlot } from '@domain/runs/spec-loader.js';
import { projectStore } from '@domain/projects/index.js';
import type { Project } from '@domain/projects/index.js';
import {
  loadCommissionDraftContext, loadCommissionPromptContext,
  type CommissionPromptContext,
} from '@domain/commissions/commission-context.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getSettings } from '@core/settings.js';
import type { RunningExecutionInput } from '@core/run-registry.js';
import { startRun } from '@domain/runs/service.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { AgentSpec, RunObserver, RunRequest } from '@domain/runs/request.js';
import { buildPrompt as buildAgentPrompt } from '../agent-adapter/normalize/prompt-builder.js';

export interface RunConversationOptions {
  adapter: PlatformAdapter;
  channel: string;
  /** The raw user message (without the default agent's directive). */
  userMessage: string;
  /** Stable Cortex tracking id for this session (UI identity, execution-record + publish key). */
  trackSessionId: string;
  /** The project this session is bound to (from the session registry record). Cost + execution
   *  records are attributed to this project verbatim — no message-text re-derivation. */
  projectId: string;
  /** Backend resume target (the backend CLI's own session id), or null for a fresh session where the
   *  backend self-assigns its id. Decoupled from {@link trackSessionId}. */
  backendSessionId: string | null;
  /** Resolved session name for this turn. */
  sessionName: string;
  files: DownloadedFile[];
  startTime: number;
  /** Execution trigger; defaults to 'user'. Scheduled session-target dispatch passes 'scheduled'. */
  trigger?: string;
  scheduleTaskId?: string | null;
  /** Profile override for `__active__` agents (used by scheduler). */
  profileOverride?: string | null;
  /** CDP endpoint of the browser this session opted into, or null for the usual no-browser session.
   *  Non-null is what turns the Playwright MCP server on for this spawn. */
  browserCdpEndpoint?: string | null;
  /** Expose the commission-creation tools this turn — true only while a contract is being
   *  drafted. They are additive; the ordinary plan tools stay available either way. */
  commissionTools?: boolean;
  /** True while the session is in commission mode; loads the commission skill bundle. */
  commissionMode?: boolean;
  /** Run observers: the transcript sink is the first, surface event bridges follow. */
  observers?: RunObserver[];
  /** Fired once the execution record is created, before the agent starts — lets the caller
   *  attach an execution-scoped Cancel button to the status message. */
  onExecutionStarted?: (executionId: string) => void | Promise<void>;
  /** Fired synchronously after the backend handle is registered for cancellation. */
  onExecutionRegistered?: () => void;
  /** Receives the backend-ready prompt after context and attachment paths are assembled. */
  onPromptBuilt?: ((prompt: string) => void) | null;
}

export interface ConversationResult {
  result: AgentResult;
  executionId: string;
  /** The live run, so the caller can subscribe a background continuation sink. */
  run: AgentRun;
  /** Underlying agent process for the turn, exposed for the legacy hold path. Opaque to other
   *  consumers. */
  agentProcess?: unknown;
}

export function registerConversationHandle(
  registry: { register: (registration: RunningExecutionInput) => unknown },
  registration: RunningExecutionInput,
  onRegistered?: () => void,
): void {
  registry.register(registration);
  onRegistered?.();
}

function buildBackendPrompt(prompt: string, files: DownloadedFile[]): string {
  const attachments = files.map((file) => ({ mimeType: file.mimetype, path: file.localPath }));
  return buildAgentPrompt(prompt, attachments);
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
 */
export function resolveConversationProject(args: {
  channel: string;
  projectId: string;
  isFreshSession: boolean;
  store?: Pick<typeof projectStore, 'get'>;
}): { id: string; contextDir: string } | null {
  const store = args.store ?? projectStore;
  if (!args.isFreshSession) return null;
  if (!args.channel.startsWith('web:')) return null;
  const project: Project | undefined = store.get(args.projectId);
  if (!project || project.kind === 'general') return null;
  return { id: project.id, contextDir: project.contextDir };
}

/**
 * Load the [Commission] injection payload for a fresh commission-bound session, or null for
 * ordinary sessions. Same first-turn-only economics as USER.md / [Session Project]: resume keeps the
 * block in backend history, and mid-run contract edits reach the agent through the checkpoint
 * protocol's mandatory re-read, not through re-injection. Best-effort: any failure injects nothing.
 */
export async function resolveConversationCommission(
  trackSessionId: string,
  deps: {
    getSession?: (id: string) => Promise<{
      commissionId?: string | null; commissionDraft?: string | null; projectId?: string | null;
    } | null>;
    load?: typeof loadCommissionPromptContext;
    loadDraft?: typeof loadCommissionDraftContext;
    enabled?: () => boolean;
  } = {},
): Promise<CommissionPromptContext | null> {
  try {
    // Global feature switch (off by default while commission mode is under test). Off means no
    // contract block reaches any prompt, matching the tool/skill gate in agent-runner.
    if (!(deps.enabled ?? (() => getSettings().commissionEnabled))()) return null;
    const getSession = deps.getSession ?? ((id: string) => sessionStore.getById(id));
    const session = await getSession(trackSessionId);
    if (session?.commissionId) {
      return await (deps.load ?? loadCommissionPromptContext)(session.commissionId);
    }
    // A session still drafting its contract has no commission id yet — it is the FIRST session of
    // the commission, and the one that most needs to be told what it is here to do.
    if (session?.commissionDraft && session.projectId) {
      return (deps.loadDraft ?? loadCommissionDraftContext)(session.projectId, session.commissionDraft);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Execute a single plain user-conversation turn against the active default agent — no thread,
 * no workspace, no artifact. Mirrors the legacy default-thread branch of runThread() exactly
 * (channel session reuse, useCoreMcp:false, isUserInitiated:true, single step).
 *
 * The execution record, the live-registry registration and the teardown are owned by `startRun`
 * (plan D8). This function only assembles the fully-resolved `RunRequest`, opens the run with the
 * caller's observers, and persists the backend resume target as soon as the foreground turn
 * settles — success OR interruption.
 */
export async function runConversation(opts: RunConversationOptions): Promise<ConversationResult> {
  const defaultAgentName = getDefaultAgent() || 'main';
  const agentConfig = resolveAgentSlotConfigByName(defaultAgentName);
  if (!agentConfig) throw new Error(`Unknown default agent: ${defaultAgentName}`);

  // USER.md profile is injected only on a session's FIRST turn (no backend session yet).
  // Session resume keeps it in history thereafter, so re-sending it every turn just wastes tokens.
  const isFreshSession = opts.backendSessionId === null;
  // A thread-free conversation runs on the direct MCP surface — there is no thread to control.
  const spec: AgentSpec = fromAgentSlot(agentConfig, { mcpComposition: 'direct' });

  // A plain conversation turn is thread-free: no artifact, no previous step, no control-plane
  // preamble. Everything it does carry is a first-turn ambient block, and the two prompt-shaping
  // fields come from the very spec the run is opened with — one description of the agent, not two.
  const prompt = composeUserPrompt(spec, opts.userMessage, {
    userContext: userProfileBlock(isFreshSession),
    // Web UI direct sessions are bound to a project at create time; tell the agent which one
    // on the session's first turn (see resolveConversationProject for the exact gating).
    project: resolveConversationProject({ channel: opts.channel, projectId: opts.projectId, isFreshSession }),
    // Commission-bound sessions additionally get the contract + ledger digest + protocol block
    // on their first turn (see resolveConversationCommission).
    commission: isFreshSession ? await resolveConversationCommission(opts.trackSessionId) : null,
  });
  opts.onPromptBuilt?.(buildBackendPrompt(prompt, opts.files));
  // Attribute cost/execution to the session's bound project (from the registry record), NOT a
  // re-derivation from the message text. A session created under project X stays project X even if
  // no message ever mentions X literally (that mismatch previously dumped everything into 'general').
  const project = opts.projectId;

  // D5: one resolution for name, profile and the channel's `!model` override. A hardcoded agent
  // profile is an explicit override; `__active__` means "whatever this channel resolves to", and
  // the scheduler's own override still comes first.
  const runConfig = resolveRunConfig({
    channel: opts.channel,
    override: agentConfig.profile === '__active__' ? (opts.profileOverride ?? null) : agentConfig.profile,
  });
  // An unknown name here is not the user naming a bad profile — it is a channel profile that was
  // renamed or deleted since it was persisted, so the turn falls back to the default rather than
  // dying. (Named-profile errors surface through `!profile`, which validates before it writes.)
  const profileName = runConfig.resolved ? runConfig.profileName : getDefaultProfileName();
  const profile = runConfig.resolved
    ? effectiveProfile(runConfig)
    : effectiveProfile({ ...resolveRunConfig({ channel: opts.channel, override: profileName }) });

  const trigger = opts.trigger || 'user';

  const request: RunRequest = {
    runId: randomUUID(),
    session: {
      sessionId: opts.trackSessionId,
      backendSessionId: opts.backendSessionId,
      // Hazard (a): the legacy run passed `sessionKey: null`, so spawn-config resolved the pool key
      // from the channel. `engineKey` maps onto that same `sessionKey`, so use the channel here to
      // keep the pool key byte-identical — changing it would silently re-pool every live session.
      engineKey: opts.channel,
      sessionName: opts.sessionName,
    },
    profile,
    spec,
    prompt: {
      text: prompt,
      attachments: (opts.files || []).map((file) => ({ mimeType: file.mimetype, path: file.localPath })),
    },
    context: {
      channel: opts.channel,
      project,
      trigger,
      threadId: null,
      executionKind: trigger === 'scheduled' ? 'scheduled' : 'local',
      isUserInitiated: true,
      commissionMode: opts.commissionMode ?? false,
      commissionTools: opts.commissionTools ?? false,
      scheduleTaskId: opts.scheduleTaskId ?? null,
    },
    policy: {
      background: conversationBackgroundPolicy(opts.channel),
      recordCost: true,
      hooks: true,
      loadRules: true,
      mcpComposition: 'direct',
      mcpToolAllowlist: agentConfig.mcpToolAllowlist,
      browserCdpEndpoint: opts.browserCdpEndpoint ?? null,
      // Default for this path: legacy raw/text transcript capture stays off unless a surface opts in.
      // Claude writes a per-turn transcript file unless told not to; only a frozen subagent
      // child opts out. `captureTranscriptLogs` defaults to ON, so this must stay true.
      captureTranscripts: true,
    },
  };

  const run = startRun(request, opts.observers ?? []);

  // Same observable points as the hand-rolled path: the execution record exists before the caller
  // awaits the turn, and registration has released the session lease. `startRun` creates and
  // registers the run synchronously, so firing these here is the earliest a caller can observe them.
  if (opts.onExecutionStarted) await opts.onExecutionStarted(run.executionId);
  opts.onExecutionRegistered?.();

  let result: AgentResult;
  try {
    result = await run.result;
  } finally {
    // Persist the backend resume target as soon as the turn settles — success OR interruption.
    // The backend id is assigned at spawn (Claude `--session-id`), but was previously only
    // persisted by handleAgentSuccess, so killing a session's FIRST turn (web Stop / !cancel /
    // error) lost it and the next message started a brand-new backend session with no context.
    // The backend writes its transcript incrementally during the interrupted turn, so persisting
    // the id here lets the next turn `--resume` it (and the adapter's resolveResumeForPrint
    // self-heals to a create when no transcript was written). Best-effort; success-path
    // handleAgentSuccess still overwrites with the result's authoritative id.
    // Prefer the process's live id (PI assigns it asynchronously after spawn); fall back to the
    // run's recorded id, which is seeded from the handle at registration for adapters that never
    // emitted session_started before an interrupt.
    const backendSessionId = run.legacyProcess()?.sessionId ?? run.backendSessionId;
    if (isFreshSession && backendSessionId) {
      await sessionStore.updateSession(opts.sessionName, {
        backendSessionId,
        lastUsedAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  return { result, executionId: run.executionId, run, agentProcess: run.legacyProcess() };
}
