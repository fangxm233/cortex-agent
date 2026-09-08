// input:  User turns, files, provider limits, callbacks
// output: Provider runs, transcripts, remote metadata, resumes
// pos:    Runs plain user messages and injections
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'path';
import type { Destination, PlatformAdapter, MessageRef, DownloadedFile, IncomingMessage, PlatformFileRef, OutputStream } from '@platform/index.js';
import { resolveDestinationConduit, SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import type { AgentResult, ChatNoticeLevel, ContextUsage, NoticeAction, SessionContextUsage, TodoSnapshot } from '@core/types/agent-types.js';
import { sessionTodos } from '@core/session-todos.js';
import { renderTodoProgress } from '../agent-adapter/normalize/todo.js';
import { conduitQueues, enqueue } from './conduit-queue.js';
import { trackPendingTask } from './busy-tracker.js';
import * as crypto from 'node:crypto';
import { getSessionAsync, setSessionAsync } from '@domain/sessions/session.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import type { Session } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { conversationHistory, summarizeToolInputForHistory, toolDeviceForHistory } from '@store/conversation-history-repo.js';
import { pendingInjectionRepo } from '@store/pending-injection-repo.js';
import { subagentPayloadFields, subagentRowRef } from './subagent-rows.js';
import { subagentSpawnFromAttribution, subagentSpawnsFromToolCall } from '../agent-adapter/normalize/event-types.js';
import type { ToolUseSubagent } from '../agent-adapter/normalize/event-types.js';
import { getActiveProfile, getDefaultAgent, resolveBackendForChannel } from '@domain/agents/index.js';
import { resolveProfileConfig } from '@domain/agents/profile-manager.js';
import { registerNamedSession } from '@domain/sessions/session-lifecycle.js';
import { consumePendingTurnSupersession, finishTurnTracking, handleAgentSuccess, handleAgentError, initTurnTracking } from './lifecycle.js';
import { buildSessionTag, buildUserProcessingMessage, makeFallbackNotifier, makeStreamingMessageCallback, computeElapsed, writeStatus, sealStatus, buildStatusActionBlocks, buildSealedStatusActionBlocks, initStatusBlocks } from './status-helpers.js';
import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import { getSettings } from '@core/settings.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { buildDurableHooks } from './durable-helpers.js';

const log = createLogger('agent-runner');
import { createToolTrace } from '@platform/index.js';
import { setStreamingCallback, clearStreamingCallback, publishAskUserRequested } from './routing/hook-bridge.js';
import { publishSessionContextUsage, publishSessionDebugUpdated, publishSessionMessage, publishSessionMessageDelivered, publishSessionStatus, publishSessionTodos, publishSessionTurn } from './session-events.js';
import { createSessionDeltaStream } from './delta-coalescer.js';
import { isInjectableMessage, tryInjectIntoLiveTurn, type MidTurnInjectDeps } from './mid-turn-inject.js';
import { commitPendingInjection } from './pending-injection-recovery.js';
import { getStreamingCallback } from './routing/hook-bridge.js';
import { runningExecutions } from '@core/running-executions.js';
import { bgHeldSessions } from '@core/bg-held-sessions.js';
import { recordResume } from '@domain/costs/resume-registry.js';
import { isProviderRateLimited } from '@domain/costs/rate-limit-throttle.js';
import { getAgent } from '@domain/threads/index.js';
import { runConversation } from './conversation-runner.js';
import { acquireBrowser, releaseBrowser, backendSupportsBrowser, BROWSER_DEVICE_SERVER } from '@platform/browser/managed-browser.js';
import { acquireDeviceBrowser, releaseDeviceBrowser } from '@domain/remote/device-browser.js';
import { tryAnswerFromHuman } from './manager-qa.js';
import { shouldHoldForBg, shouldHoldWebForBg } from './bg-continuation.js';
import { holdWebForBg } from './web-bg-hold.js';
import type { ContinuationSink } from '../agent-adapter/types.js';
import { downloadFiles as downloadPlatformFiles } from './routing/file-handler.js';
import { WORKSPACE_DIR, resolveWorkspaceRelPath } from '@core/utils.js';
import { acquireTurnMutationLock, type TurnMutationRelease } from './turn-mutation-lock.js';

const TEMP_DIR = WORKSPACE_DIR;

type Enqueuer = (channel: string, fn: () => Promise<void>) => boolean;
type Tracker = (delta: number) => void;
type PlatformFileLoader = () => Promise<DownloadedFile[]>;
type Executor = (
  ctx: AgentRunnerCtx, mutationRelease: TurnMutationRelease, loadPlatformFiles: PlatformFileLoader,
) => Promise<void>;
/** Attempt mid-turn injection; true ⇒ the message was delivered into the live turn and must NOT
 *  be queued. Injectable so the routing branch is testable without a live backend. */
type Injector = (ctx: AgentRunnerCtx, loadPlatformFiles: PlatformFileLoader) => Promise<boolean>;

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
  onToolUse: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  /** Latest task list, used to keep the platform status line in step with the agent's plan. */
  onTodoUpdate: ((snapshot: TodoSnapshot) => void) | null;
}

