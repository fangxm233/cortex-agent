// input:  thread state, task generation, agents, throttle, hooks
// output: task-aware thread runs, outage resume, and transcripts
// pos:    Runs thread steps, controls, hooks, and resumes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { threadStore } from '@store/thread-repo.js';
import {
  resolveNextStep,
  buildStepPrompt,
  beginStepSession,
  recordStepResult,
  evaluateTransitions,
  completeThread,
  failThread,
  markThreadRateLimited,
  abortThread,
  peekPendingControl,
  clearPendingControl,
  tryEnterWaiting,
  checkContractBudget,
  isAdHocThread,
  getSessionKey,
  getTemplate,
  readArtifact,
  resolveSystemVars,
  type PendingControl,
} from './index.js';
import {
  runAgent,
  getClaudeMode,
  getActiveBackend,
  getActiveProfile,
  resolveRateLimitProvider,
} from '../agents/index.js';
import { isApiRateLimitError, isRetryableError } from '../agents/config.js';
import { resolveProfileConfig } from '../agents/profile-manager.js';
import {
  activateOutageWindow,
  isProviderRateLimited,
  isProviderUsageRateLimited,
} from '../costs/rate-limit-throttle.js';
import { recordResume, removeThreadResume } from '../costs/resume-registry.js';
import { Icons } from '../../core/icons.js';
import { closeSessionsByPrefix } from '../agents/index.js';
import * as executionRegistry from '../executions/registry.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { formatDurationCompact } from '@core/utils.js';
import { buildThreadStatusMessage } from '@core/status-format.js';
import type { OutputStream } from '@platform/index.js';
import { runningExecutions } from '../../core/running-executions.js';
import type { RunningExecution } from '../../core/running-executions.js';
import { executeLifecycleHooks } from './hook-runner.js';
import { createToolTrace } from '@platform/index.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { createStepTranscriptRecorder, type StepTranscriptRecorder } from './thread-transcript.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { createLogger } from '@core/log.js';
import type {
  ThreadRecord,
  AgentSlotId,
  AgentSlotConfig,
  ThreadTemplate,
  RunThreadOptions,
} from '@core/types/thread-types.js';

const log = createLogger('thread-runner');
const OUTAGE_BACKOFF_MS = [5, 15, 45].map((minutes) => minutes * 60_000);
const OUTAGE_MAX_RESUMES = OUTAGE_BACKOFF_MS.length;

// --- Result types ---

interface ThreadRunResult {
  thread: ThreadRecord;
  /** Final output from the last completed step (for Slack display) */
  finalOutput: string | null;
  /** Aggregated cost across all steps */
  totalCostUsd: number;
  /** Total number of turns across all steps */
  totalNumTurns: number;
  /** The result object from the last agent call (for backward compat with handleAgentSuccess) */
  lastAgentResult: any;
  /** The execution ID from the last completed step — used by handleAgentSuccess in the wrapper. */
  executionId: string | null;
}

// --- Internal context types ---

/** Outer-scope state shared across the whole runThread() lifecycle. */
interface ThreadContext {
  thread: ThreadRecord;
  template: ThreadTemplate | null;
  meta: ThreadRecord['metadata'];
  stream: OutputStream;
  lastAgentResult: any;
  totalNumTurns: number;
  /** Set when a step was interrupted by a provider throttle.
   *  Pauses the thread (status='rate_limited') instead of completing/failing it. */
  rateLimited?: boolean;
}

/** Per-step config built once by buildStepConfig — fully populated, no placeholders. */
interface StepContext {
  agentSlotId: AgentSlotId;
  agentConfig: AgentSlotConfig;
  isFirstStep: boolean;
  multiAgent: boolean;
  /** Stage this step runs. Null for single-stage agents (no `stages` map declared). */
  stage: string | null;
  prompt: string;
  /** True when this step re-enters an interrupted attempt's backend session: the prompt is the
   *  continuation reminder, and first-step files are not re-attached. */
  interruptedResume: boolean;
  /** Flipped by the step callbacks on the first streamed assistant/tool event. Gates capturing
   *  the interrupted backend session — an attempt with no activity has nothing worth resuming. */
  sawActivity: boolean;
  /** Backend `--resume` target (slot.backendSessionId via beginStepSession); null → fresh. */
  resumeSessionId: string | null;
  /** Stable Cortex track id (slot.sessionId, minted at step start) — the conversation-history /
   *  UI transcript key + CORTEX_SESSION_ID. Known BEFORE the agent spawns, so the web UI can
   *  query/stream the running step. */
  trackSessionId: string;
  sessionKey: string | null;
  sessionName: string;
  profileName: string;
  execution: { id: string; [k: string]: any };
  /** Always set in buildStepConfig — never an empty placeholder. */
  stepStartTime: string;
  /** Live per-event transcript recorder keyed by trackSessionId: appends each streamed
   *  assistant/tool event to conversation-history immediately + publishes session.message
   *  (shared ts) — the running step streams into the UI and survives reloads/restarts. */
  recorder: StepTranscriptRecorder;
}

/** Per-step callbacks resolved from opts/vm by setupStepCallbacks. */
interface StepCallbacks {
  onAssistantMessage: ((text: string) => void) | null | undefined;
  onProgress: ((progress: any) => void) | null;
  onToolUse: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult: ((toolUseId: string, content: string, isError: boolean) => void) | null;
}

type StepInfo = Pick<StepContext, 'agentSlotId' | 'agentConfig' | 'isFirstStep' | 'multiAgent' | 'stage'>;

