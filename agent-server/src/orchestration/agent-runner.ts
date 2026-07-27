// input:  conversation execution, lifecycle, queue, DEBUG gate, pending store
// output: AgentRunner with live/durable transcript and injection wiring
// pos:    Sole plain user-message path, including injected and background continuation turns
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import type { Destination, PlatformAdapter, MessageRef, DownloadedFile, IncomingMessage, PlatformFileRef, OutputStream } from '@platform/index.js';
import { resolveDestinationConduit, SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { conduitQueues, enqueue } from './conduit-queue.js';
import { trackPendingTask } from './busy-tracker.js';
import * as crypto from 'node:crypto';
import { getSessionAsync, setSessionAsync } from '@domain/sessions/session.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { conversationHistory, summarizeToolInputForHistory } from '@store/conversation-history-repo.js';
import { pendingInjectionRepo } from '@store/pending-injection-repo.js';
import { getActiveProfile, getDefaultAgent, resolveBackendForChannel } from '@domain/agents/index.js';
import { registerNamedSession } from '@domain/sessions/session-lifecycle.js';
import { handleAgentSuccess, handleAgentError, initTurnTracking } from './lifecycle.js';
import { buildSessionTag, buildUserProcessingMessage, makeFallbackNotifier, makeStreamingMessageCallback, computeElapsed, writeStatus, sealStatus, buildStatusActionBlocks, buildSealedStatusActionBlocks, initStatusBlocks } from './status-helpers.js';
import { readFileSync } from 'fs';
import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { buildDurableHooks } from './durable-helpers.js';

const log = createLogger('agent-runner');
import { createToolTrace } from '@platform/index.js';
import { setStreamingCallback, clearStreamingCallback, publishPlanSubmitted, publishAskUserRequested } from './routing/hook-bridge.js';
import { publishSessionDebugUpdated, publishSessionMessage, publishSessionMessageDelivered, publishSessionStatus, publishSessionTurn } from './session-events.js';
import { createSessionDeltaStream } from './delta-coalescer.js';
import { isInjectableMessage, tryInjectIntoLiveTurn, type MidTurnInjectDeps } from './mid-turn-inject.js';
import { commitPendingInjection } from './pending-injection-recovery.js';
import { getStreamingCallback } from './routing/hook-bridge.js';
import { runningExecutions } from '@core/running-executions.js';
import { bgHeldSessions } from '@core/bg-held-sessions.js';
import { maybeNotifyCodexLowUsage } from '@domain/costs/codex-usage-monitor.js';
import { recordResume } from '@domain/costs/resume-registry.js';
import { getAgent } from '@domain/threads/index.js';
import { runConversation } from './conversation-runner.js';
import { tryAnswerFromHuman } from './manager-qa.js';
import { shouldHoldForBg, shouldHoldWebForBg } from './bg-continuation.js';
import { holdWebForBg } from './web-bg-hold.js';
import type { ContinuationSink } from '../agent-adapter/types.js';
import { downloadFiles as downloadPlatformFiles } from './routing/file-handler.js';
import { WORKSPACE_DIR, resolveWorkspaceRelPath } from '@core/utils.js';

const TEMP_DIR = WORKSPACE_DIR;

type Enqueuer = (channel: string, fn: () => Promise<void>) => boolean;
type Tracker = (delta: number) => void;
type Executor = (ctx: AgentRunnerCtx) => Promise<void>;
/** Attempt mid-turn injection; true ⇒ the message was delivered into the live turn and must NOT
 *  be queued. Injectable so the routing branch is testable without a live backend. */
type Injector = (ctx: AgentRunnerCtx) => Promise<boolean>;

interface AgentConfig {
  effectiveMessage: string;
  profileForRun: string;
  defaultAgentName: string | null;
  claudeAgent: string | null;
  systemPrompt: string | null;
  outputStyle: string | null;
  tools: string | null;
  pluginDirs: string[] | null;
}

interface AgentCallbacks {
  onFallback: (...args: any[]) => Promise<void>;
  onAssistantMsg: ((text: string) => void) & { stream?: OutputStream };
  onProgress: (progress: any) => void;
  onToolUse: ((name: string, input: any, toolUseId: string) => void) | null;
}

export interface AgentRunnerCtx {
  message: IncomingMessage;
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  hasFiles: boolean;
  userMessage: string;
  agentMessage: string;
}

export class AgentRunner {
  readonly _enqueue: Enqueuer;
  readonly _track: Tracker;
  /** Injectable for unit tests — allows verification of track(-1)-in-finally without spawning Claude. */
  readonly _execute: Executor;
  readonly _tryInject: Injector;

  constructor(opts: { enqueue?: Enqueuer; track?: Tracker; execute?: Executor; tryInject?: Injector } = {}) {
    this._enqueue = opts.enqueue ?? enqueue;
    this._track = opts.track ?? trackPendingTask;
    this._execute = opts.execute ?? ((ctx) => this._executeReal(ctx));
    this._tryInject = opts.tryInject ?? ((ctx) => this._tryInjectReal(ctx));
  }

  async route(ctx: AgentRunnerCtx): Promise<void> {
    const { message, channel, adapter } = ctx;
    // DR-0016 top-level fallback: if this channel has a pending human-escalated subtask question,
    // consume this message as the answer and short-circuit normal turn handling. Scope is narrow —
    // tryAnswerFromHuman returns false unless this exact channel is awaiting a human reply.
    // Synthetic wake/callback messages (wakeSession) are exempt: askManager arms this backstop and
    // then wakes the origin session THROUGH route(), so without the exemption the backstop consumed
    // the question notice itself as "the human's answer" (2026-07-05 self-consumption bug).
    if (message.senderId !== SYNTHETIC_CALLBACK_SENDER && tryAnswerFromHuman(channel, ctx.userMessage || '')) {
      const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
      await adapter.postMessage(dest, { text: `${Icons.ok} ${t('subtask.replyDelivered')}` }).catch(() => {});
      return;
    }
    // A plain user message arriving while this channel already has a live turn is delivered INTO
    // that turn (backend stdin) rather than waiting behind it, when the backend can take it. The
    // injection path then owns the message end-to-end — its own surfacing, delivery ack and busy
    // bracket — so we return before the queue machinery. Everything it declines (no live turn,
    // incapable backend, !command, synthetic wake, backend refusal) falls through to today's
    // queue behaviour unchanged.
    if (await this._tryInject(ctx)) return;
    if (conduitQueues.has(channel)) {
      await adapter.markQueued({ conduit: channel, messageId: message.ref.messageId }).catch(() => {});
    }
    this._track(+1);

    this._enqueue(channel, async () => {
      try {
        await this._execute(ctx);
      } finally {
        this._track(-1);
      }
    });
  }

  /**
   * Production mid-turn injection: resolve this channel's live turn and session, then hand the
   * message to `mid-turn-inject`. Ordered cheapest-gate-first because route() is the hot path for
   * every inbound message — the store lookups only run once a live turn is actually present.
   */
  private async _tryInjectReal(ctx: AgentRunnerCtx): Promise<boolean> {
    try {
      if (!isInjectableMessage({ text: ctx.userMessage || '', senderId: ctx.message.senderId })) return false;
      if (!runningExecutions.hasChannel(ctx.channel)) return false;
      const sessionId = await getSessionAsync(ctx.channel, resolveBackendForChannel(ctx.channel));
      if (!sessionId) return false;
      const sessionName = await sessionStore.lookupBySessionId(sessionId);
      return tryInjectIntoLiveTurn(buildInjectDeps(sessionName, ctx.channel), {
        channel: ctx.channel,
        sessionId,
        sessionName,
        profileName: getActiveProfile(ctx.channel),
        text: ctx.userMessage || '',
        senderId: ctx.message.senderId,
        messageId: ctx.message.ref.messageId,
        attachments: ctx.message.webAttachments,
      });
    } catch (e) {
      // Never let the injection attempt break routing — fall back to the queue.
      log.warn('mid-turn injection attempt failed, falling back to the queue:', (e as Error).message);
      return false;
    }
  }

  private async _executeReal(ctx: AgentRunnerCtx): Promise<void> {
    const { message, channel, adapter, threadAnchorId, hasFiles, userMessage, agentMessage } = ctx;
    const downloadedFiles = await downloadFiles(message.files, hasFiles, adapter);
    // Web-uploaded attachments are already on disk — map to DownloadedFile shape.
    // The `path` field from upload is the UI-relative `workspace/attachments/...` alias for
    // WORKSPACE_DIR's contents; resolveWorkspaceRelPath maps it to the real absolute path under
    // WORKSPACE_DIR (= <DATA_DIR>/tmp). A malformed/escaping path resolves to null and is dropped,
    // so a broken path is never handed to the agent as a bogus absolute file.
    const allFiles = [
      ...downloadedFiles,
      ...(message.webAttachments ?? []).flatMap((a) => {
        const localPath = resolveWorkspaceRelPath(a.path);
        return localPath ? [{ localPath, mimetype: a.mimeType, name: a.name }] : [];
      }),
    ];
    const startTime = Date.now();
    const backend = resolveBackendForChannel(channel);
    // `sessionId` here is the STABLE tracking id — sessions.json now binds channel → track id (not the
    // backend id). Everything below (publish/history/status/Destination) keys on it. The backend
    // resume target is resolved separately as `backendSessionId`. A channel with no bound session yet
    // (fresh Slack/Feishu/etc.) mints + registers + binds a track id up front, unifying it with the
    // web path (createDirectSession pre-registers) so publish/history always have a stable key.
    let sessionId = await getSessionAsync(channel, backend);
    let sessionName: string;
    let backendSessionId: string | null;
    let projectId: string;
    if (sessionId) {
      sessionName = await resolveSessionName(sessionId, channel, userMessage, adapter);
      const rec = await sessionStore.getById(sessionId);
      backendSessionId = rec ? effectiveBackendSessionId(rec) : null;
      projectId = rec?.projectId ?? 'general';
    } else {
      sessionId = crypto.randomUUID();
      projectId = (await adapter.resolveInboundProject(channel)) ?? 'general';
      sessionName = await registerNamedSession(sessionStore, {
        sessionId, channel, backend,
        label: userMessage?.substring(0, 60) ?? null,
        profileName: getActiveProfile(channel), projectId,
      });
      await setSessionAsync(channel, sessionId, backend); // bind channel → track id
      backendSessionId = null; // fresh: the backend self-assigns its id on this first turn
    }
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId };

    // 1. Orchestration side effects (keep — ledger, status, hook-bridge)
    const statusText = buildUserProcessingMessage({ startTime, profileName: getActiveProfile(channel), sessionName, sessionId });
    const blocksTemplate = { channel, sessionName, isDm: true };
    // Post status message WITHOUT Cancel button initially — Cancel is added once runConversation
    // creates the execution record (onExecutionStarted), keyed by executionId (no thread).
    const statusMsg = await adapter.postMessage(dest, {
      text: statusText,
      richBlocks: buildSealedStatusActionBlocks(statusText, blocksTemplate),
    }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
    const messageTs = message.ref.messageId;
    await initTurnTracking(channel, sessionId, backendSessionId, sessionName, messageTs, userMessage || '', statusMsg.messageId);
    // Backend-independent conversation history (keyed by sessionId, the TUI display source).
    // Record the user message now; assistant messages + tool calls are appended via the
    // callbacks below as they stream. Only when we have a sessionId to key by.
    if (sessionId) {
      // Share a single timestamp between the conversation-history entry and the EventBus
      // event so the web UI's content-based de-dup (transcript query vs SSE live-tail)
      // produces identical msgKeys for the same message.
      const userTs = new Date().toISOString();
      recordHistory(conversationHistory.appendUser(sessionId, {
        text: userMessage || '',
        ts: userTs,
        attachments: message.webAttachments,
      }));
      publishSessionMessage({
        sessionId,
        channel,
        role: 'user',
        text: userMessage || '',
        ts: userTs,
        attachments: message.webAttachments,
      });
      // Give an unlabeled session a human-readable title from its first user message (web sessions are
      // pre-registered without a label; this is the single unified place a session gets titled).
      void ensureSessionLabel(sessionName, userMessage || '');
    }
    const onMessagePosted = (ref: MessageRef) => void conversationLedger.addResponseTs(channel, messageTs, ref.messageId).catch((e) => log.error(e));
    // 2. Build agent callbacks (streaming, fallback, progress)
    const callbacks = buildAgentCallbacks(adapter, dest, statusMsg, threadAnchorId, startTime, sessionName, sessionId, onMessagePosted);

    // 3. Build PI interactive-event callbacks (plan approval / ask-user-question routing).
    //    No threadId — plain user messages are no longer wrapped in a thread.
    const interactiveCallbacks = buildInteractiveCallbacks(channel, sessionId, null);

    // 4. Run the conversation turn directly (no thread). The Cancel button is attached once the
    //    execution record exists (execution-scoped cancel), via onExecutionStarted.
    // Emit the REAL running state for the S4 chat indicator: true now, false in the finally below.
    if (sessionId) publishSessionStatus({ sessionId, channel, running: true });
    let capturedExecutionId: string | null = null;
    // Web background-task hold: when set, the turn ended with a live background task and a
    // ContinuationSink was registered to stream the spontaneous continuation. The hold owns the
    // terminal running:false publish, so the finally below must NOT seal the session idle.
    let webBgHeld = false;
    // Token-level streaming for the Web chat. Null for every other surface (Slack / Feishu /
    // Ink-TUI / threads) and when the feature is off, so those paths keep receiving complete
    // messages only. Lives for the turn; sealed in the finally below.
    const deltaStream = createSessionDeltaStream({ sessionId, channel });
    const debugEnabled = isDebugMode();
    const persistToolUse = (name: string, input: any, toolUseId: string): void => {
      const toolInput = summarizeToolInputForHistory(input);
      const ts = new Date().toISOString();
      recordHistory(
        conversationHistory.appendTool(sessionId, {
          toolName: name,
          toolInput,
          ts,
          ...(debugEnabled ? { toolUseId, fullInput: input } : {}),
        }),
        debugEnabled ? () => publishSessionDebugUpdated({ sessionId, channel }) : undefined,
      );
      publishSessionMessage({ sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts });
    };
    const persistToolResult = debugEnabled
      ? (toolUseId: string, content: string, isError: boolean): void => {
          recordHistory(
            conversationHistory.appendToolResult(sessionId, { toolUseId, content, isError }),
            () => publishSessionDebugUpdated({ sessionId, channel }),
          );
        }
      : null;
    try {
      const convResult = await runConversation({
        adapter, channel,
        userMessage: agentMessage,
        trackSessionId: sessionId,
        projectId,
        backendSessionId,
        sessionName,
        files: allFiles,
        startTime,
        trigger: 'user',
        onExecutionStarted: async (executionId) => {
          capturedExecutionId = executionId;
          const blocksTemplateWithExec = { ...blocksTemplate, executionId };
          await adapter.updateMessage(statusMsg, {
            text: statusText,
            richBlocks: buildStatusActionBlocks(statusText, blocksTemplateWithExec),
          }).catch(() => {});
          initStatusBlocks(statusMsg, blocksTemplateWithExec);
        },
        onAssistantDelta: deltaStream ? (text: string, blockId: string) => deltaStream.onDelta(text, blockId) : null,
        onAssistantMessage: (text: string, blockId?: string) => {
          // Drain this block's preview FIRST: the authoritative message must never be overtaken by
          // a delta still sitting in the coalescer, or the UI would replace the row and then append
          // a stale fragment to it.
          if (blockId) deltaStream?.flush(blockId);
          callbacks.onAssistantMsg(text);
          if (sessionId && text) {
            const ts = new Date().toISOString();
            recordHistory(conversationHistory.appendAssistant(sessionId, { text, ts }));
            publishSessionMessage({ sessionId, channel, role: 'assistant', text, ts, ...(blockId ? { blockId } : {}) });
          }
        },
        onPromptBuilt: debugEnabled ? (prompt: string) => {
          recordHistory(
            conversationHistory.appendUserPrompt(sessionId, { agentMessage: prompt }),
            () => publishSessionDebugUpdated({ sessionId, channel }),
          );
        } : null,
        onProgress: (progress: any) => {
          callbacks.onProgress(progress);
          // S4 chat: surface the REAL agent-turn count live (snapshot on the running execution +
          // `session.turn` delta) so the Web composer shows turns that grow as the agent works.
          emitTurnProgress(
            {
              sessionId,
              channel,
              executionId: capturedExecutionId,
              setNumTurns: (n) => { if (capturedExecutionId) runningExecutions.setNumTurns(capturedExecutionId, n); },
              publish: (n) => { if (sessionId) publishSessionTurn({ sessionId, channel, numTurns: n }); },
            },
            progress,
          );
        },
        onFallback: callbacks.onFallback,
        onToolUse: composeToolUse(
          composeToolUse(callbacks.onToolUse, interactiveCallbacks.onToolUse),
          persistToolUse,
        ),
        onToolResult: persistToolResult,
        onPlanWritten: interactiveCallbacks.onPlanWritten,
        onAskUserQuestion: interactiveCallbacks.onAskUserQuestion,
      });
      // Background-task continuation: if the turn left background work remaining (running OR
      // finished-but-unnotified) and the feature is enabled for this interactive channel, keep
      // the streaming callback alive so the spontaneous continuation turn merges into the same
      // reply (handleAgentSuccess holds the status, registers a sink, and arms the bg-wait-guard).
      // Otherwise clear the callback as usual.
      const proc = convResult.agentProcess as { setContinuationSink?: (s: ContinuationSink) => void } | undefined;
      const canSink = typeof proc?.setContinuationSink === 'function';
      const holdForBg = shouldHoldForBg(convResult.result, channel, canSink);
      if (!holdForBg) clearStreamingCallback(channel);
      await maybeNotifyCodexLowUsage({ adapter, result: convResult.result });
      await handleDefaultAgentResult({
        result: convResult.result, channel, adapter, statusMsg, startTime, userMessage,
        executionId: convResult.executionId,
        sessionName, sessionId, threadAnchorId, messageTs, callbacks, projectId,
        continuationToolUse: composeToolUse(callbacks.onToolUse, persistToolUse),
        continuationToolResult: persistToolResult,
        registerContinuationSink: holdForBg ? (sink: ContinuationSink) => proc!.setContinuationSink!(sink) : null,
      });
      // Web background-task hold: the Slack/Feishu status-message hold (above) never fires for a
      // web: channel. Keep the session marked running+backgroundRunning and stream the spontaneous
      // continuation as new session messages, instead of dropping it and sealing the session idle.
      if (sessionId && shouldHoldWebForBg(convResult.result, channel, canSink)) {
        const sid = sessionId;
        webBgHeld = holdWebForBg({
          result: convResult.result,
          registerSink: (sink) => proc!.setContinuationSink!(sink),
          // Stop during the hold: the cancel path finds the hold by channel in this registry and
          // fires the abort to seal it (see core/bg-held-sessions.ts).
          registerAbort: (abort) => bgHeldSessions.setAbort(sid, abort),
          track: trackPendingTask,
          publishStatus: ({ running, backgroundRunning }) => publishSessionStatus({ sessionId: sid, channel, running, backgroundRunning }),
          publishAssistant: (text) => {
            const ts = new Date().toISOString();
            recordHistory(conversationHistory.appendAssistant(sid, { text, ts }));
            publishSessionMessage({ sessionId: sid, channel, role: 'assistant', text, ts });
          },
          publishTool: persistToolUse,
          publishToolResult: persistToolResult ?? undefined,
        });
      }
    } catch (error) {
      clearStreamingCallback(channel);
      await handleAgentError({
        error: error as { message: string; cancelled?: boolean },
        channel, adapter, statusMsg, startTime,
        executionId: capturedExecutionId,
        sessionName, sessionId, threadAnchorId, userMessageTs: messageTs, userMessage,
      });
    } finally {
      // The turn is over (successfully, in error, or cancelled): no preview may outlive it.
      deltaStream?.dispose();
      // Skip the idle seal when a web bg-hold is active — it owns the terminal running:false
      // publish once the background work finishes (else the session flips to idle immediately and
      // the spontaneous continuation is untracked).
      if (sessionId && !webBgHeld) publishSessionStatus({ sessionId, channel, running: false });
    }
  }
}

export const agentRunner = new AgentRunner();

// --- Helpers ---

/** Dependencies for {@link emitTurnProgress} — side effects injected for testability. */
export interface TurnProgressDeps {
  sessionId: string | null;
  channel: string;
  executionId: string | null;
  /** Update the live agent-turn count on the running execution (snapshot for sessions.list). */
  setNumTurns: (numTurns: number) => void;
  /** Publish the `session.turn` delta for the live composer. */
  publish: (numTurns: number) => void;
}

/**
 * Translate an adapter `turn_progress`/`turn_complete` payload into the S4 chat's live agent-turn
 * signals: update the running execution's numTurns snapshot (when an executionId is known) and
 * publish a `session.turn` delta (when a sessionId is known). No-op unless `num_turns` is a finite
 * number — a progress event without a turn count carries nothing to show. Exposed for unit testing.
 */
export function emitTurnProgress(deps: TurnProgressDeps, progress: { num_turns?: unknown } | null | undefined): void {
  const n = progress?.num_turns;
  if (typeof n !== 'number' || !Number.isFinite(n)) return;
  if (deps.executionId) deps.setNumTurns(n);
  if (deps.sessionId) deps.publish(n);
}

/** Exposed for unit testing. */
export function resolveDefaultAgent(agentMessage: string, channel?: string): AgentConfig {
  const defaultAgentName = getDefaultAgent();
  const defaultAgentDef = defaultAgentName ? getAgent(defaultAgentName) : null;
  const profileForRun = (defaultAgentDef && defaultAgentDef.profile !== '__active__')
    ? defaultAgentDef.profile
    : getActiveProfile(channel);
  let effectiveMessage = agentMessage;
  if (defaultAgentDef?.directive) {
    effectiveMessage = defaultAgentDef.directive + '\n\n' + agentMessage;
  }
  return {
    effectiveMessage, profileForRun, defaultAgentName,
    claudeAgent: defaultAgentDef?.claudeAgent || null,
    systemPrompt: defaultAgentDef?.systemPrompt || null,
    outputStyle: defaultAgentDef?.outputStyle || null,
    tools: defaultAgentDef?.tools || null,
    pluginDirs: defaultAgentDef?.pluginDirs || null,
  };
}

async function handleDefaultAgentResult({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, sessionName, sessionId, threadAnchorId, messageTs, callbacks, projectId, continuationToolUse, continuationToolResult, registerContinuationSink = null }: {
  result: AgentResult; channel: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number;
  userMessage: string; executionId: string | null; sessionName: string; sessionId: string | null;
  threadAnchorId: string | null; messageTs: string; callbacks: AgentCallbacks; projectId: string;
  continuationToolUse: ((name: string, input: any, toolUseId: string) => void) | null;
  continuationToolResult: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  registerContinuationSink?: ((sink: ContinuationSink) => void) | null;
}): Promise<void> {
  if (result?.rateLimited) {
    // Record the interrupted conversation so it auto-resumes when the rate-limit window
    // resets (rate-limit-throttle onResume → resume-dispatcher).
    recordResume({ kind: 'direct', channel, userMessage, recordedAt: Date.now() });
    const { elapsedStr } = computeElapsed(startTime);
    const fallbackText = `${Icons.warning} ${buildSessionTag(sessionName, sessionId)}Rate limited — all fallbacks exhausted (${elapsedStr})`;
    await sealStatus(adapter, statusMsg, fallbackText, buildSealedStatusActionBlocks(fallbackText, { channel, sessionName, isDm: true }));
    return;
  }
  await handleAgentSuccess({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, trigger: 'user', sessionName, threadAnchorId, userMessageTs: messageTs, projectId, onAssistantMessage: callbacks.onAssistantMsg, onToolUse: continuationToolUse, onToolResult: continuationToolResult, registerContinuationSink });
}

/**
 * Production side-effect wiring for {@link tryInjectIntoLiveTurn} — the same history / bus /
 * busy-gate seams `_executeReal` uses for an ordinary turn, so an injected message and a queued one
 * land in the transcript identically.
 */
function buildInjectDeps(sessionName: string | null, channel: string): MidTurnInjectDeps {
  return {
    getLiveExecutions: (channel) => runningExecutions.getByChannel(channel),
    getStreamingCallback,
    appendAssistant: (sessionId, o) => recordHistory(conversationHistory.appendAssistant(sessionId, o)),
    appendTool: (sessionId, o) => recordHistory(
      conversationHistory.appendTool(sessionId, o),
      o.fullInput !== undefined ? () => publishSessionDebugUpdated({ sessionId, channel }) : undefined,
    ),
    appendToolResult: (sessionId, o) => recordHistory(
      conversationHistory.appendToolResult(sessionId, o),
      () => publishSessionDebugUpdated({ sessionId, channel }),
    ),
    publishMessage: publishSessionMessage,
    publishDelivered: publishSessionMessageDelivered,
    publishStatus: publishSessionStatus,
    persistPending: (record) => pendingInjectionRepo.add(record),
    commitPending: (record) => commitPendingInjection(record),
    track: trackPendingTask,
    summarizeToolInput: (input) => summarizeToolInputForHistory(input),
    captureDebug: isDebugMode(),
    now: () => new Date().toISOString(),
  };
}

/** Set a session's display label from its first user message when it has none yet (best-effort,
 *  fire-and-forget). New Slack/inbound sessions already get a label at registration; web sessions are
 *  created label-less (before any message), so this titles them on the first turn — the LeftRail then
 *  shows the message text instead of the opaque `cortex-XXXX` name. */
async function ensureSessionLabel(sessionName: string, userMessage: string): Promise<void> {
  const text = userMessage.trim();
  if (!text) return;
  try {
    const rec = await sessionStore.lookupSession(sessionName);
    if (rec && (!rec.label || rec.label.trim() === '')) {
      await sessionStore.updateSession(sessionName, { label: text.slice(0, 60) });
    }
  } catch { /* best-effort — the label is cosmetic */ }
}

export async function resolveSessionName(sessionId: string | null, channel: string, userMessage: string, adapter: PlatformAdapter): Promise<string> {
  if (sessionId) {
    const existing = await sessionStore.lookupBySessionId(sessionId);
    if (existing) return existing;
    const channelProject = await adapter.resolveInboundProject(channel);
    return registerNamedSession(sessionStore, {
      sessionId,
      channel,
      backend: resolveBackendForChannel(channel),
      label: userMessage?.substring(0, 60),
      profileName: getActiveProfile(channel),
      projectId: channelProject ?? 'general',
    });
  }
  return sessionStore.generateSessionName();
}

function buildAgentCallbacks(adapter: PlatformAdapter, destination: Destination, statusMsg: MessageRef, threadAnchorId: string | null, startTime: number, sessionName: string, sessionId: string | null, onMessagePosted: (ref: MessageRef) => void): AgentCallbacks {
  const channel = resolveDestinationConduit(destination);
  const onFallback = makeFallbackNotifier(channel, statusMsg, adapter);
  const queue = getOutboundQueue();
  const durable = queue ? buildDurableHooks(queue) : null;
  const baseAssistantMsg = makeStreamingMessageCallback(adapter, destination, threadAnchorId, onMessagePosted, durable);

  // Tool trace: when CORTEX_SHOW_TOOL_CALLS is enabled, emit a compact per-tool Slack line
  // that merges consecutive same-tool calls and splits on different tool / assistant text.
  const toolTrace = createToolTrace(baseAssistantMsg.stream);
  const onAssistantMsg: AgentCallbacks['onAssistantMsg'] = toolTrace
    ? Object.assign((text: string) => { toolTrace.flush(); baseAssistantMsg(text); }, { stream: baseAssistantMsg.stream })
    : baseAssistantMsg;
  const onToolUse = toolTrace ? (name: string, input: any) => toolTrace.onToolUse(name, input) : null;

  setStreamingCallback(channel, onAssistantMsg);
  const onProgress = (progress: any) => {
    writeStatus(adapter, statusMsg, buildUserProcessingMessage({
      startTime,
      elapsed_s: progress?.duration_ms != null ? progress.duration_ms / 1000 : null,
      num_turns: progress?.num_turns ?? null,
      profileName: getActiveProfile(channel), sessionName, sessionId,
    }));
  };
  return { onFallback, onAssistantMsg, onProgress, onToolUse };
}

async function downloadFiles(files: PlatformFileRef[] | undefined, hasFiles: boolean, adapter: PlatformAdapter): Promise<DownloadedFile[]> {
  if (!hasFiles || !files) return [];
  return downloadPlatformFiles(files, adapter, TEMP_DIR);
}

/** Fire-and-forget history append; never let a logging write break the turn. */
function recordHistory(p: Promise<unknown>, onPersisted?: () => void): void {
  void p.then(() => onPersisted?.()).catch((e) => log.error('conversation-history write failed:', (e as Error).message));
}

/** Compose two optional onToolUse callbacks so both fire on each tool_use event. */
function composeToolUse(
  a: ((name: string, input: any, toolUseId: string) => void) | null,
  b: ((name: string, input: any, toolUseId: string) => void) | null,
): ((name: string, input: any, toolUseId: string) => void) | null {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return (name, input, toolUseId) => { a(name, input, toolUseId); b(name, input, toolUseId); };
}

/**
 * Build interactive callbacks for plan_written, ask_user_question, and tool_use events.
 * These fire during the turn (not after) and publish bus events so the existing
 * Slack interaction flow handles them.
 *
 * Exported so that all runThread call sites (thread-executor, scheduled-task,
 * task-dispatch) can wire these callbacks — without them, ask_user_question
 * events are silently dropped and the subprocess blocks forever.
 *
 * ORDERING INVARIANT: onToolUse fires synchronously before onAskUserQuestion
 * within the same event-loop tick (guaranteed by the PI adapter's sequential
 * event processing in event-parser.ts). The closure variables pendingAskInput
 * and pendingExitPlanMode rely on this ordering — onToolUse captures state
 * that onAskUserQuestion consumes. If the adapter ever processes events
 * asynchronously or out of order, this contract breaks silently.
 */
export function buildInteractiveCallbacks(channel: string, sessionId: string | null, threadId: string | null = null) {
  let pendingPlanContent: string | null = null;
  let pendingPlanPath: string | null = null;
  // Captured full tool input from tool_use event — used by onAskUserQuestion
  // so the Slack message gets the full Claude-style schema (header, options
  // with descriptions, multiSelect) instead of the degraded extension_ui_request data.
  let pendingAskInput: { questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> } | null = null;

  const onPlanWritten = (event: { path: string; content: string; toolUseId: string }) => {
    pendingPlanContent = event.content;
    pendingPlanPath = event.path;
  };

  // Track pending exit_plan_mode so the subsequent confirm() ask_user_question
  // is correctly routed as plan approval even when plan_written didn't fire
  // (happens when the LLM skips writing to a known plan directory).
  let pendingExitPlanMode: { plan?: string } | null = null;

  // Capture full tool input when the LLM calls ask_user_question (before the
  // tool shim calls ctx.ui.input which only emits a degraded extension_ui_request).
  const onToolUse = (name: string, input: any) => {
    if (name === 'AskUserQuestion' || name === 'ask_user_question') {
      pendingAskInput = input;
    }
    if (name === 'ExitPlanMode' || name === 'exit_plan_mode') {
      pendingExitPlanMode = input || {};
    }
  };

  const onAskUserQuestion = (event: { toolUseId: string; questions: Array<{ question: string; options?: string[]; multi?: boolean }> }) => {
    const requestId = crypto.randomUUID();
    if (pendingPlanContent !== null || pendingExitPlanMode !== null) {
      // This ask_user_question is the confirm() from exit_plan_mode → treat as plan approval.
      // pendingPlanContent comes from plan_written event (Write to a plan directory);
      // pendingExitPlanMode comes from tool_use event (LLM called exit_plan_mode directly).
      let planContent = pendingPlanContent ?? pendingExitPlanMode?.plan ?? '';
      // The file is the authoritative plan snapshot; ExitPlanMode.plan is often only a summary.
      if (pendingPlanPath) {
        try { const fileContent = readFileSync(pendingPlanPath, 'utf8'); if (fileContent.trim()) planContent = fileContent; } catch {}
      }
      publishPlanSubmitted(requestId, channel, sessionId ?? '', planContent, pendingPlanPath, event.toolUseId, threadId);
      pendingPlanContent = null;
      pendingPlanPath = null;
      pendingExitPlanMode = null;
    } else {
      // Use captured tool input (Claude-style schema) if available; fall back
      // to the degraded extension_ui_request data for backward compatibility.
      let questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
      if (pendingAskInput?.questions?.length) {
        questions = pendingAskInput.questions;
        pendingAskInput = null;
      } else {
        questions = event.questions.map((q) => ({
          question: q.question,
          options: q.options?.map((o) => ({ label: o, description: '' })) ?? [],
          multiSelect: false,
          header: q.question.substring(0, 12),
        }));
      }
      publishAskUserRequested(requestId, channel, sessionId ?? '', questions, event.toolUseId, threadId);
    }
  };

  return { onPlanWritten, onAskUserQuestion, onToolUse };
}
