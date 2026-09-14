import { createLogger } from '@core/log.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef } from '@platform/index.js';
import { trackPendingTask } from './busy-tracker.js';
import { enqueue } from './conduit-queue.js';
import { getSessionAsync } from '@domain/sessions/session.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { getActiveProfile } from '@domain/agents/index.js';
import { resolveRunConfig } from '@domain/runs/config-resolver.js';
import { continuationRunRequest } from '@domain/runs/builders.js';
import { normalizeSkillCommandPrefix } from '@domain/memory/skill-scanner.js';
import {
  buildUserProcessingMessage, writeStatus, buildStatusActionBlocks, initStatusBlocks,
} from './status-helpers.js';
import {
  initTurnTracking, finishTurnTracking, consumePendingTurnSupersession, type TurnTrackingToken,
} from './turn/turn-tracking.js';
import { handleAgentError } from './turn/terminal.js';
import { openTurn, type TurnSessionLease } from './turn/turn.js';

const log = createLogger('edit-retry');

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
  const sessionId = opts.sessionId ?? await getSessionAsync(channel);
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

/**
 * Re-run an edited message as a full turn.
 *
 * Everything between the status message and the seal is the Turn's (status progress with the retry
 * prefix, the transcript sink, the streaming callback, the terminal render, the busy bracket): this
 * function only resolves the session lease and describes what makes the turn a RETRY. The ledger
 * turn was already opened by `executeRetry` — it has to be, because the supersession check has to
 * run before the status message exists — so its token is handed to the Turn rather than re-opened.
 *
 * `retryDest` and `onMessagePosted` are still accepted (the signature is pinned by
 * `tests/orch/lifecycle-session-lease.test.ts` and by `executeRetry`), but the Turn now derives
 * both: the destination from channel + session id, and the ledger response-ts recorder from
 * `userMessageTs`. They are byte-identical to what this function used to build.
 */
export async function runRetryAgent({ channel, text, adapter, statusMsg, startTime, sessionId, backendSessionId, sessionName, projectId, userMessageTs, retryPrefix, onMessagePosted: _onMessagePosted, retryDest: _retryDest, turnTrackingToken }: { channel: string; text: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number; sessionId: string | null; backendSessionId: string | null; sessionName: string | null; projectId: string; userMessageTs: string; retryPrefix: string; onMessagePosted: (ref: MessageRef) => void; retryDest: Destination; turnTrackingToken: TurnTrackingToken }): Promise<void> {
  const agentMessage = normalizeSkillCommandPrefix(text || '');
  let lease: TurnSessionLease | null = null;
  try {
    if (sessionId) {
      const release = await sessionStore.acquireSessionUse(sessionId);
      if (!release) throw new Error(`Session not found or pending deletion: ${sessionId}`);
      lease = { release };
    }
  } catch (error) {
    // The lease is taken before the turn opens, so the Turn cannot render its failure — this is the
    // one terminal render left here, and it is the same one the pre-Turn inline path performed.
    await handleAgentError({
      error: error as { message: string; cancelled?: boolean },
      channel, adapter, statusMsg, startTime, executionId: null,
      sessionName, sessionId, userMessageTs,
    });
    finishTurnTracking(channel, turnTrackingToken);
    return;
  }
  await openTurn({
    channel, adapter, threadAnchorId: null,
    session: { sessionId, sessionName, backendSessionId, projectId, lease },
    // RAW text: what the ledger recorded and what an auto-resume would replay.
    user: { text },
    ledger: { userMessageTs, token: turnTrackingToken },
    trigger: 'edit-retry',
    statusPrefix: retryPrefix,
    statusMessage: statusMsg,
    startTime,
    prepareRequest: async (ids) => {
      const request = continuationRunRequest({
        session: {
          sessionId: ids.sessionId,
          backendSessionId: ids.backendSessionId,
          // The pool key is the channel — what an interactive turn's engine is opened under, and not
          // something to change here (that would re-pool the session the retry is meant to continue).
          engineKey: channel,
          sessionName: ids.sessionName,
        },
        // Same resolution the retired `resolveRunProfile(getActiveProfile(channel), channel)`
        // performed: the channel's own profile, kept as an explicit override so an unknown name
        // still reaches the run (which rejects it after the execution record exists).
        profile: resolveRunConfig({ channel, override: getActiveProfile(channel) }).profile,
        prompt: agentMessage,
        channel,
        project: ids.projectId,
        trigger: 'edit-retry',
        // The retry replays a message a human wrote and edited.
        isUserInitiated: true,
      });
      return { request, backendPrompt: request.prompt.text };
    },
  });
}

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