/** Render `agent` or `agent:stage` for log/status display — matches the transition endpoint syntax
 *  used in thread-templates.json transitions. Falls back to bare agent name when stage is null. */
function formatAgentStageLabel(agentSlotId: AgentSlotId, stage: string | null): string {
  return stage ? `${agentSlotId}:${stage}` : agentSlotId;
}

/** Validate thread, load template/metadata, init the aggregating OutputStream. */
function initThreadContext(threadId: string, opts: RunThreadOptions): ThreadContext {
  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const template = thread.templateName ? (getTemplate(thread.templateName) || null) : null;
  // Aggregate agent output into an OutputStream. The caller supplies the Destination
  // (interactive-reply or project-report).
  // Pass the full statusMsg as anchorRef so CompositeAdapter can resolve a per-platform
  // thread anchor for each sub-stream (a Slack ts must not be used as a Feishu message_id).
  const stream = opts.adapter.openOutputStream(opts.destination, { threadId: opts.threadAnchorId, anchorRef: opts.statusMsg });
  return { thread, template, meta: thread.metadata, stream, lastAgentResult: null, totalNumTurns: 0 };
}

/** Resolve next step, post boundary notifications, update the status message.
 *  Returns null if the loop should break (cancelled, no next step). */
async function resolveAndNotifyStep(
  threadId: string,
  ctx: ThreadContext,
  opts: RunThreadOptions,
): Promise<StepInfo | null> {
  // Check if thread was cancelled externally
  const current = threadStore.get(threadId);
  if (!current || current.status === 'cancelled') return null;

  // Resolve the next step
  const nextStep = resolveNextStep(threadId);
  if (!nextStep) {
    await completeThread(threadId);
    return null;
  }

  const { agentSlotId, agentConfig, isFirstStep, stage } = nextStep;
  const threadRecord = threadStore.get(threadId)!;
  const multiAgent = Object.keys(threadRecord.agents).length > 1;
  const label = formatAgentStageLabel(agentSlotId, stage);

  // Post step boundary notification for multi-agent threads via OutputStream
  if (ctx.stream && multiAgent && !isFirstStep) {
    const prevStep = threadRecord.steps[threadRecord.steps.length - 1];
    const prevLabel = prevStep ? formatAgentStageLabel(prevStep.agentSlotId, prevStep.stage) : '?';
    ctx.stream.emitText(`${Icons.arrowRight} Step ${threadRecord.currentStepIndex + 1}: *${label}* starting (prev: ${prevLabel})`);
  }

  // Update status message (multi-agent thread format; skip if caller provides onProgress)
  if (ctx.stream && multiAgent && !opts.onProgress) {
    const elapsed = (Date.now() - opts.startTime) / 1000;
    const statusText = buildThreadStatusMessage({
      threadId: threadRecord.id,
      stepNumber: threadRecord.currentStepIndex + 1,
      label,
      elapsedS: elapsed,
      taskProject: threadRecord.metadata?.taskProject ?? null,
      taskId: threadRecord.metadata?.taskId ?? null,
      taskText: threadRecord.metadata?.taskText ?? null,
    });
    try {
      if (opts.statusMsg) {
        await opts.adapter.updateMessage(opts.statusMsg, { text: statusText });
      }
    } catch {}
  }

  return { agentSlotId, agentConfig, isFirstStep, multiAgent, stage };
}

function resolveEffectiveProfileName(
  configuredProfile: string,
  meta: ThreadRecord['metadata'],
  channel: string,
): string {
  return configuredProfile === '__active__'
    ? (meta?.profileOverride || getActiveProfile(channel))
    : configuredProfile;
}

function resolveActiveStepProvider(thread: ThreadRecord, channel: string): string | null {
  const slot = thread.agents[thread.activeAgent];
  if (!slot) return null;
  try {
    const profileName = resolveEffectiveProfileName(slot.profile, thread.metadata, channel);
    return resolveRateLimitProvider(resolveProfileConfig(profileName));
  } catch {
    return null;
  }
}

/** Build prompt, resolve session config, profile, register execution, generate session name + start time.
 *  Returns a fully-populated StepContext — no placeholder fields. */
