// input:  a turn's terminal result or error
// output: the success/failure finalization of a turn — the status seal, the ledger's turn
//         completion, the error body, and the hand-off to the background-status hold
// pos:    orchestration/turn — moved here verbatim from `lifecycle.ts` (Phase 1.4) so the Turn
//         object owns its own terminal rendering. `lifecycle.ts` re-exports the two entry points:
//         `tests/orch/lifecycle-*.test.ts` and the surfaces that end a turn without a Turn
//         (edit-handler, session-rewind) still import them from there. Phase 4 turns them into
//         private methods of `Turn`.
import { createLogger } from '@core/log.js';
import { t } from '../../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef, OutputStream } from '@platform/index.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import { supersededEdits } from '../superseded-edits.js';

import { renderTurnStatus, computeElapsed, formatMetricsSuffix, sealStatus, buildSealedStatusActionBlocks } from '../status-helpers.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { runMessageEndForTurn } from '@domain/sessions/session-hooks.js';
import * as askUserQuestion from '../interactions/ask-user-question.js';
import { getActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';

import { maybeNotifyTurnComplete } from '../turn-notify.js';
import { holdBackgroundStatus, type HeldRun } from '../status-renderer.js';
import { recordDirectResume } from '@domain/runs/observers/resume-recorder.js';
import { isApiRateLimitError } from '@domain/agents/config.js';
import { isProviderRateLimited } from '@domain/costs/rate-limit-throttle.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { durablePost } from '../durable-helpers.js';

const log = createLogger('lifecycle');
// --- Agent success handler ---

export async function handleAgentSuccess({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, trigger = 'user', sessionName = null, trackSessionId = null, threadAnchorId = null, userMessageTs = null, projectId = 'general', onAssistantMessage = null, onToolUse = null, onToolResult = null, onContextUsage = null, backgroundRun = null }: { result: AgentResult; channel: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number; userMessage: string; executionId: string | null; trigger?: string; sessionName?: string | null; trackSessionId?: string | null; threadAnchorId?: string | null; userMessageTs?: string | null; projectId?: string; onAssistantMessage?: ((text: string) => void) | null; onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null; onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null; onContextUsage?: ((usage: ContextUsage) => void) | null; backgroundRun?: HeldRun | null }): Promise<void> {
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
  const metrics = formatMetricsSuffix({ costUsd: result?.total_cost_usd ?? null, numTurns: result?.num_turns ?? null });
  const sessionId = result?.sessionId ?? null;
  const stream = (onAssistantMessage as any)?.stream ?? null;
  const askCount = await askUserQuestion.sendMessages(result, channel, adapter, statusMsg.messageId, threadAnchorId, stream);
  // Background-task continuation: background work remains — either still running
  // (pendingBackgroundTasks) or finished-but-unnotified (undeliveredBackgroundTasks; CC may
  // deliver the notification seconds later, or never — 2026-07-10 investigation). Hold the status
  // in a "waiting" state instead of sealing, and let `status-renderer` subscribe to the run: its
  // continuation merges into this reply and seals the status then, and the run's own grace (F5) /
  // max-wait (F6) bounds seal it if no continuation ever arrives. Only when no user questions are
  // pending and the assistant reply stream is available to merge into.
  const pendingBg = result?.pendingBackgroundTasks ?? 0;
  const undeliveredBg = result?.undeliveredBackgroundTasks ?? 0;
  if (backgroundRun && stream && askCount === 0 && pendingBg + undeliveredBg > 0) {
    await holdBackgroundStatus({
      run: backgroundRun, adapter, statusMsg, channel, stream,
      sessionName, sessionId, trackSessionId, startTime, baseResult: result,
      userMessage, userMessageTs, executionId, trigger, projectId,
      // Continuation cost is attributed to the session's bound project (threaded from the caller),
      // NOT re-derived from the message text.
      backend: resolveBackendForChannel(channel),
      onToolUse, onToolResult, onContextUsage,
    });
    return; // status held; finalization deferred to the continuation turn / the run's watchdog
  }

  const statusText = renderTurnStatus(
    askCount > 0 ? { kind: 'awaiting-user' } : { kind: 'done' },
    { sessionName, sessionId, elapsedStr, metrics },
  );
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

  // Plan delivery is owned by the cortex_plan_exit MCP tool, which forwards the plan through
  // webhook /hook/exit-plan-mode → sendPlanToSlack. Re-sending here would duplicate the plan
  // message (and historically could desync when the retired ExitPlanMode hook's mtime-based
  // lookup picked a stale file).

  await runMessageEndForTurn({
    channel, sessionId: result?.sessionId ?? null, sessionName, executionId,
    stream: (onAssistantMessage as any)?.stream as OutputStream | undefined,
  });
}

// --- Agent error handler ---

export async function handleAgentError({ error, channel, adapter, statusMsg, startTime, executionId, sessionName = null, sessionId = null, effectiveSessionId = null, threadAnchorId = null, userMessageTs = null, userMessage = null }: { error: { message: string; cancelled?: boolean; rateLimitProvider?: string }; channel: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number; executionId: string | null; sessionName?: string | null; sessionId?: string | null; effectiveSessionId?: string | null; threadAnchorId?: string | null; userMessageTs?: string | null; userMessage?: string | null }): Promise<void> {
  // DISPLAY id: the status line names the backend session when the caller knows it, exactly as the
  // success path does (`handleAgentSuccess` renders `result.sessionId`). Every IDENTITY decision —
  // channel binding, registry key, message delivery — uses `sessionId`, the stable track id. The two
  // are not interchangeable, and conflating them is what this handler used to do.
  const resolvedSessionId = effectiveSessionId || sessionId;
  const { elapsedStr, elapsedS } = computeElapsed(startTime);

  if (error?.cancelled && supersededEdits.check(channel)) {
    supersededEdits.clear(channel);
    const supersededText = renderTurnStatus({ kind: 'superseded' }, { sessionName, sessionId: resolvedSessionId, elapsedStr });
    await sealStatus(adapter, statusMsg, supersededText, buildSealedStatusActionBlocks(supersededText, { channel, sessionName, isDm: true }));
    return;
  }

  await persistErrorSession({
    trackSessionId: sessionId, backendSessionId: effectiveSessionId, sessionName, channel, adapter,
  });
  if (userMessageTs) await conversationLedger.completeTurn(channel, userMessageTs, { executionId });

  if (error?.cancelled) {
    const cancelledText = renderTurnStatus({ kind: 'cancelled' }, { sessionName, sessionId: resolvedSessionId, elapsedStr });
    await sealStatus(adapter, statusMsg, cancelledText, buildSealedStatusActionBlocks(cancelledText, { channel, sessionName, isDm: true }));
    return;
  }

  // Thrown rate-limit error while the five-hour throttle is active: pause-and-resume instead of
  // failing, mirroring the thread thrown path (domain/threads/runner.ts) and the graceful direct
  // path (agent-runner handleDefaultAgentResult / edit-retry below). The execution record and the
  // live-run registry were already closed by the run's own terminal handler (domain/runs/service);
  // this handler owns the SURFACE. Only when a userMessage is available (direct/TUI turns) —
  // manager-qa / edit callers without it fall through to the normal error path.
  if (userMessage && isApiRateLimitError(error.message) && isProviderRateLimited(error.rateLimitProvider)) {
    recordDirectResume({ provider: error.rateLimitProvider, channel, trackSessionId: sessionId, userMessage });
    const rateLimitText = renderTurnStatus({ kind: 'rate-limited' }, { sessionName, sessionId: resolvedSessionId, elapsedStr });
    await sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
    return;
  }

  log.error('Agent error:', error.message);
  const errorText = renderTurnStatus({ kind: 'error' }, { sessionName, sessionId: resolvedSessionId, elapsedStr });
  await sealStatus(adapter, statusMsg, errorText, buildSealedStatusActionBlocks(errorText, { channel, sessionName, isDm: true }));
  await maybeNotifyTurnComplete({ adapter, channel, threadAnchorId, sessionName, sessionId: resolvedSessionId, elapsedS, elapsedStr, status: 'failed' });
  // Delivery is an identity decision: the TUI gateway routes an interactive-reply by matching this
  // against a connection's session id, which is the TRACK id. Handing it a backend id matched no
  // connection, so the error body was dropped on the way to the client (an empty id falls back to a
  // conduit lookup, which is the right answer for a caller that has no track id to give).
  const errorDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: sessionId ?? '' };
  const queue = getOutboundQueue();
  if (queue) {
    await durablePost(queue, adapter, errorDest, { text: t('status.errorBody', { message: error.message }) }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
  } else {
    await adapter.postMessage(errorDest, { text: t('status.errorBody', { message: error.message }) }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
  }
}

/**
 * Persist what a failed turn knows about its session — with the two ids kept apart.
 *
 * The TRACK id owns the session's identity: the channel binding, the ledger's conversation, the
 * registry key every surface resolves. The BACKEND id is only the CLI's transcript handle, i.e. the
 * `--resume` target, and belongs in the record's `backendSessionId` field — never as a key.
 *
 * This used to take a single conflated id, the backend's preferred, so a caller that passed a
 * backend id (edit-retry, ask-user-resume) made a failure rebind the channel to it and register a
 * SECOND record under the session's name keyed by it. The next message resolved that record, found
 * no resume target on it, and opened a brand-new backend conversation — the same pre-decoupling
 * leftover that `cancelLive` was cleaned of in fix 9809d9a3, surviving in the error path.
 */
export async function persistErrorSession(args: {
  trackSessionId: string | null;
  backendSessionId: string | null;
  sessionName: string | null;
  channel: string;
  adapter: PlatformAdapter;
}): Promise<void> {
  const { trackSessionId, backendSessionId, sessionName, channel, adapter } = args;
  // The resume target, on the record it belongs to — the failure path's half of what
  // handleAgentSuccess does with `result.sessionId`. Best-effort: a registry hiccup must not mask
  // the error this handler is here to report.
  if (backendSessionId && sessionName) {
    await sessionStore.updateSession(sessionName, {
      backendSessionId,
      lastUsedAt: new Date().toISOString(),
    }).catch(() => {});
  }
  if (!trackSessionId) return;
  const backend = resolveBackendForChannel(channel);
  await setSessionAsync(channel, trackSessionId);
  // Backfill the ledger's session id: a conversation opened before the backend reported one.
  const conv = await conversationLedger.getConversation(channel);
  if (conv && !conv.sessionId) await conversationLedger.updateSessionId(channel, trackSessionId);
  if (!sessionName) return;
  const existing = await sessionStore.lookupBySessionId(trackSessionId);
  if (!existing) {
    await sessionStore.registerSession(sessionName, { sessionId: trackSessionId, channel, backend, kind: 'local', origin: 'direct', profileName: getActiveProfile(channel), projectId: (await adapter.resolveInboundProject(channel)) ?? 'general' });
  }
}

// --- The conversation path's terminal branch ---

/**
 * Split the terminal result the way the direct conversation path always has: a rate-limited turn
 * records its auto-resume and seals with the rate-limit line WITHOUT completing the ledger turn;
 * everything else goes through {@link handleAgentSuccess}. Moved here from `agent-runner.ts`
 * (Phase 1.4) with the caller's `trigger` now threaded through — the three surfaces that open a
 * Turn pass `'user'`, `'edit-retry'` and `'ask-user-question'` respectively.
 */
export async function handleDefaultAgentResult({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, trigger, sessionName, sessionId, threadAnchorId, messageTs, callbacks, projectId, continuationToolUse, continuationToolResult, continuationContextUsage, backgroundRun = null }: {
  result: AgentResult; channel: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number;
  userMessage: string; executionId: string | null; trigger: string; sessionName: string | null; sessionId: string | null;
  threadAnchorId: string | null; messageTs: string | null;
  /** Only the assistant stream is read here; the full `AgentCallbacks` shape stays in `turn.ts`. */
  callbacks: { onAssistantMsg: ((text: string) => void) & { stream?: OutputStream } };
  projectId: string;
  continuationToolUse: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  continuationToolResult: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  continuationContextUsage: ((usage: ContextUsage) => void) | null;
  backgroundRun?: HeldRun | null;
}): Promise<void> {
  if (result?.rateLimited) {
    // Record the interrupted conversation so it auto-resumes when the rate-limit window
    // resets (rate-limit-throttle onResume → resume-dispatcher).
    recordDirectResume({ provider: result.rateLimitProvider, channel, trackSessionId: sessionId, userMessage });
    const { elapsedStr } = computeElapsed(startTime);
    const rateLimitText = renderTurnStatus({ kind: 'rate-limited' }, { sessionName, sessionId, elapsedStr });
    await sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
    return;
  }
  await handleAgentSuccess({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, trigger, sessionName, trackSessionId: sessionId, threadAnchorId, userMessageTs: messageTs, projectId, onAssistantMessage: callbacks.onAssistantMsg, onToolUse: continuationToolUse, onToolResult: continuationToolResult, onContextUsage: continuationContextUsage, backgroundRun });
}
