// input:  a turn's terminal result or error, plus its mutation lease
// output: turn tracking + snapshot barriers, and the success/failure finalization of a turn
// pos:    orchestration — where a turn opens and closes; the surfaces that render it live in
//         status-renderer.ts / web-status-renderer.ts, and the follow-up runs in edit-retry.ts
//         and interactions/ask-user-resume.ts
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { createLogger } from '@core/log.js';
import { t } from '../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef, OutputStream } from '@platform/index.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import { supersededEdits } from './superseded-edits.js';
import { acquireTurnMutationLock, type TurnMutationRelease } from './turn-mutation-lock.js';

import { renderTurnStatus, computeElapsed, formatMetricsSuffix, sealStatus, buildSealedStatusActionBlocks } from './status-helpers.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { runMessageEndForTurn } from '@domain/sessions/session-hooks.js';
import * as askUserQuestion from './interactions/ask-user-question.js';
import { getActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';

import { maybeNotifyTurnComplete } from './turn-notify.js';
import { holdBackgroundStatus, type HeldRun } from './status-renderer.js';
import { recordDirectResume } from '@domain/runs/observers/resume-recorder.js';
import { isApiRateLimitError } from '@domain/agents/config.js';
import { isProviderRateLimited } from '@domain/costs/rate-limit-throttle.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { durablePost } from './durable-helpers.js';

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

  // Plan delivery is owned by the ExitPlanMode PreToolUse hook (hooks/exit-plan-mode-hook.mjs),
  // which forwards the plan through webhook /hook/exit-plan-mode → sendPlanToSlack.
  // Re-sending here would duplicate the plan message (and historically could
  // desync when the hook's mtime-based lookup picked a stale file).

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
async function persistErrorSession(args: {
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