async function buildStepConfig(
  threadId: string,
  stepInfo: StepInfo,
  ctx: ThreadContext,
  opts: RunThreadOptions,
): Promise<StepContext> {
  const { agentSlotId, agentConfig, isFirstStep, multiAgent, stage } = stepInfo;

  // Interrupted-step rerun: a pending interruptedBackendSessionId (set at interruption, consumed
  // by beginStepSession below) switches the prompt to the continuation reminder.
  const interruptedResume = !!threadStore.get(threadId)?.agents[agentSlotId]?.interruptedBackendSessionId;

  // Build prompt for this step — pass the stage so stage-aware agents send their stage-specific
  // prompt (and, in incremental mode on session resume, skip directive + preamble + auto previousOutput).
  // ORDER MATTERS: buildStepPrompt reads slot.sessionId truthiness as "resuming a persistent
  // session" — it must run BEFORE beginStepSession mints the track id, or a fresh slot's first
  // step would be misdetected as a resume and skip its directive.
  const prompt = buildStepPrompt(threadId, agentConfig, stage, { interruptedResume });

  // Session identity (track/backend decoupling): mint + persist the stable track id on the slot
  // (the UI transcript key, visible to threads.get while the step RUNS) and resolve the backend
  // resume target. Publishes thread.step.started.
  const { trackSessionId, resumeSessionId } = await beginStepSession(threadId, agentSlotId, stage);

  // Thread steps use a thread-scoped session key.
  const sessionKey = getSessionKey(threadId, agentSlotId);

  // Resolve profile: agents with a hardcoded profile always use their own declaration.
  // metadata.profileOverride only applies to __active__ agents (default/main/scheduler-main),
  // letting scheduler/dispatch inject a concrete profile without overriding research-pipeline agents.
  const profileName = resolveEffectiveProfileName(agentConfig.profile, ctx.meta, opts.channel);

  // Register execution
  const executionKind = ctx.meta?.trigger === 'task-dispatch' ? 'dispatch'
    : ctx.meta?.trigger === 'scheduled' ? 'scheduled'
    : 'local';
  const executionTrigger = ctx.meta?.trigger || 'thread-step';
  const label = formatAgentStageLabel(agentSlotId, stage);
  const execution = executionRegistry.startLocalExecution({
    kind: executionKind,
    channel: opts.channel,
    project: threadStore.get(threadId)?.projectId ?? 'general',
    trigger: executionTrigger,
    backend: getActiveBackend(),
    billingMode: getClaudeMode(),
    sessionId: trackSessionId,
    label: `[${label}] ${prompt.substring(0, 40)}`,
    scheduleTaskId: ctx.meta?.scheduleTaskId || null,
    threadId,
    agentSlotId,
  });

  // Live transcript recorder: every streamed event appends to conversation-history (keyed by
  // the track id) AND publishes session.message with the same ts — snapshot + delta for the UI.
  const recorder = createStepTranscriptRecorder(conversationHistory, trackSessionId, (ev) => {
    jobCtx.bus?.publish({
      type: 'session.message',
      sessionId: trackSessionId,
      channel: opts.channel,
      role: ev.role,
      text: ev.text ?? '',
      ...(ev.toolName !== undefined ? { toolName: ev.toolName } : {}),
      ...(ev.toolInput !== undefined ? { toolInput: ev.toolInput } : {}),
      ts: ev.ts,
    });
  }, () => {
    jobCtx.bus?.publish({ type: 'session.debug.updated', sessionId: trackSessionId, channel: opts.channel });
  });
  // The step prompt opens the turn — recorded now so a reload mid-step shows it.
  recorder.recordUser(prompt);

  return {
    agentSlotId, agentConfig, isFirstStep, multiAgent, stage,
    prompt, interruptedResume, sawActivity: false, resumeSessionId, trackSessionId, sessionKey,
    sessionName: await sessionStore.generateSessionName(),
    profileName, execution,
    stepStartTime: new Date().toISOString(),
    recorder,
  };
}

/** Resolve onAssistantMessage/onProgress callbacks and mark slot as running.
 *  Returns the callbacks instead of mutating the StepContext. */
function setupStepCallbacks(
  threadId: string,
  stepCtx: StepContext,
  ctx: ThreadContext,
  opts: RunThreadOptions,
): StepCallbacks {
  const { agentSlotId, multiAgent, stage } = stepCtx;
  const threadRecord = threadStore.get(threadId)!;
  const slot = threadRecord.agents[agentSlotId];
  const stream = ctx.stream;
  const label = formatAgentStageLabel(agentSlotId, stage);

  // Aggregate assistant output into the thread-runner's OutputStream; prefix only for multi-agent.
  const slotPrefix = multiAgent ? `*[${label}]*` : null;
  const baseAssistantMessage = (text: string) => { stream.emitText(slotPrefix ? `${slotPrefix} ${text}` : text); };

  // Tool trace (env-gated): emit a compact per-tool line to the runner's stream when
  // CORTEX_SHOW_TOOL_CALLS is on, while STILL firing any caller-supplied onToolUse
  // (interactive plan/ask capture). Both must run — compose, don't choose — so dispatch /
  // scheduled / webhook threads stream tool calls like a direct session. The trace fires
  // first; the caller (interactive) fires after, preserving the onToolUse-before-ask ordering.
  const callerOnToolUse = opts.onToolUse ?? null;
  const toolTrace = createToolTrace(stream, { slotPrefix });
  const streamAssistantMessage = toolTrace
    ? (text: string) => { toolTrace.flush(); baseAssistantMessage(text); }
    : baseAssistantMessage;
  const traceToolUse = toolTrace ? (name: string, input: any, _toolUseId: string) => toolTrace.onToolUse(name, input) : null;
  const composedToolUse: ((name: string, input: any, toolUseId: string) => void) | null =
    traceToolUse && callerOnToolUse
      ? (name: string, input: any, toolUseId: string) => { traceToolUse(name, input, toolUseId); callerOnToolUse(name, input); }
      : (traceToolUse ?? callerOnToolUse);

  // Transcript recording: mirror the direct path — every assistant message + tool call is
  // appended to conversation-history IMMEDIATELY (keyed by the step's track sessionId) and
  // published as a session.message delta, so the UI streams the running step and a reload
  // shows everything so far. Recording wraps (never replaces) the display callbacks, so
  // streaming/tool-trace behaviour is unchanged.
  const recorder = stepCtx.recorder;
  const onAssistantMessage = (text: string) => {
    if (text) stepCtx.sawActivity = true;
    streamAssistantMessage(text);
    if (text) recorder.recordAssistant(text);
  };
  const onToolUse = (name: string, input: any, toolUseId: string) => {
    stepCtx.sawActivity = true;
    composedToolUse?.(name, input, toolUseId);
    recorder.recordTool(name, input, toolUseId);
  };
  const onToolResult = (toolUseId: string, content: string, isError: boolean) => {
    recorder.recordToolResult(toolUseId, content, isError);
  };

  // onProgress: caller override (e.g. scheduler's buildUserProcessingMessage) takes precedence;
  // fallback to thread-specific status format for multi-agent pipelines
  const onProgress = opts.onProgress
    || (multiAgent
      ? (progress: any) => {
          const elapsed = (Date.now() - opts.startTime) / 1000;
          if (opts.statusMsg) {
            opts.adapter.updateMessage(opts.statusMsg, {
              text: buildThreadStatusMessage({
                threadId: threadRecord.id,
                stepNumber: threadRecord.currentStepIndex + 1,
                label,
                elapsedS: elapsed,
                numTurns: progress?.num_turns ?? null,
                taskProject: threadRecord.metadata?.taskProject ?? null,
                taskId: threadRecord.metadata?.taskId ?? null,
                taskText: threadRecord.metadata?.taskText ?? null,
              }),
            }).catch(() => {});
          }
        }
      : null);

  // Mark agent slot as running
  slot.status = 'running';
  threadStore.set(threadRecord);

  return { onAssistantMessage, onProgress, onToolUse, onToolResult };
}

