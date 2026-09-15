//
// input:  the ids a conversation turn already resolved (track session, backend resume target,
//         session name, project) plus the surface's per-turn options
// output: the fully-resolved `RunRequest` for a plain user-conversation turn, and the
//         backend-ready prompt string that request's text was built from
// pos:    orchestration — the assembly half of what `conversation-runner.runConversation` used to
//         do inline. Split out so the Turn object (Phase 1.4) can call it as its `prepareRequest`
//         without pulling the run-opening half along. No side effects beyond the caller's
//         `onPromptBuilt` callback: it resolves the default agent, composes the prompt, resolves
//         the profile, and returns.

import { randomUUID } from 'node:crypto';
import type { DownloadedFile } from '@platform/index.js';
import { getDefaultAgent } from '@domain/agents/index.js';
import { getDefaultProfileName } from '@domain/agents/profile-manager.js';
import { effectiveProfile, resolveRunConfig } from '@domain/runs/config-resolver.js';
import { resolveAgentSlotConfigByName } from '@domain/threads/index.js';
import { composeUserPrompt, userProfileBlock } from '@domain/runs/prompt.js';
import { fromAgentSlot } from '@domain/runs/spec-loader.js';
import { DIRECT_RUN_POLICY } from '@domain/runs/builders.js';
import { projectStore } from '@domain/projects/index.js';
import type { Project } from '@domain/projects/index.js';
import {
  loadCommissionDraftContext, loadCommissionPromptContext,
  type CommissionPromptContext,
} from '@domain/commissions/commission-context.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getSettings } from '@core/settings.js';
import type { AgentSpec, RunRequest } from '@domain/runs/request.js';
import { buildPrompt as buildAgentPrompt } from '../agent-adapter/normalize/prompt-builder.js';

/** The ids the caller has already resolved for this turn. Mirrors the plan's `prepareRequest(ids)`
 *  shape: everything else on {@link PrepareConversationRequestOptions} is per-surface turn input. */
export interface ConversationSessionIds {
  /** Stable Cortex tracking id for this session (UI identity, execution-record + publish key). */
  sessionId: string;
  /** Backend resume target (the backend CLI's own session id), or null for a fresh session. */
  backendSessionId: string | null;
  /** Resolved session name for this turn. */
  sessionName: string;
  /** The project this session is bound to (from the session registry record). */
  projectId: string;
}

export interface PrepareConversationRequestOptions {
  ids: ConversationSessionIds;
  channel: string;
  /** The raw user message (without the default agent's directive). */
  userMessage: string;
  files: DownloadedFile[];
  /** Execution trigger; defaults to 'user'. Scheduled session-target dispatch passes 'scheduled'. */
  trigger?: string;
  scheduleTaskId?: string | null;
  /** Profile override for `__active__` agents (used by scheduler). */
  profileOverride?: string | null;
  /** CDP endpoint of the browser this session opted into, or null for the usual no-browser session. */
  browserCdpEndpoint?: string | null;
  /** True once the session is bound to a landed commission; loads the commission skill bundle. */
  commissionMode?: boolean;
  /** Receives the backend-ready prompt after context and attachment paths are assembled. */
  onPromptBuilt?: ((prompt: string) => void) | null;
}

