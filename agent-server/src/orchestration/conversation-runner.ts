//
// Why this exists: plain user chat messages used to be wrapped in a `templateName:'default'`
// ThreadRecord and run through runThread() with ~12 `isDefault` short-circuits. That coupled
// conversations to the thread machinery (workspace, artifact.md, threads.json) for no benefit —
// none of the thread concepts (artifact comms, transitions, hooks, multi-agent) apply to a single
// conversation turn. This module runs the default agent directly through `startRun`. Session
// continuity (channel session), cost/execution tracking and turn tracking (conversation ledger) are
// all thread-independent and handled by the caller (agent-runner).
//
// The request assembly itself lives in `conversation-request.ts`; what is left here is the
// run-opening half (resume-target sink, execution callbacks, awaiting the result), which Phase 1.4
// moves into the Turn object.

import type { PlatformAdapter, DownloadedFile } from '@platform/index.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { startRun } from '@domain/runs/service.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { RunObserver } from '@domain/runs/request.js';
import { createResumeTargetSink } from './resume-target-sink.js';
import { prepareConversationRequest } from './conversation-request.js';
import { Capability } from '../agent-adapter/capabilities.js';

// The prompt-assembly helpers moved to conversation-request.ts with `prepareConversationRequest`.
// Re-exported here so their existing importers (tests pin both) keep resolving against this module.
export {
  resolveConversationProject,
  resolveConversationCommission,
  prepareConversationRequest,
  type PreparedRequest,
  type ConversationSessionIds,
  type PrepareConversationRequestOptions,
} from './conversation-request.js';

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

/**
 * Whether this run's backend can open a continuation turn of its own (Claude does; PI's runs are
 * foreground-only). The hold decision uses it as the "there is something to hold for" gate that
 * used to be `typeof proc.setBackgroundTurnSink === 'function'`.
 *
 * Read off the run's capability set rather than its backend name: it is the same declaration the
 * backdrop is derived from, so a backend that grows a spontaneous turn says so in one place
 * (`CAPABILITIES_BY_BACKEND`) instead of here.
 */
export function supportsBackgroundContinuation(run: AgentRun): boolean {
  return run.capabilities.has(Capability.BackgroundContinuation);
}

export interface ConversationResult {
  result: AgentResult;
  executionId: string;
  /** The live run, so the caller can subscribe to its background phase. */
  run: AgentRun;
  /**
   * Whether this run's backend can produce a background continuation at all — the capability the
   * hold decision needs. It used to be probed off the process handle; the run answers it now.
   */
  canAwaitBackground: boolean;
}

/**
 * Execute a single plain user-conversation turn against the active default agent — no thread,
 * no workspace, no artifact.
 *
 * The execution record, the live-registry registration and the teardown are owned by `startRun`
 * (plan D8). This function opens the run assembled by `prepareConversationRequest` with the
 * caller's observers, and keeps the backend resume target on disk from the moment the backend names
 * itself — not merely when the turn settles, so a process killed mid-turn cannot orphan it.
 */
export async function runConversation(opts: RunConversationOptions): Promise<ConversationResult> {
  const { request } = await prepareConversationRequest({
    ids: {
      sessionId: opts.trackSessionId,
      backendSessionId: opts.backendSessionId,
      sessionName: opts.sessionName,
      projectId: opts.projectId,
    },
    channel: opts.channel,
    userMessage: opts.userMessage,
    files: opts.files,
    trigger: opts.trigger,
    scheduleTaskId: opts.scheduleTaskId,
    profileOverride: opts.profileOverride,
    browserCdpEndpoint: opts.browserCdpEndpoint,
    commissionTools: opts.commissionTools,
    commissionMode: opts.commissionMode,
    onPromptBuilt: opts.onPromptBuilt,
  });

  // The resume target is written the moment the backend names itself, not when the turn ends: a
  // process killed mid-turn never settles a run, and a first turn lost that way used to orphan its
  // transcript (see resume-target-sink.ts). The sink deduplicates, so a resumed turn writes nothing
  // unless the backend came back on a different session than the one it was asked to resume.
  let started: AgentRun | null = null;
  const resumeTarget = createResumeTargetSink({
    sessionName: opts.sessionName,
    resumedFrom: opts.backendSessionId,
    liveBackendSessionId: () => started?.backendSessionId ?? null,
  });
  const run = startRun(request, [...(opts.observers ?? []), resumeTarget]);
  started = run;
  // Claude mints its `--session-id` at spawn, so the id is already on the run here; PI names itself
  // a moment later and arrives through the sink's `engine_started`.
  resumeTarget.persist(run.backendSessionId);

  // Same observable points as the hand-rolled path: the execution record exists before the caller
  // awaits the turn, and registration has released the session lease. `startRun` creates and
  // registers the run synchronously, so firing these here is the earliest a caller can observe them.
  if (opts.onExecutionStarted) await opts.onExecutionStarted(run.executionId);
  opts.onExecutionRegistered?.();

  let result: AgentResult;
  try {
    result = await run.result;
  } finally {
    // Settle-time backstop for the early write (fix 9809d9a3's original job): an engine that never
    // announced its id still leaves a resume target behind, and a turn that ended on a different
    // backend session than it started on records the one the next turn must resume. Success-path
    // handleAgentSuccess still overwrites with the result's authoritative id.
    resumeTarget.persist(run.backendSessionId);
    await resumeTarget.drain();
  }

  return { result, executionId: run.executionId, run, canAwaitBackground: supportsBackgroundContinuation(run) };
}