/** Run the agent, manage handle, await result; fail execution + rethrow on error.
 *  Returns the agent result. */
async function executeAndAwaitAgent(
  threadId: string,
  stepCtx: StepContext,
  callbacks: StepCallbacks,
  ctx: ThreadContext,
  opts: RunThreadOptions,
): Promise<any> {
  const { agentConfig, isFirstStep, prompt, resumeSessionId, trackSessionId, sessionKey, profileName, execution, stepStartTime } = stepCtx;
  const meta = ctx.meta;

  const handle = runAgent(prompt, {
    channel: opts.channel,
    executionId: execution.id,
    sessionId: resumeSessionId,
    trackSessionId,
    sessionKey,
    // Interrupted rerun: the resumed session already received the first-step files.
    files: isFirstStep && !stepCtx.interruptedResume ? (opts.files || []) : [],
    profileName,
    project: threadStore.get(threadId)?.projectId,
    trigger: meta?.trigger || undefined,
    threadId,
    threadDepth: meta?.depth ?? 0,
    taskId: meta?.taskId ?? null,
    taskProject: meta?.taskProject ?? null,
    taskGeneration: meta?.dispatchGeneration ?? null,
    useCoreMcp: true,
    sessionName: stepCtx.sessionName,
    claudeAgent: agentConfig.claudeAgent || null,
    systemPrompt: agentConfig.systemPrompt ? resolveSystemVars(agentConfig.systemPrompt) : null,
    outputStyle: agentConfig.outputStyle || null,
    tools: agentConfig.tools || null,
    pluginDirs: agentConfig.pluginDirs || null,
    onFallback: null,
    isUserInitiated: false,
    onAssistantMessage: callbacks.onAssistantMessage,
    onProgress: callbacks.onProgress,
    onToolUse: callbacks.onToolUse,
    onToolResult: callbacks.onToolResult,
    onPlanWritten: opts.onPlanWritten ?? null,
    onAskUserQuestion: opts.onAskUserQuestion ?? null,
  });

  // Track handle for cancellation
  runningExecutions.register({
    threadId,
    channel: opts.channel,
    agentSlotId: stepCtx.agentSlotId,
    executionId: stepCtx.execution.id,
    kind: stepCtx.execution.kind,
    kill: () => handle.kill(),
    backend: getActiveBackend(),
    agentProcess: handle.agentProcess,
    sessionId: handle.sessionId,
  });

  try {
    // On success the registry entry stays live until recordStepOutcome tears it down
    // (so the agent.completed event fires there). On error we tear down here.
    return await handle.promise;
  } catch (agentError: any) {
    // Finalize execution as failed (persistent record + registry + agent.failed event)
    // so it doesn't stay stuck in 'running' and the dashboards see a balanced lifecycle.
    const failDurationS = (Date.now() - new Date(stepStartTime).getTime()) / 1000;
    executionRegistry.teardownExecution({
      executionId: execution.id,
      status: 'failed',
      durationS: failDurationS,
      error: { message: agentError?.message || 'Agent process error' },
    });
    // Carry the interrupted attempt's identity to the thrown-path pause handler
    // (pauseRetryableProviderError) so a retryable outage can resume this session.
    if (agentError && typeof agentError === 'object') {
      agentError.interruptedStep = {
        agentSlotId: stepCtx.agentSlotId,
        backendSessionId: handle.sessionId ?? null,
        sawActivity: stepCtx.sawActivity,
      };
    }
    throw agentError;
  }
}