interface SessionUseLease {
  session: Session;
  release: () => void;
}

/** The session's backend decides whether a browser can be driven at all; the profile's
 *  `claudeBackend` decides whether it is the print adapter — the only one wired for it. */
function browserBackendSupported(channel: string, backend: string): boolean {
  let claudeBackend: string | null = null;
  try {
    claudeBackend = resolveProfileConfig(getActiveProfile(channel)).claudeBackend;
  } catch {
    // Unknown profile: fall back to the backend alone rather than refusing outright.
  }
  return backendSupportsBrowser(backend, claudeBackend);
}

function acceptUserMessage(opts: {
  sessionId: string;
  channel: string;
  sessionName: string;
  text: string;
  attachments: IncomingMessage['webAttachments'];
}): void {
  const ts = new Date().toISOString();
  recordHistory(conversationHistory.appendUser(opts.sessionId, {
    text: opts.text, ts, attachments: opts.attachments,
  }));
  publishSessionMessage({
    sessionId: opts.sessionId, channel: opts.channel, role: 'user',
    text: opts.text, ts, attachments: opts.attachments,
  });
  void ensureSessionLabel(opts.sessionName, opts.text);
}

export interface AgentRunnerCtx {
  message: IncomingMessage;
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  hasFiles: boolean;
  userMessage: string;
  agentMessage: string;
  mutationRelease?: TurnMutationRelease;
}

interface ForegroundSessionDeps {
  abortHold: (sessionId: string) => unknown;
  publishRunning: (event: { sessionId: string; channel: string; running: boolean }) => void;
}

/** A foreground turn supersedes any background-only hold on the same session. Release the old
 * busy bracket before publishing running:true; the reverse order lets the status subscriber erase
 * the abort handle while its guard remains live until the 30-minute cap. */