export interface PreparedRequest {
  request: RunRequest;
  /** The backend-ready prompt (context + attachment paths); debug/history use only. */
  backendPrompt: string;
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

/** The delivery key for a session's current commission binding, or null outside the mode. Bound
 *  wins over drafting: finalize clears the draft, and the two are never both meaningful. */
export function commissionBindingKey(
  session: { commissionId?: string | null; commissionDraft?: string | null } | null,
): string | null {
  if (session?.commissionId) return `active:${session.commissionId}`;
  if (session?.commissionDraft) return `draft:${session.commissionDraft}`;
  return null;
}

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
 * marker set against a conversation that does not contain the block.
 *
 * Best-effort throughout: any failure injects nothing rather than failing the turn.
 */
export async function resolveConversationCommission(
  trackSessionId: string,
  args: { isFreshSession?: boolean } = {},
  deps: {
    getSession?: (id: string) => Promise<{
      commissionId?: string | null; commissionDraft?: string | null; projectId?: string | null;
      commissionBlockFor?: string | null;
    } | null>;
    load?: typeof loadCommissionPromptContext;
    loadDraft?: typeof loadCommissionDraftContext;
    markDelivered?: (sessionId: string, key: string) => Promise<unknown>;
    enabled?: () => boolean;
  } = {},
): Promise<CommissionPromptContext | null> {
  try {
    // Global feature switch. Off means no contract block reaches any prompt, matching the skill
    // gate in agent-runner and the refusal in the commission tools.
    if (!(deps.enabled ?? (() => getSettings().commissionEnabled))()) return null;
    const getSession = deps.getSession ?? ((id: string) => sessionStore.getById(id));
    const session = await getSession(trackSessionId);
    const key = commissionBindingKey(session ?? null);
    if (!key) return null;
    if (!args.isFreshSession && key === session?.commissionBlockFor) return null;

    const context = session?.commissionId
      ? await (deps.load ?? loadCommissionPromptContext)(session.commissionId)
      // A session still drafting has no commission id yet — it is the FIRST session of the
      // commission, and the one that most needs to be told what it is here to do.
      : (session?.commissionDraft && session.projectId
        ? (deps.loadDraft ?? loadCommissionDraftContext)(session.projectId, session.commissionDraft)
        : null);
    // Nothing loadable (contract still empty, directory gone) — leave the marker alone so the next
    // turn tries again rather than recording a delivery that never happened.
    if (!context) return null;

    const mark = deps.markDelivered
      ?? ((id: string, value: string) => sessionStore.markCommissionBlockDelivered(id, value));
    await mark(trackSessionId, key);
    return context;
  } catch {
    return null;
  }
}

/**
 * Assemble the `RunRequest` for a single plain user-conversation turn against the active default
 * agent — no thread, no workspace, no artifact. The thread path's decisions are mirrored field for
 * field (channel session reuse, no core MCP, a user-initiated single step) so a plain turn and a
 * one-step thread behave the same.
 */
export async function prepareConversationRequest(
  opts: PrepareConversationRequestOptions,
): Promise<PreparedRequest> {
  const { sessionId, backendSessionId, sessionName, projectId } = opts.ids;
  const defaultAgentName = getDefaultAgent() || 'main';
  const agentConfig = resolveAgentSlotConfigByName(defaultAgentName);
  if (!agentConfig) throw new Error(`Unknown default agent: ${defaultAgentName}`);

  // USER.md profile is injected only on a session's FIRST turn (no backend session yet).
  // Session resume keeps it in history thereafter, so re-sending it every turn just wastes tokens.
  const isFreshSession = backendSessionId === null;
  // A thread-free conversation runs on the direct MCP surface — there is no thread to control.
  const spec: AgentSpec = fromAgentSlot(agentConfig, { mcpComposition: 'direct' });

  // A plain conversation turn is thread-free: no artifact, no previous step, no control-plane
  // preamble. Everything it does carry is a first-turn ambient block, and the two prompt-shaping
  // fields come from the very spec the run is opened with — one description of the agent, not two.
  const prompt = composeUserPrompt(spec, opts.userMessage, {
    userContext: userProfileBlock(isFreshSession),
    // Web UI direct sessions are bound to a project at create time; tell the agent which one
    // on the session's first turn (see resolveConversationProject for the exact gating).
    project: resolveConversationProject({ channel: opts.channel, projectId, isFreshSession }),
    // Commission sessions additionally get the contract + ledger index + protocol block, once per
    // binding rather than once per session (see resolveConversationCommission).
    commission: await resolveConversationCommission(sessionId, { isFreshSession }),
  });
  const backendPrompt = buildBackendPrompt(prompt, opts.files);
  opts.onPromptBuilt?.(backendPrompt);
  // Attribute cost/execution to the session's bound project (from the registry record), NOT a
  // re-derivation from the message text. A session created under project X stays project X even if
  // no message ever mentions X literally (that mismatch previously dumped everything into 'general').
  const project = projectId;

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
      sessionId,
      backendSessionId,
      // Hazard (a): the pool key must stay the channel, byte-identical to what every interactive
      // turn has opened its engine under — changing it would silently re-pool every live session.
      engineKey: opts.channel,
      sessionName,
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
      scheduleTaskId: opts.scheduleTaskId ?? null,
    },
    // The three fields that differ from the shared direct-run policy; every field NOT named here
    // is provably the `DIRECT_RUN_POLICY` value (background:'none' → this path's surface intent,
    // and browserCdpEndpoint:null → the session's opted-in Chrome, are the two it overrides).
    policy: {
      ...DIRECT_RUN_POLICY,
      background: conversationBackgroundPolicy(opts.channel),
      mcpToolAllowlist: agentConfig.mcpToolAllowlist,
      browserCdpEndpoint: opts.browserCdpEndpoint ?? null,
    },
  };

  return { request, backendPrompt };
}