/** Record step result, register session, finalize execution; update aggregate counters. */
async function recordStepOutcome(
  threadId: string,
  stepCtx: StepContext,
  result: any,
  ctx: ThreadContext,
  opts: RunThreadOptions,
): Promise<void> {
  const { agentSlotId, prompt, sessionName, execution, stepStartTime, stage } = stepCtx;
  ctx.lastAgentResult = result;

  // Record the step result
  const stepEndTime = new Date().toISOString();
  const stepDurationS = (new Date(stepEndTime).getTime() - new Date(stepStartTime).getTime()) / 1000;

  // Rate-limit interruption (graceful path): the API window is exhausted and the throttle is
  // active. Do NOT record the step result — leaving currentStepIndex unadvanced so resume
  // re-runs THIS step (matches the thrown path). Tear down the execution as failed and pause the
  // thread for auto-resume. Require this result's provider throttle to be active so another
  // provider cannot create a resume entry whose reset callback will never own it.
  // NOTE: the live recorder has already persisted this step's streamed events — an interrupted
  // step is partially recorded (honest history); the re-run opens a fresh prompt turn.
  if (result?.rateLimited && isProviderRateLimited(result.rateLimitProvider)) {
    executionRegistry.teardownExecution({
      executionId: execution.id, status: 'failed', durationS: stepDurationS,
      error: { message: 'Rate limited' },
    });
    await handleRateLimitInterruption(threadId, ctx, opts, result.rateLimitProvider ?? null, {
      agentSlotId, backendSessionId: result?.sessionId ?? null, sawActivity: stepCtx.sawActivity,
    });
    return;
  }

  // Ensure the incrementally-appended transcript is durable before the step is sealed
  // (settle never rejects — failed appends are logged and skipped).
  await stepCtx.recorder.settle();

  await recordStepResult(threadId, agentSlotId, {
    sessionId: stepCtx.trackSessionId,
    backendSessionId: result?.sessionId || null,
    sessionName,
    executionId: execution.id,
    input: prompt,
    startedAt: stepStartTime,
    output: result?.finalOutput || null,
    costUsd: result?.total_cost_usd || null,
    numTurns: result?.num_turns || null,
    durationS: stepDurationS,
    stage,
  });

  ctx.totalNumTurns += result?.num_turns || 0;

  // Register session under the TRACK id — the same key the live transcript is recorded under
  // (sessions.transcript / session.message), so the thread session renders in the UI.
  const currentThread = threadStore.get(threadId);
  if (sessionName && currentThread) {
    await sessionStore.registerSession(sessionName, {
      sessionId: stepCtx.trackSessionId,
      channel: opts.channel,
      backend: getActiveBackend(),
      kind: 'local',
      origin: 'thread',
      label: `[${threadId}:${agentSlotId}]`,
      profileName: getActiveProfile(opts.channel),
      projectId: currentThread.projectId,
    });
  }

  // Finalize execution: persistent record + registry teardown + balanced agent.* event.
  if (result?.rateLimited) {
    executionRegistry.teardownExecution({
      executionId: execution.id, status: 'failed', durationS: stepDurationS,
      error: { message: 'Rate limited' },
    });
  } else {
    executionRegistry.teardownExecution({
      executionId: execution.id, status: 'completed', durationS: stepDurationS, result,
    });
  }
}

/** Identity of the attempt a provider interruption cut short, captured at the interruption
 *  point so the rerun can resume its backend session. */
interface InterruptedStepInfo {
  agentSlotId: AgentSlotId;
  backendSessionId: string | null;
  sawActivity: boolean;
}

/** Pause the thread for auto-resume after a provider throttle interrupted a step. Records the
 *  thread in the resume registry (drained when its provider window resets) and
 *  flips it to the non-terminal 'rate_limited' status. Sets ctx.rateLimited so the loop breaks
 *  and skips completeThread / onEnd. Shared by the graceful (recordStepOutcome) and thrown
 *  (runThread catch) paths. When the interrupted attempt streamed real activity, its backend
 *  session id is persisted on the slot so the rerun resumes it instead of restarting the step. */
async function handleRateLimitInterruption(
  threadId: string,
  ctx: ThreadContext,
  opts: RunThreadOptions,
  provider: string | null,
  interrupted?: InterruptedStepInfo | null,
): Promise<boolean> {
  if (!await markThreadRateLimited(threadId, provider)) return false;
  ctx.rateLimited = true;
  if (interrupted?.backendSessionId && interrupted.sawActivity) {
    await threadStore.mutate(threadId, (record) => {
      const slot = record.agents[interrupted.agentSlotId];
      if (slot) slot.interruptedBackendSessionId = interrupted.backendSessionId;
    });
  }
  recordResume({
    kind: 'thread', provider, threadId, channel: opts.channel,
    userMessage: threadStore.get(threadId)?.userMessage ?? '', recordedAt: Date.now(),
  });
  return true;
}

/** Decide whether the loop continues; run onTransition hook when transitioning.
 *  Returns false to break the loop. */
async function evaluateAndTransition(
  threadId: string,
  stepCtx: StepContext,
  ctx: ThreadContext,
  opts: RunThreadOptions,
): Promise<boolean> {
  // Ad-hoc threads: run one agent per invocation, then stop
  if (isAdHocThread(threadId)) return false;

  // Evaluate transitions for template-based multi-agent
  const transition = evaluateTransitions(threadId);
  if (!transition.shouldTransition) return false;
  // transition.nextAgent / nextStage are already set on the thread by evaluateTransitions

  const prevAgent = stepCtx.agentSlotId;
  const fromLabel = formatAgentStageLabel(prevAgent, stepCtx.stage);
  const toLabel = formatAgentStageLabel(transition.nextAgent!, transition.nextStage ?? null);
  await executeLifecycleHooks(
    threadId,
    'transition',
    {
      template: ctx.template?.hooks?.onTransition,
      extra: opts.extraHooks?.onTransition,
    },
    opts,
    prevAgent,
    `(${fromLabel} → ${toLabel})`,
  );
  return true;
}

/** Read final artifact, flush VM, build the run result. */
async function finalizeThread(threadId: string, ctx: ThreadContext): Promise<ThreadRunResult> {
  const finalThread = threadStore.get(threadId)!;

  // Final output comes from the artifact file
  const artifactContent = readArtifact(threadId);
  const finalOutput = artifactContent || ctx.lastAgentResult?.finalOutput || null;

  if (ctx.stream && finalOutput) {
    ctx.stream.emitText(finalOutput);
    await ctx.stream.flush();
  }

  return {
    thread: finalThread,
    finalOutput,
    totalCostUsd: finalThread.totalCostUsd,
    totalNumTurns: ctx.totalNumTurns,
    lastAgentResult: ctx.lastAgentResult,
    executionId: finalThread.steps[finalThread.steps.length - 1]?.executionId ?? null,
  };
}

