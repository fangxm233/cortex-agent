// input:  domain/agents (runAgent + config getters), domain/threads (agent-slot + prompt assembly),
//         domain/executions/registry, core/running-executions, domain/projects
// output: runConversation — executes a single plain user-conversation turn WITHOUT a thread
// pos:    orch/ — dedicated execution path for plain user messages (replaces the default-thread wrapper)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Why this exists: plain user chat messages used to be wrapped in a `templateName:'default'`
// ThreadRecord and run through runThread() with ~12 `isDefault` short-circuits. That coupled
// conversations to the thread machinery (workspace, artifact.md, threads.json) for no benefit —
// none of the thread concepts (artifact comms, transitions, hooks, multi-agent) apply to a single
// conversation turn. This module runs the default agent directly via the agent facade. Session
// continuity (channel session), cost/execution tracking (executionRegistry) and turn tracking
// (conversation ledger) are all thread-independent and handled by the caller (agent-runner).

import type { Destination, PlatformAdapter, MessageRef, DownloadedFile } from '@platform/index.js';
import type { AgentResult } from '@core/types/agent-types.js';
import {
  runAgent, getClaudeMode, getActiveProfile, getDefaultAgent, resolveBackendForChannel,
} from '@domain/agents/index.js';
import { resolveAgentSlotConfigByName, resolveSystemVars, buildConversationPrompt } from '@domain/threads/index.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { projectStore } from '@domain/projects/index.js';
import { runningExecutions } from '../core/running-executions.js';

export interface RunConversationOptions {
  adapter: PlatformAdapter;
  channel: string;
  /** The raw user message (without the default agent's directive). */
  userMessage: string;
  /** Stable Cortex tracking id for this session (UI identity, execution-record + publish key). */
  trackSessionId: string;
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
  /** Fired once the execution record is created, before the agent starts — lets the caller
   *  attach an execution-scoped Cancel button to the status message. */
  onExecutionStarted?: (executionId: string) => void | Promise<void>;
  onAssistantMessage?: ((text: string) => void) | null;
  onProgress?: ((progress: any) => void) | null;
  onFallback?: ((...args: any[]) => Promise<void>) | null;
  onToolUse?: ((name: string, input: any) => void) | null;
  onPlanWritten?: ((event: { path: string; content: string; toolUseId: string }) => void) | null;
  onAskUserQuestion?: ((event: any) => void) | null;
}

export interface ConversationResult {
  result: AgentResult;
  executionId: string;
  /** Underlying agent process for the turn. Used by the background-task continuation path to
   *  register a ContinuationSink on the (Claude) session. Opaque to other consumers. */
  agentProcess?: unknown;
}

/**
 * Execute a single plain user-conversation turn against the active default agent — no thread,
 * no workspace, no artifact. Mirrors the legacy default-thread branch of runThread() exactly
 * (channel session reuse, useCoreMcp:false, isUserInitiated:true, single step) and the
 * register/complete lifecycle of lifecycle.ts:runRetryAgent.
 *
 * Does NOT catch agent errors: the caller's try/catch (agent-runner._executeReal) invokes
 * handleAgentError, which finalizes the execution record and removes the running-execution
 * entry via runningExecutions.fail(executionId). On success this function removes the entry via
 * runningExecutions.complete(executionId); handleAgentSuccess finalizes the execution record.
 */
export async function runConversation(opts: RunConversationOptions): Promise<ConversationResult> {
  const defaultAgentName = getDefaultAgent() || 'main';
  const agentConfig = resolveAgentSlotConfigByName(defaultAgentName);
  if (!agentConfig) throw new Error(`Unknown default agent: ${defaultAgentName}`);

  // USER.md profile is injected only on a session's FIRST turn (no backend session yet).
  // Session resume keeps it in history thereafter, so re-sending it every turn just wastes tokens.
  const isFreshSession = opts.backendSessionId === null;
  const prompt = buildConversationPrompt(agentConfig, opts.userMessage, { includeUserContext: isFreshSession });
  const project = projectStore.resolveFromMessage(opts.userMessage)?.id ?? 'general';

  // Resolve profile: hardcoded agent profiles win; __active__ honors the optional override
  // (scheduler) then the channel's active profile.
  const profileName = agentConfig.profile === '__active__'
    ? (opts.profileOverride || getActiveProfile(opts.channel))
    : agentConfig.profile;

  const trigger = opts.trigger || 'user';
  // Execution record's backend must reflect the channel's active profile (e.g. 'pi' for deepseek),
  // not the global default — otherwise a pi turn is mislabeled 'claude'.
  const channelBackend = resolveBackendForChannel(opts.channel);
  const execution = executionRegistry.startLocalExecution({
    kind: trigger === 'scheduled' ? 'scheduled' : 'local',
    channel: opts.channel,
    project,
    trigger,
    backend: channelBackend,
    billingMode: getClaudeMode(),
    sessionId: opts.trackSessionId,
    label: prompt.substring(0, 60),
    scheduleTaskId: opts.scheduleTaskId || null,
    threadId: null,
    agentSlotId: null,
  });

  if (opts.onExecutionStarted) await opts.onExecutionStarted(execution.id);

  const handle = runAgent(prompt, {
    channel: opts.channel,
    executionId: execution.id,
    sessionId: opts.backendSessionId,   // backend resume target (null → backend self-assigns)
    trackSessionId: opts.trackSessionId, // stable Cortex id → CORTEX_SESSION_ID
    sessionKey: null, // falls back to channel key in the adapter
    files: opts.files || [],
    profileName,
    project,
    trigger,
    threadId: null,
    useCoreMcp: false,
    sessionName: opts.sessionName,
    claudeAgent: agentConfig.claudeAgent || null,
    systemPrompt: agentConfig.systemPrompt ? resolveSystemVars(agentConfig.systemPrompt) : null,
    outputStyle: agentConfig.outputStyle || null,
    tools: agentConfig.tools || null,
    pluginDirs: agentConfig.pluginDirs || null,
    onFallback: opts.onFallback ?? null,
    isUserInitiated: true,
    onAssistantMessage: opts.onAssistantMessage,
    onProgress: opts.onProgress,
    onToolUse: opts.onToolUse,
    onPlanWritten: opts.onPlanWritten ?? null,
    onAskUserQuestion: opts.onAskUserQuestion ?? null,
  });

  // Track the handle for cancellation under the channel key (preserves !cancel / supersede /
  // killByKey paths); executionId is indexed too so the Cancel button can resolve it.
  runningExecutions.register({
    threadId: null,
    channel: opts.channel,
    agentSlotId: null,
    executionId: execution.id,
    kind: execution.kind,
    kill: () => handle.kill(),
    backend: channelBackend,
    agentProcess: handle.agentProcess,
    sessionId: handle.sessionId,
  });

  const result = await handle.promise;

  // Finalize the execution here (persistent record + registry teardown + balanced agent.* event)
  // so this function is self-contained and serves both the interactive path (agent-runner) and
  // the scheduler. teardownExecution is idempotent (execution-repo guards terminal status), so the
  // interactive path's later handleAgentSuccess→finalizeLocalExecution call is a harmless no-op.
  const durationS = (Date.now() - opts.startTime) / 1000;
  if (result?.rateLimited) {
    executionRegistry.teardownExecution({ executionId: execution.id, status: 'failed', durationS, error: { message: 'Rate limited' } });
  } else {
    executionRegistry.teardownExecution({ executionId: execution.id, status: 'completed', durationS, result });
  }

  return { result, executionId: execution.id, agentProcess: handle.agentProcess };
}
