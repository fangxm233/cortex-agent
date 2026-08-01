// input:  turns, mutation leases, results and callbacks
// output: snapshot barriers and provider finalization
// pos:    Agent turn initialization and completion
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { createLogger } from '@core/log.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef } from '@platform/index.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import type { ExecutionRecord } from '@domain/executions/registry.js';
import { trackPendingTask } from './busy-tracker.js';
import { enqueue } from './conduit-queue.js';
import { supersededEdits } from './superseded-edits.js';
import { acquireTurnMutationLock, type TurnMutationRelease } from './turn-mutation-lock.js';
import { runningExecutions } from '../core/running-executions.js';

import { finalizeLocalExecution, buildSessionTag, buildUserProcessingMessage, makeFallbackNotifier, makeStreamingMessageCallback, computeElapsed, formatMetricsSuffix, writeStatus, sealStatus, buildStatusActionBlocks, buildSealedStatusActionBlocks, initStatusBlocks } from './status-helpers.js';
import { getSessionAsync, setSessionAsync } from '@domain/sessions/session.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { isOnMessageEndHookConfigured, runMessageEndSessionHook } from '@domain/sessions/session-hooks.js';
import * as executionRegistry from '@domain/executions/registry.js';
import * as askUserQuestion from './interactions/ask-user-question.js';
import { runAgent, getClaudeMode, getActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';

import { setStreamingCallback, clearStreamingCallback } from './routing/hook-bridge.js';
import { maybeNotifyTurnComplete } from './turn-notify.js';
import { buildContinuationSink } from './bg-continuation.js';
import { startBgWaitGuard } from './bg-wait-guard.js';
import { recordCost } from '@domain/costs/cost-tracker.js';
import type { ContinuationSink } from '../agent-adapter/types.js';
import { recordResume } from '@domain/costs/resume-registry.js';
import { isApiRateLimitError } from '@domain/agents/config.js';
import { isProviderRateLimited } from '@domain/costs/rate-limit-throttle.js';
import { normalizeSkillCommandPrefix } from '@domain/memory/skill-scanner.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { buildDurableHooks, durablePost } from './durable-helpers.js';
import type { OutputStream } from '@platform/index.js';

const log = createLogger('lifecycle');

// --- Agent success handler ---

export async function handleAgentSuccess({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, trigger = 'user', sessionName = null, threadAnchorId = null, userMessageTs = null, projectId = 'general', onAssistantMessage = null, onToolUse = null, onToolResult = null, onContextUsage = null, registerContinuationSink = null }: { result: AgentResult; channel: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number; userMessage: string; executionId: string | null; trigger?: string; sessionName?: string | null; threadAnchorId?: string | null; userMessageTs?: string | null; projectId?: string; onAssistantMessage?: ((text: string) => void) | null; onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null; onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null; onContextUsage?: ((usage: ContextUsage) => void) | null; registerContinuationSink?: ((sink: ContinuationSink) => void) | null }): Promise<void> {
  // Decoupling: `result.sessionId` is the BACKEND's own session id (Claude self-generated / PI
  // bootstrap id), not the tracking id. Store it as the resume target on the STABLE track record
  // (keyed by sessionName) — do NOT rebind the channel or the registry key to it. The channel stays
  // bound to the track id, so publish/history/UI keep a stable identity across turns.
  if (result?.sessionId && sessionName) {
    await sessionStore.updateSession(sessionName, {
      backendSessionId: result.sessionId,
      lastUsedAt: new Date().toISOString(),
    });
  }

  const { elapsedStr, elapsedS } = computeElapsed(startTime);
  finalizeLocalExecution({ executionId, status: 'completed', result, durationS: elapsedS });
  const metrics = formatMetricsSuffix({ costUsd: result?.total_cost_usd ?? null, numTurns: result?.num_turns ?? null });
  const sessionTag = buildSessionTag(sessionName, result?.sessionId);
  const stream = (onAssistantMessage as any)?.stream ?? null;
  const askCount = await askUserQuestion.sendMessages(result, channel, adapter, statusMsg.messageId, threadAnchorId, stream);
  // Background-task continuation: background work remains — either still running
  // (pendingBackgroundTasks) or finished-but-unnotified (undeliveredBackgroundTasks; CC may
  // deliver the notification seconds later, or never — 2026-07-10 investigation). Hold the
  // status in a "waiting" state (don't seal) and register a sink so the spontaneous
  // continuation turn merges into this reply and seals the status then. A bg-wait-guard
  // bounds the hold: busy bracket for the whole window (F1: a deferred daemon restart must
  // not fire and kill the Claude child), a grace watchdog for undelivered-only work (F5),
  // and a max-wait cap for never-ending tasks (F6). Only when there are no pending user
  // questions and the assistant reply stream is available to merge into.
  const pendingBg = result?.pendingBackgroundTasks ?? 0;
  const undeliveredBg = result?.undeliveredBackgroundTasks ?? 0;
  if (registerContinuationSink && stream && askCount === 0 && pendingBg + undeliveredBg > 0) {
    // Continuation cost is attributed to the session's bound project (threaded from the caller),
    // NOT re-derived from the message text.
    const backend = resolveBackendForChannel(channel);
    const waitingText = (remaining: number) =>
      `${Icons.waiting} ${sessionTag}${t('status.backgroundRunning')} (${remaining}) (${elapsedStr}${metrics})`;
    await writeStatus(adapter, statusMsg, waitingText(pendingBg + undeliveredBg));
    let finalized = false;
    const guard = startBgWaitGuard({
      running: pendingBg,
      undelivered: undeliveredBg,
      track: trackPendingTask,
      // F5: work finished but CC never delivered the notification (old-CLI same-turn
      // completions / killed tasks). The model already saw the task's outcome inside the
      // turn, so finalize as a normal completion with a zero-cost continuation.
      onGraceTimeout: () => {
        if (finalized) return;
        finalized = true;
        log.info(`bg-wait-guard grace timeout: sealing ${channel} without a continuation`);
        void finalizeBackgroundContinuation({
          adapter, statusMsg, channel, sessionName, sessionId: result?.sessionId ?? null,
          startTime, baseResult: result, contResult: { total_cost_usd: null, num_turns: null } as AgentResult,
          userMessageTs, executionId, trigger, projectId, backend,
        }).catch((e) => log.error('finalizeBackgroundContinuation (grace) failed:', (e as Error)?.message ?? e));
      },
      // F6: still-running work exceeded the cap (tunnels / monitors can run forever). Seal
      // the status as "still running" and release the busy bracket, but KEEP the sink and
      // streaming callback — a very late continuation still merges and re-seals as done.
      onMaxWait: () => {
        if (finalized) return;
        const { elapsedStr: fullElapsed } = computeElapsed(startTime);
        const capText = `${Icons.waiting} ${sessionTag}${t('status.backgroundStillRunning')} (${fullElapsed}${metrics})`;
        void sealStatus(adapter, statusMsg, capText, buildSealedStatusActionBlocks(capText, { channel, sessionName, isDm: true }));
      },
    });
    const sink = buildContinuationSink({
      stream,
      onToolUse: onToolUse || null,
      onToolResult: onToolResult || null,
      onContextUsage: onContextUsage || null,
      onWaiting: (remaining, split) => {
        guard.rearm(split?.running ?? remaining, split?.undelivered ?? 0);
        void writeStatus(adapter, statusMsg, waitingText(remaining));
      },
      onRateLimited: (contResult) => {
        guard.settle();
        if (finalized) return;
        finalized = true;
        // Record for auto-resume when the rate-limit window resets.
        const provider = contResult.rateLimitProvider ?? result?.rateLimitProvider ?? null;
        if (isProviderRateLimited(provider)) {
          recordResume({ kind: 'direct', provider, channel, userMessage, recordedAt: Date.now() });
        }
        const { elapsedStr: fullElapsed } = computeElapsed(startTime);
        const metrics = formatMetricsSuffix({ costUsd: (result?.total_cost_usd ?? 0) + (contResult?.total_cost_usd ?? 0), numTurns: (result?.num_turns ?? 0) + (contResult?.num_turns ?? 0) });
        const rateLimitText = `${Icons.warning} ${sessionTag}${t('status.rateLimitedExhausted')} (${fullElapsed}${metrics})`;
        void sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
        clearStreamingCallback(channel);
      },
      onComplete: (contResult) => {
        guard.settle();
        if (finalized) return;
        finalized = true;
        void finalizeBackgroundContinuation({
          adapter, statusMsg, channel, sessionName, sessionId: result?.sessionId ?? null,
          startTime, baseResult: result, contResult, userMessageTs, executionId, trigger, projectId, backend,
        }).catch((e) => log.error('finalizeBackgroundContinuation failed:', (e as Error)?.message ?? e));
      },
      // F2: the Claude process died while background tasks were pending (restart / crash /
      // kill / timeout) — seal honestly as interrupted, never leave the waiting state.
      onInterrupted: () => {
        guard.settle();
        if (finalized) return;
        finalized = true;
        const { elapsedStr: fullElapsed } = computeElapsed(startTime);
        const interruptedText = `${Icons.warning} ${sessionTag}${t('status.backgroundInterrupted')} (${fullElapsed}${metrics})`;
        void sealStatus(adapter, statusMsg, interruptedText, buildSealedStatusActionBlocks(interruptedText, { channel, sessionName, isDm: true }));
        if (userMessageTs) {
          void conversationLedger.completeTurn(channel, userMessageTs, { executionId }).catch((e) => log.error('completeTurn (bg-interrupted) failed:', (e as Error).message));
        }
        clearStreamingCallback(channel);
      },
    });
    registerContinuationSink(sink);
    return; // status held; finalization deferred to the continuation turn / guard
  }

  const statusText = askCount > 0
    ? `${Icons.waiting} ${sessionTag}${t('status.waitingForUserInput')} (${elapsedStr}${metrics})`
    : `${Icons.ok} ${t('status.done')} | ${sessionTag}(${elapsedStr}${metrics})`;
  await sealStatus(adapter, statusMsg, statusText, buildSealedStatusActionBlocks(statusText, { channel, sessionName, isDm: true }));

  // Push a NEW message when a long-running user turn finishes (the sealed status above is an
  // edit, which does not notify on Slack/Feishu). Only fires when no ask-user questions are
  // pending — those already prompt the user.
  if (askCount === 0) {
    await maybeNotifyTurnComplete({ adapter, channel, threadAnchorId, sessionName, sessionId: result?.sessionId ?? null, elapsedS, elapsedStr, status: 'completed', metricsSuffix: metrics });
  }

  if (userMessageTs) {
    await conversationLedger.completeTurn(channel, userMessageTs, { executionId });
  }

  // Plan delivery is owned by the ExitPlanMode PreToolUse hook (hooks/exit-plan-mode-hook.mjs),
  // which forwards the plan through webhook /hook/exit-plan-mode → sendPlanToSlack.
  // Re-sending here would duplicate the plan message (and historically could
  // desync when the hook's mtime-based lookup picked a stale file).

  // onMessageEnd hook: extends the assistant turn's OutputStream so hook lines
  // (status/preview/error) and any injected agent turn share one continuous Slack
  // thread with the reply we just finished — no top-level leak, no detached stream.
  if (isOnMessageEndHookConfigured() && result?.sessionId) {
    const hookStream = (onAssistantMessage as any)?.stream as OutputStream | undefined;
    if (hookStream) {
      try {
        const conv = await conversationLedger.getConversation(channel);
        const profileName = conv?.profileName ?? null;
        await runMessageEndSessionHook({
          channel,
          sessionId: result.sessionId,
          sessionName: sessionName ?? '',
          executionId: executionId ?? '',
          profile: profileName,
          stream: hookStream,
        });
      } catch (err) {
        log.error('onMessageEnd hook failed:', (err as any)?.message || err);
      }
    } else {
      log.warn('onMessageEnd hook skipped: assistant stream unavailable on onAssistantMessage');
    }
  }
}

/** Finalize a turn that was held in "waiting" state once its background-task continuation
 *  completes: seal the status (combined metrics), complete the conversation turn, release the
 *  streaming callback, and record the continuation's cost. Idempotency is guarded by the
 *  caller (the sink fires onComplete once). */
async function finalizeBackgroundContinuation({ adapter, statusMsg, channel, sessionName, sessionId, startTime, baseResult, contResult, userMessageTs, executionId, trigger, projectId, backend }: {
  adapter: PlatformAdapter; statusMsg: MessageRef; channel: string; sessionName: string | null; sessionId: string | null;
  startTime: number; baseResult: AgentResult; contResult: AgentResult; userMessageTs: string | null; executionId: string | null;
  trigger: string; projectId: string; backend: string;
}): Promise<void> {
  const { elapsedStr } = computeElapsed(startTime);
  const totalCost = (baseResult?.total_cost_usd ?? 0) + (contResult?.total_cost_usd ?? 0);
  const totalTurns = (baseResult?.num_turns ?? 0) + (contResult?.num_turns ?? 0);
  const metrics = formatMetricsSuffix({ costUsd: totalCost, numTurns: totalTurns });
  const sessionTag = buildSessionTag(sessionName, sessionId);
  const statusText = `${Icons.ok} ${t('status.done')} | ${sessionTag}(${elapsedStr}${metrics})`;
  await sealStatus(adapter, statusMsg, statusText, buildSealedStatusActionBlocks(statusText, { channel, sessionName, isDm: true }));
  await maybeNotifyTurnComplete({ adapter, channel, threadAnchorId: null, sessionName, sessionId, elapsedS: computeElapsed(startTime).elapsedS, elapsedStr, status: 'completed', metricsSuffix: metrics });
  if (userMessageTs) {
    await conversationLedger.completeTurn(channel, userMessageTs, { executionId }).catch((e) => log.error('completeTurn failed:', (e as Error).message));
  }
  clearStreamingCallback(channel);
  if (contResult?.total_cost_usd != null) {
    await recordCost({
      project: projectId,
      trigger: trigger ? `${trigger}:bg-continuation` : 'bg-continuation',
      cost_usd: contResult.total_cost_usd,
      backend: backend as any,
      mode: getClaudeMode(),
      source: 'estimate',
      input_tokens: 0,
      output_tokens: 0,
    }).catch((e) => log.warn('recordCost (bg-continuation) failed:', (e as Error).message));
  }
}

async function backfillLedgerSessionId(result: { sessionId?: string | null }, channel: string): Promise<void> {
  if (!result?.sessionId) return;
  const conv = await conversationLedger.getConversation(channel);
  if (conv && !conv.sessionId) {
    await conversationLedger.updateSessionId(channel, result.sessionId);
  }
}

// --- Agent error handler ---

export async function handleAgentError({ error, channel, adapter, statusMsg, startTime, executionId, sessionName = null, sessionId = null, effectiveSessionId = null, threadAnchorId = null, userMessageTs = null, userMessage = null }: { error: { message: string; cancelled?: boolean; rateLimitProvider?: string }; channel: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number; executionId: string | null; sessionName?: string | null; sessionId?: string | null; effectiveSessionId?: string | null; threadAnchorId?: string | null; userMessageTs?: string | null; userMessage?: string | null }): Promise<void> {
  if (executionId) runningExecutions.fail(executionId, error.message);
  const resolvedSessionId = effectiveSessionId || sessionId;
  const sessionTag = buildSessionTag(sessionName, resolvedSessionId);
  const { elapsedStr, elapsedS } = computeElapsed(startTime);

  if (error?.cancelled && supersededEdits.check(channel)) {
    supersededEdits.clear(channel);
    finalizeLocalExecution({ executionId, status: 'cancelled', error, durationS: elapsedS });
    const supersededText = `${Icons.superseded} ${sessionTag}${t('status.supersededByEdit')} (${elapsedStr})`;
    await sealStatus(adapter, statusMsg, supersededText, buildSealedStatusActionBlocks(supersededText, { channel, sessionName, isDm: true }));
    return;
  }

  await persistErrorSession(resolvedSessionId, sessionName, channel, adapter);
  if (userMessageTs) await conversationLedger.completeTurn(channel, userMessageTs, { executionId });

  if (error?.cancelled) {
    finalizeLocalExecution({ executionId, status: 'failed', error, durationS: elapsedS });
    const cancelledText = `${Icons.stopped} ${sessionTag}${t('status.cancelled')} (${elapsedStr})`;
    await sealStatus(adapter, statusMsg, cancelledText, buildSealedStatusActionBlocks(cancelledText, { channel, sessionName, isDm: true }));
    return;
  }

  // Thrown rate-limit error while the five-hour throttle is active: pause-and-resume instead of
  // failing, mirroring the thread thrown path (domain/threads/runner.ts) and the graceful direct
  // path (agent-runner handleDefaultAgentResult / edit-retry below). runningExecutions.fail already
  // ran at the top. Only when a userMessage is available (direct/TUI turns) — manager-qa / edit
  // callers without it fall through to the normal error path.
  if (userMessage && isApiRateLimitError(error.message) && isProviderRateLimited(error.rateLimitProvider)) {
    finalizeLocalExecution({ executionId, status: 'failed', error: { message: 'Rate limited' }, durationS: elapsedS });
    recordResume({
      kind: 'direct', provider: error.rateLimitProvider ?? null,
      channel, userMessage, recordedAt: Date.now(),
    });
    const rateLimitText = `${Icons.warning} ${sessionTag}${t('status.rateLimitedExhausted')} (${elapsedStr})`;
    await sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
    return;
  }

  log.error('Agent error:', error.message);
  finalizeLocalExecution({ executionId, status: 'failed', error, durationS: elapsedS });
  const errorText = `${Icons.error} ${sessionTag}${t('status.error')} (${elapsedStr})`;
  await sealStatus(adapter, statusMsg, errorText, buildSealedStatusActionBlocks(errorText, { channel, sessionName, isDm: true }));
  await maybeNotifyTurnComplete({ adapter, channel, threadAnchorId, sessionName, sessionId: resolvedSessionId, elapsedS, elapsedStr, status: 'failed' });
  const errorDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: resolvedSessionId ?? '' };
  const queue = getOutboundQueue();
  if (queue) {
    await durablePost(queue, adapter, errorDest, { text: t('status.errorBody', { message: error.message }) }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
  } else {
    await adapter.postMessage(errorDest, { text: t('status.errorBody', { message: error.message }) }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
  }
}

async function persistErrorSession(resolvedSessionId: string | null, sessionName: string | null, channel: string, adapter: PlatformAdapter): Promise<void> {
  if (!resolvedSessionId) return;
  const backend = resolveBackendForChannel(channel);
  await setSessionAsync(channel, resolvedSessionId, backend);
  await backfillLedgerSessionId({ sessionId: resolvedSessionId }, channel);
  if (!sessionName) return;
  const existing = await sessionStore.lookupBySessionId(resolvedSessionId);
  if (!existing) {
    await sessionStore.registerSession(sessionName, { sessionId: resolvedSessionId, channel, backend, kind: 'local', origin: 'direct', profileName: getActiveProfile(channel), projectId: (await adapter.resolveInboundProject(channel)) ?? 'general' });
  }
}

// --- AskUserQuestion resume ---

export async function resumeAskUserQuestionGroup({ adapter, group, responseText }: { adapter: PlatformAdapter; group: { channel: string; sessionId: string; groupId: string; threadId?: string | null }; responseText: string }): Promise<void> {
  const askDest: Destination = { type: 'interactive-reply', conduit: group.channel, sessionId: group.sessionId };
  const statusMsg = await adapter.postMessage(askDest, { text: `${Icons.processing} ${t('status.processingAskResponse')}` });
  const startTime = Date.now();
  let executionId = null;
  let handle;
  try {
    const askBackend = resolveBackendForChannel(group.channel);
    // group.sessionId is the stable track id; resolve the backend resume target + name + project
    // from its registry record. Cost/execution attribution uses the session's bound project, NOT a
    // re-derivation from the response text.
    const askRec = await sessionStore.getById(group.sessionId);
    const askBackendSessionId = askRec ? effectiveBackendSessionId(askRec) : null;
    const askSessionName = askRec?.name ?? null;
    const askProjectId = askRec?.projectId ?? 'general';
    const execution = executionRegistry.startLocalExecution({
      kind: 'local', channel: group.channel,
      project: askProjectId,
      trigger: 'ask-user-question',
      backend: askBackend, billingMode: getClaudeMode(),
      sessionId: group.sessionId, label: responseText,
    });
    executionId = execution.id;
    const askQueue = getOutboundQueue();
    const askDurable = askQueue ? buildDurableHooks(askQueue) : null;
    const onAssistantMsg = makeStreamingMessageCallback(adapter, askDest, null, null, askDurable);
    handle = runAgent(responseText, { channel: group.channel, sessionId: askBackendSessionId, trackSessionId: group.sessionId, files: [], project: askProjectId, trigger: 'ask-user-question', onAssistantMessage: onAssistantMsg });
    runningExecutions.register({ threadId: group.threadId ?? null, channel: group.channel, agentSlotId: null, executionId, kill: () => handle.kill(), backend: askBackend });
    const result = await handle.promise;
    runningExecutions.complete(executionId, result?.total_cost_usd ?? 0);
    await handleAgentSuccess({ result, channel: group.channel, adapter, statusMsg, startTime, userMessage: responseText, executionId, trigger: 'ask-user-question', sessionName: askSessionName, projectId: askProjectId, onAssistantMessage: onAssistantMsg });
  } catch (error) {
    await handleAgentError({ error: error as { message: string; cancelled?: boolean }, channel: group.channel, adapter, statusMsg, startTime, executionId, effectiveSessionId: handle?.sessionId });
  } finally {
    askUserQuestion.deleteGroup(group.groupId);
  }
}

// --- Edit retry (reprocessMessage) ---

export function reprocessMessage(channel: string, text: string, adapter: PlatformAdapter, opts: { originalTs: string; isRetry: boolean; sessionId: string | null; sessionName: string | null; supersededStatusTimestamps?: string[] }): void {
  trackPendingTask(+1);
  enqueue(channel, async () => {
    try {
      await executeRetry(channel, text, adapter, opts);
    } finally {
      trackPendingTask(-1);
    }
  });
}

async function executeRetry(channel: string, text: string, adapter: PlatformAdapter, opts: { originalTs: string; isRetry: boolean; sessionId: string | null; sessionName: string | null; supersededStatusTimestamps?: string[] }): Promise<void> {
  const startTime = Date.now();
  // sessionId here is the stable track id; resolve the backend resume target from its record.
  const sessionId = opts.sessionId ?? await getSessionAsync(channel, resolveBackendForChannel(channel));
  const retryRec = sessionId ? await sessionStore.getById(sessionId) : null;
  const backendSessionId = retryRec ? effectiveBackendSessionId(retryRec) : null;
  const projectId = retryRec?.projectId ?? 'general';
  const sessionName = opts.sessionName || await sessionStore.generateSessionName();
  const userMessageTs = opts.originalTs;
  const retryDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: sessionId ?? '' };

  const retryPrefix = `${Icons.refresh} ${t('status.retry')} (${t('status.retryEdited')}) | `;
  const retryStatusText = retryPrefix + buildUserProcessingMessage({ startTime, profileName: getActiveProfile(channel), sessionName, sessionId });
  const retryBlocksTemplate = { channel, sessionName, isDm: true };
  const statusMsg = await adapter.postMessage(retryDest, {
    text: retryStatusText,
    richBlocks: buildStatusActionBlocks(retryStatusText, retryBlocksTemplate),
  });
  initStatusBlocks(statusMsg, retryBlocksTemplate);

  updateRetryPermalinks(adapter, channel, userMessageTs, statusMsg, opts.supersededStatusTimestamps, retryPrefix, startTime, sessionName, sessionId);
  const turnTrackingToken = await initTurnTracking(
    channel, sessionId, backendSessionId, sessionName,
    userMessageTs, text, statusMsg.messageId,
  );
  if (consumePendingTurnSupersession(channel, turnTrackingToken)) {
    finishTurnTracking(channel, turnTrackingToken);
    return;
  }
  const onMessagePosted = (ref: MessageRef) => void conversationLedger.addResponseTs(channel, userMessageTs, ref.messageId).catch((e) => log.error(e));
  await runRetryAgent({
    channel, text, adapter, statusMsg, startTime, sessionId, backendSessionId,
    sessionName, projectId, userMessageTs, retryPrefix, onMessagePosted,
    retryDest, turnTrackingToken,
  });
}

async function runRetryAgent({ channel, text, adapter, statusMsg, startTime, sessionId, backendSessionId, sessionName, projectId, userMessageTs, retryPrefix, onMessagePosted, retryDest, turnTrackingToken }: { channel: string; text: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number; sessionId: string | null; backendSessionId: string | null; sessionName: string | null; projectId: string; userMessageTs: string; retryPrefix: string; onMessagePosted: (ref: MessageRef) => void; retryDest: Destination; turnTrackingToken: TurnTrackingToken }): Promise<void> {
  const agentMessage = normalizeSkillCommandPrefix(text || '');
  let executionId = null;
  let handle;
  try {
    const retryBackend = resolveBackendForChannel(channel);
    executionId = executionRegistry.startLocalExecution({
      kind: 'local', channel, project: projectId,
      trigger: 'edit-retry', backend: retryBackend, billingMode: getClaudeMode(), sessionId, label: agentMessage,
    }).id;
    const retryQueue = getOutboundQueue();
    const retryDurable = retryQueue ? buildDurableHooks(retryQueue) : null;
    const onAssistantMsg = makeStreamingMessageCallback(adapter, retryDest, null, onMessagePosted, retryDurable);
    setStreamingCallback(channel, onAssistantMsg);
    handle = runAgent(agentMessage, {
      channel, sessionId: backendSessionId, trackSessionId: sessionId, files: [], profileName: getActiveProfile(channel),
      project: projectId, trigger: 'edit-retry',
      onFallback: makeFallbackNotifier(channel, statusMsg, adapter),
      isUserInitiated: true, onAssistantMessage: onAssistantMsg,
      onProgress: buildRetryProgressUpdater(adapter, channel, statusMsg, retryPrefix, startTime, sessionName, sessionId),
    });
    runningExecutions.register({ threadId: null /* A5: edit-retry — threadId not yet wired; Cancel button will warn */, channel, agentSlotId: null, executionId, kill: () => handle.kill(), backend: retryBackend });
    finishTurnTracking(channel, turnTrackingToken);
    const result = await handle.promise;
    runningExecutions.complete(executionId, result?.total_cost_usd ?? 0);
    clearStreamingCallback(channel);

    if (result?.rateLimited) {
      // Record the interrupted edit-retry conversation for auto-resume when the window resets.
      if (isProviderRateLimited(result.rateLimitProvider)) {
        recordResume({
          kind: 'direct', provider: result.rateLimitProvider ?? null,
          channel, userMessage: text, recordedAt: Date.now(),
        });
      }
      const { elapsedStr } = computeElapsed(startTime);
      const rateLimitText = `${Icons.warning} ${buildSessionTag(sessionName, sessionId)}${t('status.rateLimitedExhausted')} (${elapsedStr})`;
      await sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
    } else {
      await handleAgentSuccess({ result, channel, adapter, statusMsg, startTime, userMessage: text, executionId, trigger: 'edit-retry', sessionName, projectId, userMessageTs, onAssistantMessage: onAssistantMsg });
    }
  } catch (error) {
    clearStreamingCallback(channel);
    await handleAgentError({ error, channel, adapter, statusMsg, startTime, executionId, sessionName, sessionId, effectiveSessionId: handle?.sessionId, userMessageTs });
  } finally {
    finishTurnTracking(channel, turnTrackingToken);
  }
}

function buildRetryProgressUpdater(adapter: PlatformAdapter, channel: string, statusMsg: MessageRef, retryPrefix: string, startTime: number, sessionName: string | null, sessionId: string | null) {
  return (progress: { duration_ms?: number | null; num_turns?: number | null } | null) => {
    writeStatus(adapter, statusMsg, retryPrefix + buildUserProcessingMessage({
      startTime, elapsed_s: progress?.duration_ms != null ? progress.duration_ms / 1000 : null,
      num_turns: progress?.num_turns ?? null,
      profileName: getActiveProfile(channel), sessionName, sessionId,
    }));
  };
}

// --- Internal helpers ---

function updateRetryPermalinks(adapter: PlatformAdapter, channel: string, userMessageTs: string, statusMsg: MessageRef, supersededTimestamps: string[] | undefined, retryPrefix: string, startTime: number, sessionName: string | null, sessionId: string | null): void {
  const userPermalinkP = adapter.getPermalink({ conduit: channel, messageId: userMessageTs }).catch(() => null);
  const statusPermalinkP = supersededTimestamps?.length
    ? adapter.getPermalink(statusMsg).catch(() => null)
    : Promise.resolve(null);

  Promise.all([userPermalinkP, statusPermalinkP]).then(([userPermalink, statusPermalink]) => {
    if (userPermalink) {
      writeStatus(adapter, statusMsg, `${Icons.refresh} ${t('status.retry')} (<${userPermalink}|${t('status.retryEdited')}>) | ` + buildUserProcessingMessage({ startTime, profileName: getActiveProfile(channel), sessionName, sessionId }));
    }
    if (statusPermalink && supersededTimestamps?.length) {
      for (const oldTs of supersededTimestamps) {
        adapter.updateMessage(
          { conduit: channel, messageId: oldTs },
          { text: `${Icons.superseded} ${t('status.supersededByEdit')} \u2014 <${statusPermalink}|${t('status.supersededSeeNewReply')}>` },
        ).catch(() => {});
      }
    }
  }).catch(() => {});
}

interface TurnTrackingDeps {
  resolveBackend(channel: string): string;
  getProfile(channel: string): string | null;
  ledger: Pick<typeof conversationLedger, 'initAndBeginTurn' | 'setBackupPath'>;
  backup: Pick<typeof sessionBackup, 'findPISessionFile' | 'backupSessionFile' | 'createBackup'>;
}

export interface TurnTrackingOptions {
  onAccepted?: () => void;
  mutationRelease?: TurnMutationRelease;
  deps?: TurnTrackingDeps;
}

const defaultTurnTrackingDeps: TurnTrackingDeps = {
  resolveBackend: resolveBackendForChannel,
  getProfile: getActiveProfile,
  ledger: conversationLedger,
  backup: sessionBackup,
};

async function snapshotTurn(
  deps: TurnTrackingDeps,
  backend: string,
  backendSessionId: string | null,
  turnIndex: number,
): Promise<string | null> {
  if (!backendSessionId) return null;
  if (backend !== 'pi') return deps.backup.createBackup(backendSessionId, turnIndex);
  const piFile = await deps.backup.findPISessionFile(backendSessionId);
  return piFile ? deps.backup.backupSessionFile(piFile, turnIndex) : null;
}

interface TurnTrackingArgs {
  channel: string;
  trackSessionId: string | null;
  backendSessionId: string | null;
  sessionName: string | null;
  userMessageTs: string;
  userMessageText: string;
  statusMessageTs: string;
}

export type TurnTrackingToken = symbol;

interface TurnTrackingState {
  channel: string;
  operation: Promise<TurnTrackingToken>;
  release: (() => void) | null;
}

const currentTurnTracking = new Map<string, TurnTrackingToken>();
const turnTrackingByToken = new Map<TurnTrackingToken, TurnTrackingState>();
const supersededPendingTurns = new Map<string, TurnTrackingToken>();

export function markPendingTurnSuperseded(channel: string): void {
  const token = currentTurnTracking.get(channel);
  if (token) supersededPendingTurns.set(channel, token);
}

export function isPendingTurnSuperseded(channel: string): boolean {
  return supersededPendingTurns.has(channel);
}

export function consumePendingTurnSupersession(channel: string, token: TurnTrackingToken): boolean {
  if (supersededPendingTurns.get(channel) !== token) return false;
  supersededPendingTurns.delete(channel);
  return true;
}

export function finishTurnTracking(channel: string, token: TurnTrackingToken): void {
  const state = turnTrackingByToken.get(token);
  if (!state || state.channel !== channel) return;
  turnTrackingByToken.delete(token);
  if (currentTurnTracking.get(channel) === token) currentTurnTracking.delete(channel);
  if (supersededPendingTurns.get(channel) === token) supersededPendingTurns.delete(channel);
  state.release?.();
}

export function isTurnTrackingPending(channel: string): boolean {
  return currentTurnTracking.has(channel);
}

export function waitForTurnTracking(channel: string): Promise<void> {
  const token = currentTurnTracking.get(channel);
  const operation = token ? turnTrackingByToken.get(token)?.operation : null;
  return operation ? operation.then(() => undefined) : Promise.resolve();
}

async function runTurnTracking(
  args: TurnTrackingArgs,
  options: TurnTrackingOptions,
  token: TurnTrackingToken,
): Promise<TurnTrackingToken> {
  const release = options.mutationRelease ?? await acquireTurnMutationLock(args.channel);
  try {
    const deps = options.deps ?? defaultTurnTrackingDeps;
    const backend = deps.resolveBackend(args.channel);
    const { turnIndex } = await deps.ledger.initAndBeginTurn(args.channel, {
      sessionId: args.trackSessionId || null, sessionName: args.sessionName, backend,
      profileName: deps.getProfile(args.channel), userMessageTs: args.userMessageTs,
      userMessageText: args.userMessageText || '', statusMessageTs: args.statusMessageTs,
    });
    const backupPath = await snapshotTurn(deps, backend, args.backendSessionId, turnIndex);
    if (backupPath) await deps.ledger.setBackupPath(args.channel, args.userMessageTs, backupPath);
    options.onAccepted?.();
    const state = turnTrackingByToken.get(token);
    if (state) state.release = release;
    return token;
  } catch (error) {
    release();
    throw error;
  }
}

export function initTurnTracking(
  channel: string,
  trackSessionId: string | null,
  backendSessionId: string | null,
  sessionName: string | null,
  userMessageTs: string,
  userMessageText: string,
  statusMessageTs: string,
  options: TurnTrackingOptions = {},
): Promise<TurnTrackingToken> {
  const token = Symbol(channel);
  const operation = runTurnTracking({
    channel, trackSessionId, backendSessionId, sessionName,
    userMessageTs, userMessageText, statusMessageTs,
  }, options, token);
  currentTurnTracking.set(channel, token);
  turnTrackingByToken.set(token, { channel, operation, release: null });
  void operation.catch(() => finishTurnTracking(channel, token));
  return operation;
}