/** Terminate a thread by agent abort and, BEFORE onEnd hooks run, hand the owning task to the
 *  caller's onAbort so it can reach a terminal (blocked) state in time (DR-0015 problem 2).
 *  No-op on the task side for non-dispatch threads (metadata has no taskId) or when the caller
 *  did not inject onAbort. Exported for unit testing. */
export async function finalizeAbortedThread(
  threadId: string,
  meta: ThreadRecord['metadata'],
  reason: string | null,
  opts: Pick<RunThreadOptions, 'onAbort'>,
): Promise<void> {
  await abortThread(threadId, reason);
  const taskId = meta?.taskId ?? null;
  if (taskId && opts.onAbort) {
    await opts.onAbort({ taskId, project: meta?.taskProject ?? null, reason });
  }
}

async function claimOutageResume(threadId: string, error: string): Promise<number | null> {
  let claimedCount: number | null = null;
  let capped = false;
  await threadStore.mutate(threadId, (record) => {
    if (record.status !== 'running' && record.status !== 'rate_limited') return;
    const current = record.metadata?.outageResumeCount ?? 0;
    if (current >= OUTAGE_MAX_RESUMES) {
      record.status = 'failed';
      record.error = error;
      record.endedAt = new Date().toISOString();
      capped = true;
      return;
    }
    (record.metadata ??= {}).outageResumeCount = current + 1;
    claimedCount = current;
  });
  if (capped) {
    await failThread(threadId, error);
    removeThreadResume(threadId);
  }
  return claimedCount;
}

async function failOutageActivation(
  threadId: string,
  providerError: Error & { cause?: unknown },
  activationError: unknown,
): Promise<never> {
  await threadStore.mutate(threadId, (record) => {
    const count = record.metadata?.outageResumeCount ?? 0;
    if (count > 0) record.metadata!.outageResumeCount = count - 1;
  });
  const cause = activationError instanceof Error ? activationError.message : String(activationError);
  if (threadStore.get(threadId)?.status === 'running') {
    await failThread(threadId, `${providerError.message}; outage activation failed: ${cause}`);
  }
  providerError.cause = activationError;
  throw providerError;
}

async function pauseRetryableProviderError(
  threadId: string,
  ctx: ThreadContext,
  opts: RunThreadOptions,
  error: Error & { rateLimitProvider?: string; cause?: unknown; interruptedStep?: InterruptedStepInfo },
): Promise<boolean> {
  const thread = threadStore.get(threadId);
  const resumableStatus = thread?.status === 'running' || thread?.status === 'rate_limited';
  if (!thread || !resumableStatus || !isRetryableError(error)) return false;
  const provider = error.rateLimitProvider ?? resolveActiveStepProvider(thread, opts.channel);
  const interrupted = error.interruptedStep ?? null;
  if (isApiRateLimitError(error.message) && isProviderUsageRateLimited(provider)) {
    return handleRateLimitInterruption(threadId, ctx, opts, provider, interrupted);
  }
  const resumeCount = await claimOutageResume(threadId, error.message);
  if (resumeCount === null) return false;
  try {
    await activateOutageWindow(provider, OUTAGE_BACKOFF_MS[resumeCount]);
  } catch (activationError) {
    await failOutageActivation(threadId, error, activationError);
  }
  return handleRateLimitInterruption(threadId, ctx, opts, provider, interrupted);
}

