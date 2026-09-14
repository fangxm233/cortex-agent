// input:  an inbound platform message (or a synthetic one) already routed to a conduit
// output: that message delivered into a turn — injected into the live one, or queued and then
//         opened as a new turn through `openTurn`
// pos:    orchestration — the ADMISSION half of a conversation: mid-turn injection, the
//         per-channel queue, session find-or-create + lease, and the session's opted-in browser.
//         (The DR-0016 human-answer backstop is a ROUTING decision and lives one level up, in
//         `orchestrator.ts`.) Everything from the status message to the seal moved to
//         `turn/turn.ts` (Phase 1.4); the pre-turn resolution bodies live in `turn/turn-prep.ts`.
//         The `execute` seam still bypasses the Turn entirely — that is what the tests inject.
import type { PlatformAdapter, MessageRef, DownloadedFile, IncomingMessage, PlatformFileRef } from '@platform/index.js';
import { conduitQueues, enqueue } from './conduit-queue.js';
import { trackPendingTask } from './busy-tracker.js';
import * as crypto from 'node:crypto';
import { getSessionAsync, setSessionAsync } from '@domain/sessions/session.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { getActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';
import { registerNamedSession } from '@domain/sessions/session-lifecycle.js';
import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import { getSettings } from '@core/settings.js';
import { publishSessionDebugUpdated } from './session-events.js';
import { persistSessionContextUsage, type SessionContextUsagePersistenceDeps } from './transcript-sink.js';
import { isInjectableMessage, tryInjectIntoLiveTurn } from './mid-turn-inject.js';
import { runRegistry } from '@core/run-registry.js';
import { prepareConversationRequest } from './conversation-request.js';
import { openTurn, buildInjectDeps, recordHistory } from './turn/turn.js';
import {
  acquireSessionUseLease, acquireTurnBrowser, collectTurnFiles, releaseTurnBrowser, type SessionUseLease,
} from './turn/turn-prep.js';
import { downloadFiles as downloadPlatformFiles } from './routing/file-handler.js';
import { WORKSPACE_DIR } from '@core/utils.js';
import { acquireTurnMutationLock, type TurnMutationRelease } from './turn-mutation-lock.js';

const log = createLogger('agent-runner');
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
      if (!runRegistry.hasChannel(ctx.channel)) return false;
      const sessionId = await getSessionAsync(ctx.channel);
      if (!sessionId) return false;
      const sessionName = await sessionStore.lookupBySessionId(sessionId);
      return tryInjectIntoLiveTurn(buildInjectDeps(sessionName, ctx.channel, ctx.adapter), {
        channel: ctx.channel,
        sessionId,
        sessionName,
        profileName: getActiveProfile(ctx.channel),
        text: ctx.userMessage || '',
        senderId: ctx.message.senderId,
        ...(ctx.message.systemOrigin ? { systemOrigin: ctx.message.systemOrigin } : {}),
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

  /**
   * Resolve what a turn needs but is not part of it — the files, the session record (found or
   * created) with its use lease, the browser the session opted into — and open the turn.
   *
   * `sessionId` here is the STABLE tracking id: sessions.json binds channel → track id (not the
   * backend id), and everything downstream (publish / history / status / Destination) keys on it.
   * The backend resume target is resolved separately. A channel with no bound session yet (fresh
   * Slack/Feishu/etc.) mints + registers + binds a track id up front, unifying it with the web path
   * (createDirectSession pre-registers) so publish/history always have a stable key.
   */
  private async _executeReal(
    ctx: AgentRunnerCtx,
    mutationRelease: TurnMutationRelease,
    loadPlatformFiles: PlatformFileLoader,
  ): Promise<void> {
    const { message, channel, adapter, threadAnchorId, userMessage, agentMessage } = ctx;
    const allFiles = await collectTurnFiles(message, loadPlatformFiles);
    const startTime = Date.now();
    const backend = resolveBackendForChannel(channel);
    let sessionId = await getSessionAsync(channel);
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
      await setSessionAsync(channel, sessionId); // bind channel → track id
      sessionLease = await acquireSessionUseLease(sessionId);
      if (!sessionLease) throw new Error(`Session not found or pending deletion: ${sessionId}`);
      backendSessionId = null; // fresh: the backend self-assigns its id on this first turn
    }
    const browser = await acquireTurnBrowser({ channel, backend, browser: sessionBrowser });
    const debugEnabled = isDebugMode();
    const trackSessionId = sessionId;
    try {
      await openTurn({
        channel, adapter, threadAnchorId,
        session: { sessionId, sessionName, backendSessionId, projectId, lease: sessionLease },
        user: {
          text: userMessage || '',
          attachments: message.webAttachments,
          ...(message.systemOrigin ? { systemOrigin: message.systemOrigin } : {}),
        },
        ledger: { userMessageTs: message.ref.messageId },
        trigger: 'user',
        startTime,
        mutationRelease,
        // The default agent's spec plus the first-turn ambient blocks — the assembly half of what
        // `runConversation` used to do inline (conversation-request.ts).
        prepareRequest: (ids) => prepareConversationRequest({
          ids: {
            sessionId: ids.sessionId ?? '',
            backendSessionId: ids.backendSessionId,
            sessionName: ids.sessionName ?? '',
            projectId: ids.projectId,
          },
          channel,
          userMessage: agentMessage,
          files: allFiles,
          trigger: 'user',
          browserCdpEndpoint: browser.cdpEndpoint,
          commissionTools: !!sessionCommissionDraft,
          commissionMode: !!(sessionCommissionDraft || sessionCommissionId),
          onPromptBuilt: debugEnabled ? (prompt: string) => {
            recordHistory(
              conversationHistory.appendUserPrompt(trackSessionId, { agentMessage: prompt }),
              () => publishSessionDebugUpdated({ sessionId: trackSessionId, channel }),
            );
          } : null,
        }),
      });
    } finally {
      releaseTurnBrowser(browser.held);
    }
  }
}

export const agentRunner = new AgentRunner();

// --- Helpers ---

// Moved to transcript-sink.ts (the one transcript observer). Re-exported here so the existing
// agent-runner tests and importers keep their import path.
export { persistSessionContextUsage, type SessionContextUsagePersistenceDeps };

// Moved under turn/ (they belong to the turn, not to admission). Re-exported so the existing
// importers keep their import path: entry/app.ts + thread-executor for `buildInteractiveCallbacks`,
// the agent-runner / subagent / cancel / session-lifecycle tests for the rest.
export {
  acceptUserMessage, type AcceptUserMessageDeps, beginForegroundSession,
  emitTurnProgress, type TurnProgressDeps, buildInteractiveCallbacks,
} from './turn/turn.js';
export { resolveDefaultAgent, resolveSessionName } from './turn/turn-prep.js';

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
