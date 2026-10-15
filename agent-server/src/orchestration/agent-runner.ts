import type { PlatformAdapter, MessageRef, IncomingMessage } from '@platform/index.js';
import { SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import { conduitQueues, enqueue } from './conduit-queue.js';
import { trackPendingTask } from './busy-tracker.js';
import * as crypto from 'node:crypto';
import { getSessionAsync, setSessionAsync } from '@domain/sessions/session.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { resolveBackendForChannel } from '@domain/agents/index.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';
import { registerSessionRecord } from '@domain/sessions/session-lifecycle.js';
import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import { publishSessionDebugUpdated } from './session-events.js';
import { isInjectableMessage, tryInjectIntoLiveTurn } from './mid-turn-inject.js';
import { runRegistry } from '@core/run-registry.js';
import { prepareConversationRequest } from './conversation-request.js';
import { openTurn, buildInjectDeps } from './turn/turn.js';
import { recordHistory } from './transcript-sink.js';
import {
  acquireSessionUseLease, collectTurnFiles, withTurnBrowser, type SessionUseLease,
} from './turn/turn-prep.js';
import { downloadMessageFiles, type InboundFiles } from './routing/file-handler.js';
import { acquireTurnMutationLock, type TurnMutationRelease } from './turn-mutation-lock.js';
import { isRebuildHeld, refuseTurnForRebuild } from '@domain/system/rebuild-hold.js';

const log = createLogger('agent-runner');

type Enqueuer = (channel: string, fn: () => Promise<void>) => boolean;
type Tracker = (delta: number) => void;
type PlatformFileLoader = () => Promise<InboundFiles>;
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
  /** Called instead of the refusal notice when a rebuild hold refuses this message: the sender has
   *  kept it to deliver after the restart, so nothing was lost. A throw falls back to the notice. */
  onRebuildHold?: () => Promise<void> | void;
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
    // The supervisor is rebuilding or replacing this process (entry/daemon-notice.ts pushes the
    // hold). A turn admitted now spawns a backend CLI whose stdout owner is about to be SIGTERMed:
    // the CLI finishes, writes into a pipe nobody reads, and the turn hangs at "processing" forever
    // (2026-09-21). Refused first, before anything is tracked, marked, leased or injected — a
    // message folded into a turn that is about to die is lost just as thoroughly.
    if (isRebuildHeld()) {
      log.info(`Refusing turn on ${channel}: supervisor rebuild in progress`);
      if (ctx.onRebuildHold) {
        try {
          await ctx.onRebuildHold();
          return false;
        } catch (e) {
          log.warn(`Keeping the refused message on ${channel} failed: ${(e as Error).message}`);
        }
      }
      await refuseTurnForRebuild({
        adapter,
        channel,
        text: ctx.userMessage || '',
        interactive: message.senderId !== SYNTHETIC_CALLBACK_SENDER && !message.systemOrigin,
      });
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
      if (!runRegistry.hasChannel(ctx.channel)) return false;
      const sessionId = await getSessionAsync(ctx.channel);
      if (!sessionId) return false;

      return tryInjectIntoLiveTurn(buildInjectDeps(sessionId, ctx.adapter), {
        channel: ctx.channel,
        sessionId,
        selection: resolveRunSelection({ channel: ctx.channel, session: await sessionStore.getById(sessionId) }),
        text: ctx.userMessage || '',
        senderId: ctx.message.senderId,
        ...(ctx.message.systemOrigin ? { systemOrigin: ctx.message.systemOrigin } : {}),
        messageId: ctx.message.ref.messageId,
        attachments: ctx.message.webAttachments,
        prepareBackendAttachments: async () => (await loadPlatformFiles()).files.map((file) => ({
          mimeType: file.mimetype,
          path: file.localPath,
          name: file.name,
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
   */
  private async _executeReal(
    ctx: AgentRunnerCtx,
    mutationRelease: TurnMutationRelease,
    loadPlatformFiles: PlatformFileLoader,
  ): Promise<void> {
    const { message, channel, adapter, threadAnchorId, userMessage, agentMessage } = ctx;
    const turnFiles = await collectTurnFiles(message, loadPlatformFiles);
    const startTime = Date.now();
    const backend = resolveBackendForChannel(channel);
    const { lease, backendSessionId } = await bindTurnSession(ctx, backend);
    const session = lease.session;
    await withTurnBrowser({ backend: session.selection?.backend ?? backend, browser: session.browser ?? null }, (cdpEndpoint) => openTurn({
      channel, adapter, threadAnchorId,
      session: {
        sessionId: session.sessionId, backendSessionId,
        projectId: session.projectId ?? 'general', lease,
      },
      user: {
        text: userMessage || '',
        attachments: mergeAttachments(message.webAttachments, turnFiles.platformAttachments),
        ...(message.systemOrigin ? { systemOrigin: message.systemOrigin } : {}),
      },
      ledger: { userMessageTs: message.ref.messageId },
      trigger: 'user',
      origin: turnOrigin(message),
      startTime,
      mutationRelease,
      prepareRequest: (turnIds) => prepareConversationRequest({
        ids: turnIds, channel, session, userMessage: agentMessage,
        files: turnFiles.files, failedFiles: turnFiles.failures,
        browserCdpEndpoint: cdpEndpoint, onPromptBuilt: debugPromptRecorder(session.sessionId, channel),
      }),
    }));
  }
}

/** In debug mode, the backend-ready prompt of each turn is kept in the session's history. */
function debugPromptRecorder(sessionId: string, channel: string): ((prompt: string) => void) | null {
  if (!isDebugMode()) return null;
  return (prompt) => recordHistory(
    conversationHistory.appendUserPrompt(sessionId, { agentMessage: prompt }),
    () => publishSessionDebugUpdated({ sessionId, channel }),
  );
}

/**
 * The session this turn runs on, with its use lease.
 *
 * The id is the STABLE tracking id: the registry binds channel → track id (not the backend id), and
 * everything downstream (publish / history / status / Destination) keys on it. The backend resume
 * target is resolved separately. A channel with no bound session yet (fresh Slack/Feishu/etc.)
 * mints + registers + binds a track id up front, unifying it with the web path
 * (createDirectSession pre-registers) so publish/history always have a stable key.
 */
async function bindTurnSession(
  ctx: AgentRunnerCtx,
  backend: string,
): Promise<{ lease: SessionUseLease; backendSessionId: string | null }> {
  const bound = await getSessionAsync(ctx.channel);
  if (bound) {
    const lease = await leaseSession(bound);
    return { lease, backendSessionId: effectiveBackendSessionId(lease.session) };
  }
  const sessionId = crypto.randomUUID();
  await registerSessionRecord(sessionStore, {
    sessionId, channel: ctx.channel, backend,
    label: ctx.userMessage?.substring(0, 60) ?? null,
    selection: resolveRunSelection({ channel: ctx.channel }),
    projectId: (await ctx.adapter.resolveInboundProject(ctx.channel)) ?? 'general',
  });
  await setSessionAsync(ctx.channel, sessionId);
  // Fresh: the backend self-assigns its id on this first turn.
  return { lease: await leaseSession(sessionId), backendSessionId: null };
}

async function leaseSession(sessionId: string): Promise<SessionUseLease> {
  const lease = await acquireSessionUseLease(sessionId);
  if (!lease) throw new Error(`Session not found or pending deletion: ${sessionId}`);
  return lease;
}

export const agentRunner = new AgentRunner();

// --- Helpers ---

/** Web uploads and platform downloads share one attachment list on the user's transcript row. */
function mergeAttachments(
  web: IncomingMessage['webAttachments'],
  platform: IncomingMessage['webAttachments'],
): IncomingMessage['webAttachments'] {
  const merged = [...(web ?? []), ...(platform ?? [])];
  return merged.length > 0 ? merged : undefined;
}

/** The delivery origin `session-gateway` stamped on the message, or `platform` for an inbound
 *  chat-platform message that never went through it. */
function turnOrigin(message: IncomingMessage): string {
  const origin = (message.raw as { deliveryOrigin?: unknown } | null | undefined)?.deliveryOrigin;
  return typeof origin === 'string' && origin ? origin : 'platform';
}

function createPlatformFileLoader(ctx: AgentRunnerCtx): PlatformFileLoader {
  let pending: Promise<InboundFiles> | null = null;
  return () => {
    pending ??= downloadMessageFiles(ctx.message, ctx.hasFiles, ctx.adapter);
    return pending;
  };
}