async function runThread(threadId: string, opts: RunThreadOptions): Promise<ThreadRunResult> {
  const ctx = initThreadContext(threadId, opts);
  let enteredWaiting = false;

  try {
    await executeLifecycleHooks(threadId, 'start', {
      template: ctx.template?.hooks?.onStart,
      extra: opts.extraHooks?.onStart,
    }, opts);

    while (true) {
      const stepInfo = await resolveAndNotifyStep(threadId, ctx, opts);
      if (!stepInfo) break;

      const stepCtx = await buildStepConfig(threadId, stepInfo, ctx, opts);
      const callbacks = setupStepCallbacks(threadId, stepCtx, ctx, opts);
      const result = await executeAndAwaitAgent(threadId, stepCtx, callbacks, ctx, opts);
      await recordStepOutcome(threadId, stepCtx, result, ctx, opts);

      // Rate-limit pause (graceful path): recordStepOutcome paused the thread. Break out so the
      // thread is NOT completed; resume-dispatcher re-enters it when its provider resets.
      if (ctx.rateLimited) break;

      // Out-of-band control plane (DR-0015 problem 1): the agent signals abort / split / wait by
      // calling the thread_abort / thread_split / thread_wait MCP tools, which write a typed
      // metadata.pendingControl on this thread. Read it here at the step boundary — never scan the
      // artifact (prose mentioning "[ABORT]" no longer triggers anything). Higher precedence than
      // transitions.
      const control = peekPendingControl(threadId);

      // Agent-initiated abort. Global check. Loop exits → onEnd hook still fires.
      if (control?.action === 'abort') {
        await clearPendingControl(threadId);
        const reason = control.diagnosis ?? null;
        // Abort the thread and block its owning task before end hooks inspect task state.
        await finalizeAbortedThread(threadId, ctx.meta, reason, opts);
        if (ctx.stream) {
          const reasonStr = reason ? `: ${reason}` : '';
          const abortLabel = formatAgentStageLabel(stepCtx.agentSlotId, stepCtx.stage);
          ctx.stream.emitText(`${Icons.stopped} Thread aborted by *${abortLabel}*${reasonStr}`);
        }
        break;
      }

      // Split proposal (DR-0014): the worker called thread_split with a typed subtask array. Leave
      // metadata.pendingControl IN PLACE (do NOT clear) and break — the thread terminates and the
      // dispatch path (processSplitOutcome) consumes control.subtasks to decompose keep-parent.
      if (control?.action === 'split') {
        if (ctx.stream) {
          const splitLabel = formatAgentStageLabel(stepCtx.agentSlotId, stepCtx.stage);
          const n = Array.isArray(control.subtasks) ? control.subtasks.length : 0;
          ctx.stream.emitText(`${Icons.arrowRight} Thread split by *${splitLabel}* into ${n} subtask(s)`);
        }
        break;
      }

      // Parent suspension (DR-0014): the agent called thread_wait. Checked after abort/split,
      // before transitions. Three outcomes:
      //  - live awaited children remain → thread enters 'waiting' (resumed by thread-callback
      //    when the last child turns terminal); skip onEnd — it fires once, at true termination.
      //  - all awaited children already terminal (callback won the race) and their results sit
      //    in pendingMessages → re-enter the loop immediately so the same agent processes them.
      //  - signal but nothing to wait on or process → fall through to normal transitions.
      if (control?.action === 'wait') {
        if (await consumeWaitControl(threadId, control)) {
          enteredWaiting = true;
          // DR-0014 lock hygiene: release any project lock this execution still holds BEFORE
          // suspending. A manager that ran `decompose --auto-lock` (which does not auto-release)
          // would otherwise hold the lock across the whole child-wait — starving sibling
          // managers — and the terminal auto-release can't recover it (re-entry completes under
          // a new executionId that no longer matches the original owner). See registry.ts.
          executionRegistry.releaseExecutionLocks(stepCtx.execution.id);
          const n = threadStore.get(threadId)?.metadata?.waitingOn?.length ?? 0;
          if (ctx.stream) ctx.stream.emitText(`${Icons.processing} Thread suspended — waiting on ${n} child thread(s)`);
          break;
        }
        const t = threadStore.get(threadId);
        if (t?.metadata?.pendingMessages?.length) {
          // Ad-hoc parents bypass transition evaluation, so the contract budget breaker
          // must gate the re-entry loop here (template threads get it in checkTemplateLimits).
          if (t && checkContractBudget(t)) {
            if (ctx.stream) ctx.stream.emitText(`${Icons.warning} Contract budget exhausted — not re-entering wait loop`);
          } else {
            continue;
          }
        }
      }

      if (!await evaluateAndTransition(threadId, stepCtx, ctx, opts)) break;
    }

    // End means true termination. A suspended or provider-paused run emits it on re-entry.
    if (!enteredWaiting && !ctx.rateLimited) {
      const threadForEnd = threadStore.get(threadId)!;
      const lastStep = threadForEnd.steps[threadForEnd.steps.length - 1];
      await executeLifecycleHooks(threadId, 'end', {
        template: ctx.template?.hooks?.onEnd,
        extra: opts.extraHooks?.onEnd,
      }, opts, lastStep?.agentSlotId);
    }

    // Only complete if not already in a terminal state (e.g. cancelled during loop). A
    // rate-limit pause leaves status='rate_limited', so this guard also skips it.
    const threadBeforeComplete = threadStore.get(threadId);
    if (threadBeforeComplete && threadBeforeComplete.status === 'running') {
      await completeThread(threadId);
    }

  } catch (error: any) {
    // Retryable provider failures pause on a synthetic outage window and return normally;
    // permanent errors and the fourth transient failure keep the original fail + rethrow path.
    if (!await pauseRetryableProviderError(threadId, ctx, opts, error)) {
      const thread = threadStore.get(threadId);
      if (thread && thread.status === 'running') {
        await failThread(threadId, error.message || 'Unknown error');
      }
      throw error;
    }
  } finally {
    // Defensive: the per-step path finalizes each execution on success (recordStepOutcome) and on
    // error (executeAndAwaitAgent). If the loop threw AFTER an agent result but BEFORE the step was
    // finalized, the step's execution can still be registered and its persistent record still
    // 'running' — finalize it as failed across both ledgers so it neither leaks a 'running' record
    // nor poisons a dispatch slot. Scope to THIS thread's entries so a concurrent run on the same
    // channel is never touched.
    for (const e of runningExecutions.getByChannel(opts.channel)) {
      if (e.threadId !== threadId) continue;
      if (e.executionId) {
        executionRegistry.teardownExecution({ executionId: e.executionId, status: 'failed', durationS: 0, error: { message: 'thread ended before step finalized' } });
      } else {
        runningExecutions.remove(e.registryKey);
      }
    }
    // Cleanup thread-specific sessions. Intentionally also runs on suspension (DR-0014):
    // a waiting parent holds no live session — the artifact is its durable memory, and
    // persistSession slots keep their sessionId so re-entry resumes via --resume.
    closeSessionsByPrefix(`thr:${threadId}:`);
  }

  return finalizeThread(threadId, ctx);
}

// --- Continue an existing thread with new user input ---

async function continueThread(threadId: string, userMessage: string, opts: RunThreadOptions): Promise<ThreadRunResult> {
  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  if (thread.status !== 'running' && thread.status !== 'waiting' && thread.status !== 'rate_limited') {
    throw new Error(`Thread ${threadId} is ${thread.status}, cannot continue`);
  }

  // Update the thread's user message for the new input
  await threadStore.mutate(threadId, (t) => {
    t.userMessage = userMessage;
    t.status = 'running';
    // Interrupted-step rerun sends the continuation reminder instead of {{input}} — deliver the
    // new user input through the buffered-replies block so it is not silently dropped.
    if (Object.values(t.agents).some((slot) => slot.interruptedBackendSessionId)) {
      ((t.metadata ??= {}).pendingMessages ??= []).push(userMessage);
    }
    if (t.metadata) {
      t.metadata.interruptedByRateLimit = false;
      t.metadata.rateLimitProvider = null;
    }
  });

  return runThread(threadId, opts);
}

