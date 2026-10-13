import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef } from '@platform/index.js';
import { trackPendingTask } from './busy-tracker.js';
import { enqueue } from './conduit-queue.js';
import { getSessionAsync } from '@domain/sessions/session.js';
import { acquireSessionUse } from '@domain/sessions/session-use.js';
import { sessionStore, effectiveBackendSessionId, type Session } from '@store/session-registry-repo.js';
import { getActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';
import {
  buildUserProcessingMessage, writeStatus, buildStatusActionBlocks, initStatusBlocks,
} from './status-helpers.js';
import {
  initTurnTracking, finishTurnTracking, consumePendingTurnSupersession, type TurnTrackingToken,
} from './turn/turn-tracking.js';
import { handleAgentError } from './turn/terminal.js';
import { openTurn, type TurnSessionLease } from './turn/turn.js';
import { withTurnBrowser } from './turn/turn-prep.js';
import { prepareConversationRequest } from './conversation-request.js';

export function reprocessMessage(channel: string, text: string, adapter: PlatformAdapter, opts: { originalTs: string; sessionId: string | null; supersededStatusTimestamps?: string[] }): void {
  trackPendingTask(+1);
  enqueue(channel, async () => {
    try {
      await executeRetry(channel, text, adapter, opts);
    } finally {
      trackPendingTask(-1);
    }
  });
}

async function executeRetry(channel: string, text: string, adapter: PlatformAdapter, opts: { originalTs: string; sessionId: string | null; supersededStatusTimestamps?: string[] }): Promise<void> {
  const startTime = Date.now();
  // sessionId here is the stable track id; resolve the backend resume target from its record.
  const sessionId = opts.sessionId ?? await getSessionAsync(channel);
  const session = sessionId ? await sessionStore.getById(sessionId) : null;
  const backendSessionId = session ? effectiveBackendSessionId(session) : null;
  const userMessageTs = opts.originalTs;
  const retryDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: sessionId ?? '' };

  const retryPrefix = `${Icons.refresh} ${t('status.retry')} (${t('status.retryEdited')}) | `;
  const retryStatusText = retryPrefix + buildUserProcessingMessage({ startTime, profileName: getActiveProfile(channel), sessionId });
  const retryBlocksTemplate = { channel, sessionId, isDm: true };
  const statusMsg = await adapter.postMessage(retryDest, {
    text: retryStatusText,
    richBlocks: buildStatusActionBlocks(retryStatusText, retryBlocksTemplate),
  });
  initStatusBlocks(statusMsg, retryBlocksTemplate);

  updateRetryPermalinks(adapter, channel, userMessageTs, statusMsg, opts.supersededStatusTimestamps, retryPrefix, startTime, sessionId);
  const turnTrackingToken = await initTurnTracking(
    channel, sessionId, backendSessionId,
    userMessageTs, text, statusMsg.messageId,
  );
  if (consumePendingTurnSupersession(channel, turnTrackingToken)) {
    finishTurnTracking(channel, turnTrackingToken);
    return;
  }
  await runRetryAgent({
    channel, text, adapter, statusMsg, startTime, sessionId, session,
    userMessageTs, retryPrefix, turnTrackingToken,
  });
}

/**
 * Re-run an edited message as a full turn.
 *
 * Everything between the status message and the seal is the Turn's (status progress with the retry
 * prefix, the transcript sink, the streaming callback, the terminal render, the busy bracket): this
 * function only resolves the session lease and describes what makes the turn a RETRY. The ledger
 * turn was already opened by `executeRetry` — it has to be, because the supersession check has to
 * run before the status message exists — so its token is handed to the Turn rather than re-opened.
 *
 * The Turn derives the reply destination from channel + session id, and the ledger response-ts
 * recorder from `userMessageTs`.
 */
export async function runRetryAgent(args: RetryTurnArgs): Promise<void> {
  const { channel, text, adapter, statusMsg, startTime, sessionId, session } = args;
  const leased = await leaseRetrySession(args);
  if (!leased) return;
  const backendSessionId = session ? effectiveBackendSessionId(session) : null;
  const projectId = session?.projectId ?? 'general';
  const backend = resolveBackendForChannel(channel);
  await withTurnBrowser({ backend, browser: session?.browser ?? null }, (cdpEndpoint) => openTurn({
    channel, adapter, threadAnchorId: null,
    session: { sessionId, backendSessionId, projectId, lease: leased.lease },
    // RAW text: what the ledger recorded and what an auto-resume would replay.
    user: { text },
    ledger: { userMessageTs: args.userMessageTs, token: args.turnTrackingToken },
    trigger: 'edit-retry',
    statusPrefix: args.retryPrefix,
    statusMessage: statusMsg,
    startTime,
    // The retry replays a message a human wrote, on the session's live engine: a user turn.
    prepareRequest: (ids) => prepareConversationRequest({
      ids, channel, session, userMessage: text || '',
      browserCdpEndpoint: cdpEndpoint, trigger: 'edit-retry',
    }),
  }));
}

interface RetryTurnArgs {
  channel: string;
  text: string;
  adapter: PlatformAdapter;
  statusMsg: MessageRef;
  startTime: number;
  sessionId: string | null;
  /** The session's registry record, read once by the caller; null when the channel has none. */
  session: Session | null;

  userMessageTs: string;
  retryPrefix: string;
  turnTrackingToken: TurnTrackingToken;
}

/** The retry's session lease (none for a channel without a session), or null when it could not be
 *  taken — in which case the failure is already rendered and the ledger turn closed. */
async function leaseRetrySession(args: RetryTurnArgs): Promise<{ lease: TurnSessionLease | null } | null> {
  const { channel, sessionId } = args;
  try {
    if (!sessionId) return { lease: null };
    const release = await acquireSessionUse(sessionId);
    if (!release) throw new Error(`Session not found or pending deletion: ${sessionId}`);
    return { lease: { release } };
  } catch (error) {
    // The lease is taken before the turn opens, so the Turn cannot render its failure — this is the
    // one terminal render left here, and it is the same one the pre-Turn inline path performed.
    await handleAgentError({
      error: error as { message: string; cancelled?: boolean },
      channel, adapter: args.adapter, statusMsg: args.statusMsg, startTime: args.startTime,
      executionId: null, sessionId, userMessageTs: args.userMessageTs,
    });
    finishTurnTracking(channel, args.turnTrackingToken);
    return null;
  }
}

function updateRetryPermalinks(adapter: PlatformAdapter, channel: string, userMessageTs: string, statusMsg: MessageRef, supersededTimestamps: string[] | undefined, retryPrefix: string, startTime: number, sessionId: string | null): void {
  const userPermalinkP = adapter.getPermalink({ conduit: channel, messageId: userMessageTs }).catch(() => null);
  const statusPermalinkP = supersededTimestamps?.length
    ? adapter.getPermalink(statusMsg).catch(() => null)
    : Promise.resolve(null);

  Promise.all([userPermalinkP, statusPermalinkP]).then(([userPermalink, statusPermalink]) => {
    if (userPermalink) {
      writeStatus(adapter, statusMsg, `${Icons.refresh} ${t('status.retry')} (<${userPermalink}|${t('status.retryEdited')}>) | ` + buildUserProcessingMessage({ startTime, profileName: getActiveProfile(channel), sessionId }));
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