export function beginForegroundSession(
  sessionId: string | null,
  channel: string,
  deps: ForegroundSessionDeps = {
    abortHold: (id) => bgHeldSessions.abort(id),
    publishRunning: publishSessionStatus,
  },
): void {
  if (!sessionId) return;
  deps.abortHold(sessionId);
  deps.publishRunning({ sessionId, channel, running: true });
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
    this._execute = opts.execute ?? ((ctx, release, load) => this._executeReal(ctx, release, load));
    this._tryInject = opts.tryInject ?? ((ctx, load) => this._tryInjectReal(ctx, load));
  }

  async route(ctx: AgentRunnerCtx): Promise<void> {
    const mutationRelease = ctx.mutationRelease ?? await acquireTurnMutationLock(ctx.channel);
    const loadPlatformFiles = createPlatformFileLoader(ctx);
    let queued = false;
    try {
      queued = await this._routeWithAdmission(ctx, mutationRelease, loadPlatformFiles);
    } finally {
      if (!queued) mutationRelease();
    }
  }

  private async _routeWithAdmission(
    ctx: AgentRunnerCtx,
    mutationRelease: TurnMutationRelease,
    loadPlatformFiles: PlatformFileLoader,
  ): Promise<boolean> {
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
      return false;
    }
    // A plain user message arriving while this channel already has a live turn is delivered INTO
    // that turn (backend stdin) rather than waiting behind it, when the backend can take it. The
    // injection path then owns the message end-to-end — its own surfacing, delivery ack and busy
    // bracket — so we return before the queue machinery. Everything it declines (no live turn,
    // incapable backend, !command, synthetic wake, backend refusal) falls through to today's
    // queue behaviour unchanged.
    if (await this._tryInject(ctx, loadPlatformFiles)) return false;
    const markerRef = conduitQueues.has(channel)
      ? { conduit: channel, messageId: message.ref.messageId }
      : null;
    if (markerRef) await adapter.markQueued(markerRef).catch(() => {});
    this._track(+1);
    this._enqueue(channel, () => this._runQueued(ctx, markerRef, mutationRelease, loadPlatformFiles));
    return true;
  }

  private async _runQueued(
    ctx: AgentRunnerCtx,
    markerRef: MessageRef | null,
    mutationRelease: TurnMutationRelease,
    loadPlatformFiles: PlatformFileLoader,
  ): Promise<void> {
    try {
      await this._execute(ctx, mutationRelease, loadPlatformFiles);
    } finally {
      mutationRelease();
      if (markerRef) await ctx.adapter.unmarkQueued(markerRef).catch(() => {});
      this._track(-1);
    }
  }

  /**
   * Production mid-turn injection: resolve this channel's live turn and session, then hand the
   * message to `mid-turn-inject`. Ordered cheapest-gate-first because route() is the hot path for
   * every inbound message — the store lookups only run once a live turn is actually present.
   */
  private async _tryInjectReal(ctx: AgentRunnerCtx, loadPlatformFiles: PlatformFileLoader): Promise<boolean> {
    try {
      if (!isInjectableMessage({ text: ctx.userMessage || '', senderId: ctx.message.senderId })) return false;
      if (!runningExecutions.hasChannel(ctx.channel)) return false;
      const sessionId = await getSessionAsync(ctx.channel, resolveBackendForChannel(ctx.channel));
      if (!sessionId) return false;
      const sessionName = await sessionStore.lookupBySessionId(sessionId);
      return tryInjectIntoLiveTurn(buildInjectDeps(sessionName, ctx.channel, ctx.adapter), {
        channel: ctx.channel,
        sessionId,
        sessionName,
        profileName: getActiveProfile(ctx.channel),
        text: ctx.userMessage || '',
        senderId: ctx.message.senderId,
        messageId: ctx.message.ref.messageId,
        attachments: ctx.message.webAttachments,
        prepareBackendAttachments: async () => (await loadPlatformFiles()).map((file) => ({
          mimeType: file.mimetype,
          path: file.localPath,
        })),
      });
    } catch (e) {
      // Never let the injection attempt break routing — fall back to the queue.
      log.warn('mid-turn injection attempt failed, falling back to the queue:', (e as Error).message);
      return false;
    }
  }

  private async _executeReal(
    ctx: AgentRunnerCtx,
    mutationRelease: TurnMutationRelease,
    loadPlatformFiles: PlatformFileLoader,
  ): Promise<void> {
    const { message, channel, adapter, threadAnchorId, userMessage, agentMessage } = ctx;
    const downloadedFiles = await loadPlatformFiles();
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
    let sessionLease: SessionUseLease | null = null;
    /** Opt-in browser access, read off the session record (plan/embedded-browser.md §17). */
    let sessionBrowser: { device: string } | null = null;
    /** Set while the session is in commission mode but its contract has not been named yet; that
     *  is exactly the window in which the commission-creation tools are injected (DR-0037 v3). */
    let sessionCommissionDraft: string | null = null;
    /** Set once a contract has landed. Either field means the session is in commission mode. */
    let sessionCommissionId: string | null = null;
    if (sessionId) {
      sessionLease = await acquireSessionUseLease(sessionId);
      if (!sessionLease) throw new Error(`Session not found or pending deletion: ${sessionId}`);
      sessionName = sessionLease.session.name;
      backendSessionId = effectiveBackendSessionId(sessionLease.session);
      projectId = sessionLease.session.projectId ?? 'general';
      sessionBrowser = sessionLease.session.browser ?? null;
      // settings.commissionEnabled is the global switch for the feature (off by default while it
      // is under test). With it off, a session that was bound while it was on reverts to an
      // ordinary session: no commission tools, no commission skill, no contract block.
      const commissionOn = getSettings().commissionEnabled;
      sessionCommissionDraft = commissionOn ? sessionLease.session.commissionDraft ?? null : null;
      sessionCommissionId = commissionOn ? sessionLease.session.commissionId ?? null : null;
    } else {
      sessionId = crypto.randomUUID();
      projectId = (await adapter.resolveInboundProject(channel)) ?? 'general';
      sessionName = await registerNamedSession(sessionStore, {
        sessionId, channel, backend,
        label: userMessage?.substring(0, 60) ?? null,
        profileName: getActiveProfile(channel), projectId,
      });
      await setSessionAsync(channel, sessionId, backend); // bind channel → track id
      sessionLease = await acquireSessionUseLease(sessionId);
      if (!sessionLease) throw new Error(`Session not found or pending deletion: ${sessionId}`);
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
    const turnTrackingToken = await initTurnTracking(
      channel, sessionId, backendSessionId, sessionName,
      messageTs, userMessage || '', statusMsg.messageId,
      {
        mutationRelease,
        onAccepted: () => acceptUserMessage({
          sessionId, channel, sessionName, text: userMessage || '',
          attachments: message.webAttachments,
        }),
      },
    );
    if (consumePendingTurnSupersession(channel, turnTrackingToken)) {
      finishTurnTracking(channel, turnTrackingToken);
      return;
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
    beginForegroundSession(sessionId, channel);
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
    const persistToolUse = (
      name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent,
    ): void => {
      const toolInput = summarizeToolInputForHistory(input);
      const toolDevice = toolDeviceForHistory(name, input);
      const ts = new Date().toISOString();
      const ref = subagent ? subagentRowRef(subagent) : undefined;
      const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
      const subagentSpawns = attributedSpawn
        ? [attributedSpawn]
        : subagent ? [] : subagentSpawnsFromToolCall(name, input, toolUseId);
      const legacyAnchor = !subagent && name !== 'agent' && subagentSpawns.length === 1
        ? { id: subagentSpawns[0].id }
        : undefined;
      const rowRef = ref ?? legacyAnchor;
      recordHistory(
        conversationHistory.appendTool(sessionId, {
          toolName: name,
          toolInput,
          ...(toolDevice ? { toolDevice } : {}),
          ts,
          ...(rowRef ? { subagent: rowRef } : {}),
          ...(subagentSpawns.length ? { subagentSpawns } : {}),
          ...(debugEnabled ? { toolUseId, fullInput: input } : {}),
        }),
        debugEnabled ? () => publishSessionDebugUpdated({ sessionId, channel }) : undefined,
      );
      publishSessionMessage({
        sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts,
        ...(toolDevice ? { toolDevice } : {}),
        ...(subagentSpawns.length ? { subagentSpawns } : {}),
        ...subagentPayloadFields(rowRef),
      });
    };
    const persistToolResult = debugEnabled
      ? (toolUseId: string, content: string, isError: boolean): void => {
          recordHistory(
            conversationHistory.appendToolResult(sessionId, { toolUseId, content, isError }),
            () => publishSessionDebugUpdated({ sessionId, channel }),
          );
        }
      : null;
    // The authoritative end of one native subagent. Persisted as well as published: it is the only
    // evidence a later reader has that a subagent which ran BESIDE the main agent is over — the
    // event ordering in the transcript cannot express that, and a killed child leaves nothing else.
    // Fires both in-turn (the child finished while its parent turn was still open) and from the
    // background hold (it finished after the turn ended).
    const persistSubagentEnd = (
      parentToolUseId: string, status: 'completed' | 'failed' | 'killed',
    ): void => {
      if (!sessionId || !parentToolUseId) return;
      const ts = new Date().toISOString();
      recordHistory(conversationHistory.appendSubagentEnd(sessionId, {
        subagentId: parentToolUseId, status, ts,
      }));
      publishSessionMessage({
        sessionId, channel, role: 'assistant', text: '', ts,
        subagentId: parentToolUseId, subagentEnded: status,
      });
    };
    const persistContext = (usage: ContextUsage): Promise<void> => persistSessionContextUsage({
      sessionName, sessionId, channel, usage,
    });
    // Task-list snapshot: record it for `sessions.list` (the queryable snapshot) and publish the
    // delta, then refresh the platform status line so Slack/Feishu/Ink-TUI move too. Replace-all,
    // so this overwrites rather than merges.
    const persistTodos = (snapshot: TodoSnapshot): void => {
      if (sessionId) {
        sessionTodos.set(sessionId, snapshot);
        publishSessionTodos({ sessionId, channel, snapshot });
      }
      callbacks.onTodoUpdate?.(snapshot);
    };
    const persistContinuationContext = (usage: ContextUsage): void => {
      void persistContext(usage).catch((error) => {
        log.warn('continuation context persistence failed:', (error as Error).message);
      });
    };
    // A browser-enabled session holds the shared Chrome for the duration of its turn. Acquiring here
    // (rather than inside the adapter) keeps the spawn path synchronous and gives us one obvious
    // place to pair with a release. A browser that cannot start degrades the turn to "no browser
    // tools" instead of failing it — the session is still worth running.
    let browserHeld: 'server' | string | null = null;
    let browserCdpEndpoint: string | null = null;
    if (sessionBrowser && !browserBackendSupported(channel, backend)) {
      log.warn(`session opted into the browser but the ${backend} backend cannot use it — skipping`);
    } else if (sessionBrowser) {
      const device = sessionBrowser.device;
      try {
        // `server` is this host's own Chrome; anything else is a Chrome the device launches for us,
        // reachable only because the reverse channel maps its debugging port onto a local one. Both
        // hand back a plain http://127.0.0.1:<port>, so nothing downstream knows the difference.
        browserCdpEndpoint = device === BROWSER_DEVICE_SERVER
          ? (await acquireBrowser()).cdpEndpoint
          : (await acquireDeviceBrowser(device)).cdpEndpoint;
        browserHeld = device;
      } catch (error) {
        log.warn(`browser session requested on "${device}" but Chrome could not start: ${(error as Error).message}`);
      }
    }
    try {
      const convResult = await runConversation({
        adapter, channel,
        browserCdpEndpoint,
        commissionTools: !!sessionCommissionDraft,
        commissionMode: !!(sessionCommissionDraft || sessionCommissionId),
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
        onExecutionRegistered: () => {
          finishTurnTracking(channel, turnTrackingToken);
          sessionLease?.release();
          sessionLease = null;
        },
        onAssistantDelta: deltaStream ? (text: string, blockId: string) => deltaStream.onDelta(text, blockId) : null,
        onAssistantMessage: (text: string, blockId?: string, noticeLevel?: ChatNoticeLevel, noticeAction?: NoticeAction, subagent?: ToolUseSubagent) => {
          // Drain this block's preview FIRST: the authoritative message must never be overtaken by
          // a delta still sitting in the coalescer, or the UI would replace the row and then append
          // a stale fragment to it.
          if (blockId) deltaStream?.flush(blockId);
          const ref = subagent ? subagentRowRef(subagent) : undefined;
          const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
          // A subagent's prose is working notes addressed to its parent, not an answer addressed to
          // the user. Chat platforms get the live counter on the spawning call's trace line instead
          // (see tool-trace); the full text stays in the transcript, where it can be grouped.
          if (!ref) callbacks.onAssistantMsg(text);
          if (sessionId && text) {
            const ts = new Date().toISOString();
            recordHistory(conversationHistory.appendAssistant(sessionId, {
              text, ts, noticeLevel, noticeAction,
              ...(ref ? { subagent: ref } : {}),
              ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
            }));
            publishSessionMessage({
              sessionId, channel, role: 'assistant', text, ts,
              ...(blockId ? { blockId } : {}),
              ...(noticeLevel ? { noticeLevel } : {}),
              ...(noticeAction ? { noticeAction } : {}),
              ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
              ...subagentPayloadFields(ref),
            });
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
        onContextUsage: persistContext,
        onFallback: callbacks.onFallback,
        onTodoUpdate: persistTodos,
        onToolUse: composeToolUse(callbacks.onToolUse, persistToolUse),
        onToolResult: persistToolResult,
        onSubagentEnd: persistSubagentEnd,
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
      await handleDefaultAgentResult({
        result: convResult.result, channel, adapter, statusMsg, startTime, userMessage,
        executionId: convResult.executionId,
        sessionName, sessionId, threadAnchorId, messageTs, callbacks, projectId,
        continuationToolUse: composeToolUse(callbacks.onToolUse, persistToolUse),
        continuationToolResult: persistToolResult,
        continuationContextUsage: persistContinuationContext,
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
          publishAssistant: (text, subagent) => {
            const ts = new Date().toISOString();
            // Same rule as the in-turn path: a subagent's prose is persisted WITH its attribution
            // so the transcript can fold it into that subagent's block, instead of reading as the
            // agent's own answer arriving out of nowhere one turn late.
            const ref = subagent ? subagentRowRef(subagent) : undefined;
            recordHistory(conversationHistory.appendAssistant(sid, {
              text, ts, ...(ref ? { subagent: ref } : {}),
            }));
            publishSessionMessage({
              sessionId: sid, channel, role: 'assistant', text, ts, ...subagentPayloadFields(ref),
            });
          },
          publishTool: persistToolUse,
          publishToolResult: persistToolResult ?? undefined,
          publishSubagentEnd: persistSubagentEnd,
          publishContextUsage: persistContinuationContext,
          // Notices carry the level/action the plain assistant path drops. The foreground turn's
          // AttemptNoticeTracker has already retired by now, so without this a continuation that
          // hits the provider limit is queued for resume with nothing said about it in the chat.
          publishNotice: (text, noticeLevel, noticeAction) => {
            const ts = new Date().toISOString();
            recordHistory(conversationHistory.appendAssistant(sid, { text, ts, noticeLevel, noticeAction }));
            publishSessionMessage({
              sessionId: sid, channel, role: 'assistant', text, ts, noticeLevel,
              ...(noticeAction ? { noticeAction } : {}),
            });
          },
          onRateLimited: (continuation) => {
            const provider = continuation.rateLimitProvider ?? convResult.result.rateLimitProvider ?? null;
            if (!isProviderRateLimited(provider)) return false;
            recordResume({
              kind: 'direct', provider, channel, trackSessionId: sid,
              userMessage, recordedAt: Date.now(),
            });
            return true;
          },
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
      if (browserHeld === BROWSER_DEVICE_SERVER) releaseBrowser();
      else if (browserHeld) releaseDeviceBrowser(browserHeld);
      sessionLease?.release();
      finishTurnTracking(channel, turnTrackingToken);
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

export interface SessionContextUsagePersistenceDeps {
  now: () => string;
  update: (sessionName: string, updates: { contextUsage: SessionContextUsage }) => Promise<void>;
  publish: (snapshot: { sessionId: string; channel: string } & SessionContextUsage) => void;
}

const defaultContextUsagePersistence: SessionContextUsagePersistenceDeps = {
  now: () => new Date().toISOString(),
  update: (sessionName, updates) => sessionStore.updateSession(sessionName, updates),
  publish: publishSessionContextUsage,
};

/** Persist first, then publish the identical live snapshot so query and event clients converge. */
export async function persistSessionContextUsage(
  input: { sessionName: string; sessionId: string; channel: string; usage: ContextUsage },
  deps: SessionContextUsagePersistenceDeps = defaultContextUsagePersistence,
): Promise<void> {
  const contextUsage = { ...input.usage, updatedAt: deps.now() };
  await deps.update(input.sessionName, { contextUsage });
  deps.publish({ sessionId: input.sessionId, channel: input.channel, ...contextUsage });
}

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

async function handleDefaultAgentResult({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, sessionName, sessionId, threadAnchorId, messageTs, callbacks, projectId, continuationToolUse, continuationToolResult, continuationContextUsage, registerContinuationSink = null }: {
  result: AgentResult; channel: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number;
  userMessage: string; executionId: string | null; sessionName: string; sessionId: string | null;
  threadAnchorId: string | null; messageTs: string; callbacks: AgentCallbacks; projectId: string;
  continuationToolUse: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  continuationToolResult: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  continuationContextUsage: ((usage: ContextUsage) => void) | null;
  registerContinuationSink?: ((sink: ContinuationSink) => void) | null;
}): Promise<void> {
  if (result?.rateLimited) {
    // Record the interrupted conversation so it auto-resumes when the rate-limit window
    // resets (rate-limit-throttle onResume → resume-dispatcher).
    if (isProviderRateLimited(result.rateLimitProvider)) {
      recordResume({
        kind: 'direct', provider: result.rateLimitProvider ?? null,
        channel, trackSessionId: sessionId, userMessage, recordedAt: Date.now(),
      });
    }
    const { elapsedStr } = computeElapsed(startTime);
    const rateLimitText = `${Icons.warning} ${buildSessionTag(sessionName, sessionId)}${t('status.rateLimitedExhausted')} (${elapsedStr})`;
    await sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
    return;
  }
  await handleAgentSuccess({ result, channel, adapter, statusMsg, startTime, userMessage, executionId, trigger: 'user', sessionName, trackSessionId: sessionId, threadAnchorId, userMessageTs: messageTs, projectId, onAssistantMessage: callbacks.onAssistantMsg, onToolUse: continuationToolUse, onToolResult: continuationToolResult, onContextUsage: continuationContextUsage, registerContinuationSink });
}

/**
 * Production side-effect wiring for {@link tryInjectIntoLiveTurn} — the same history / bus /
 * busy-gate seams `_executeReal` uses for an ordinary turn, so an injected message and a queued one
 * land in the transcript identically.
 */
async function acquireSessionUseLease(sessionId: string): Promise<SessionUseLease | null> {
  const session = await sessionStore.getById(sessionId);
  if (!session) return null;
  const release = await sessionStore.acquireSessionUse(sessionId);
  if (!release) return null;
  return { session, release };
}

function buildInjectDeps(sessionName: string | null, channel: string, adapter: PlatformAdapter): MidTurnInjectDeps {
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
    onContextUsage: (sessionId, usageChannel, usage) => {
      if (!sessionName) return;
      void persistSessionContextUsage({
        sessionName, sessionId, channel: usageChannel, usage,
      }).catch((error) => log.warn('injected continuation context persistence failed:', (error as Error).message));
    },
    persistPending: (record) => pendingInjectionRepo.add(record),
    commitPending: (record) => commitPendingInjection(record),
    markPending: (record) => adapter.markQueued({ conduit: record.channel, messageId: record.messageId }),
    unmarkPending: (record) => adapter.unmarkQueued({ conduit: record.channel, messageId: record.messageId }),
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
  const onToolUse = toolTrace
    ? (name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) =>
        toolTrace.onToolUse(name, input, subagent, toolUseId)
    : null;

  setStreamingCallback(channel, onAssistantMsg);

  // The status message is the only persistent surface Slack / Feishu / Ink-TUI have (it is already
  // being edited in place on every turn_progress), so task progress rides it instead of posting
  // anything new. Both triggers render through one function so the two signals cannot disagree.
  let lastProgress: { duration_ms?: number | null; num_turns?: number | null } | null = null;
  let todoProgress = '';
  const renderStatus = (): void => {
    writeStatus(adapter, statusMsg, buildUserProcessingMessage({
      startTime,
      elapsed_s: lastProgress?.duration_ms != null ? lastProgress.duration_ms / 1000 : null,
      num_turns: lastProgress?.num_turns ?? null,
      profileName: getActiveProfile(channel), sessionName, sessionId,
      todoProgress: todoProgress || null,
    }));
  };
  const onProgress = (progress: any) => {
    lastProgress = progress ?? null;
    renderStatus();
  };
  const onTodoUpdate = (snapshot: TodoSnapshot) => {
    const next = renderTodoProgress(snapshot);
    // Agents re-submit an unchanged list fairly often. Rendering the same line again would spend a
    // platform message edit for no visible change, so only a real change forces a write; the
    // ordinary progress cadence covers everything else.
    if (next === todoProgress) return;
    todoProgress = next;
    renderStatus();
  };
  return { onFallback, onAssistantMsg, onProgress, onToolUse, onTodoUpdate };
}

function createPlatformFileLoader(ctx: AgentRunnerCtx): PlatformFileLoader {
  let pending: Promise<DownloadedFile[]> | null = null;
  return () => {
    pending ??= downloadFiles(ctx.message.files, ctx.hasFiles, ctx.adapter);
    return pending;
  };
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
  a: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null,
  b: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null,
): ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return (name, input, toolUseId, subagent) => {
    a(name, input, toolUseId, subagent);
    b(name, input, toolUseId, subagent);
  };
}

/** Route generic PI extension dialogs through the shared platform interaction UI. */
export function buildInteractiveCallbacks(
  channel: string,
  sessionId: string | null,
  threadId: string | null = null,
) {
  const onAskUserQuestion = (event: {
    toolUseId: string;
    questions: Array<{ question: string; options?: string[]; multi?: boolean }>;
  }) => {
    const questions = event.questions.map((question) => ({
      question: question.question,
      options: question.options?.map(label => ({ label, description: '' })) ?? [],
      multiSelect: question.multi ?? false,
      header: question.question.substring(0, 12),
    }));
    publishAskUserRequested(
      crypto.randomUUID(), channel, sessionId ?? '', questions, event.toolUseId, threadId,
    );
  };
  return { onPlanWritten: () => undefined, onAskUserQuestion, onToolUse: () => undefined };
}