/** Consume one wait intent exactly once, preserving its explicit target selectors. */
export async function consumeWaitControl(
  threadId: string,
  control: Pick<NonNullable<PendingControl>, 'onTasks' | 'onThreads'>,
): Promise<boolean> {
  await clearPendingControl(threadId);
  return tryEnterWaiting(threadId, control);
}

// --- Resume a rate-limit-paused thread (auto-resume) ---

/** Re-enter a thread paused by a provider throttle (status==='rate_limited'). Like resumeThread,
 *  the userMessage is NOT overwritten — the thread re-runs its interrupted step from the original
 *  prompt/contract. Called when the owning provider window resets. */
async function resumeRateLimitedThread(threadId: string, opts: RunThreadOptions): Promise<ThreadRunResult> {
  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  if (thread.status !== 'rate_limited') {
    throw new Error(`Thread ${threadId} is ${thread.status}, cannot resume (expected rate_limited)`);
  }
  await threadStore.mutate(threadId, (t) => {
    t.status = 'running';
    if (t.metadata) {
      t.metadata.interruptedByRateLimit = false;
      t.metadata.rateLimitProvider = null;
    }
  });
  return runThread(threadId, opts);
}

// --- Resume a suspended parent thread (DR-0014) ---

/** Re-enter a parent thread that was suspended via [WAIT_CHILDREN]. Unlike continueThread,
 *  the userMessage is NOT overwritten — the original contract stays in {{input}}; the child
 *  results arrive through metadata.pendingMessages (injected by the prompt builder). */
async function resumeThread(threadId: string, opts: RunThreadOptions): Promise<ThreadRunResult> {
  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  if (thread.status !== 'waiting') {
    throw new Error(`Thread ${threadId} is ${thread.status}, cannot resume`);
  }
  await threadStore.mutate(threadId, (t) => {
    t.status = 'running';
  });
  return runThread(threadId, opts);
}

// --- Thread summary for Slack ---

function buildThreadSummary(result: ThreadRunResult): string {
  const { thread, totalCostUsd, totalNumTurns } = result;
  const steps = thread.steps;
  const elapsed = thread.endedAt && thread.createdAt
    ? (new Date(thread.endedAt).getTime() - new Date(thread.createdAt).getTime()) / 1000
    : 0;

  const statusEmoji = thread.status === 'completed' ? Icons.ok
    : thread.status === 'cancelled' ? Icons.blocked
    : thread.status === 'aborted' ? Icons.stopped
    : thread.status === 'waiting' ? Icons.processing
    : thread.status === 'rate_limited' ? Icons.warning
    : Icons.error;

  const headline = thread.status === 'waiting'
    ? `${statusEmoji} Thread suspended — waiting on ${(thread.metadata?.waitingOn?.length ?? 0) + (thread.metadata?.waitingOnTasks?.length ?? 0)} child(ren) | ${steps.length} steps | $${totalCostUsd.toFixed(4)}`
    : thread.status === 'rate_limited'
    ? `${statusEmoji} Thread paused — rate limited, will auto-resume | ${steps.length} steps | $${totalCostUsd.toFixed(4)}`
    : `${statusEmoji} Thread complete | ${steps.length} steps | $${totalCostUsd.toFixed(4)} | ${formatDurationCompact(elapsed)}`;
  const lines = [headline];

  if (steps.length > 1) {
    for (const step of steps) {
      const costStr = step.costUsd != null ? `$${step.costUsd.toFixed(4)}` : '?';
      const turnsStr = step.numTurns != null ? `${step.numTurns} turns` : '?';
      const durStr = step.durationS != null ? formatDurationCompact(step.durationS) : '?';
      const label = formatAgentStageLabel(step.agentSlotId, step.stage);
      lines.push(`  ${label}: ${turnsStr} · ${costStr} · ${durStr}`);
    }
  }

  if (thread.abortReason) {
    lines.push(`Aborted: ${thread.abortReason}`);
  } else if (thread.status === 'aborted') {
    lines.push(`Aborted (no reason given)`);
  }
  if (thread.error) {
    lines.push(`Error: ${thread.error}`);
  }

  return lines.join('\n');
}

// Proxy functions to support existing callers that import cancelActiveThread / getActiveHandle from runner.ts.
// These delegate to the unified RunningExecutions singleton.
function cancelActiveThread(channel: string): boolean {
  return runningExecutions.killByChannel(channel) > 0;
}
function getActiveHandle(channel: string): RunningExecution | null {
  return runningExecutions.getByChannel(channel)[0] ?? null;
}

export {
  runThread,
  continueThread,
  resumeThread,
  resumeRateLimitedThread,
  buildThreadSummary,
  cancelActiveThread,
  getActiveHandle,
  // Internal helpers — exported to support focused unit tests from agent-server/tests/thread-runner.test.ts.
  // Not part of the public API; callers outside the test harness should continue to use runThread().
  initThreadContext,
  resolveAndNotifyStep,
  buildStepConfig,
  setupStepCallbacks,
  executeAndAwaitAgent,
  recordStepOutcome,
  evaluateAndTransition,
  finalizeThread,
};
export type { ThreadRunResult, ThreadContext, StepContext, StepCallbacks, StepInfo };
