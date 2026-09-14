// input:  an edited user message plus the turn it supersedes
// output: the retry turn — new status message, permalink backfill, and its run
// pos:    orchestration — the edit-retry surface; turn tracking and finalization stay in lifecycle
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomUUID } from 'node:crypto';
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
import { startRun } from '@domain/runs/service.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { RunObserver, RunRequest } from '@domain/runs/request.js';
import { bareSpec } from '@domain/runs/spec-loader.js';
import type { RunEvent } from '@domain/runs/events.js';
import { recordDirectResume } from '@domain/runs/observers/resume-recorder.js';
import { normalizeSkillCommandPrefix } from '@domain/memory/skill-scanner.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { buildDurableHooks } from './durable-helpers.js';
import { setStreamingCallback, clearStreamingCallback } from './routing/hook-bridge.js';
import {
  buildUserProcessingMessage, renderTurnStatus, makeFallbackLabelNotifier, makeStreamingMessageCallback,
  computeElapsed, writeStatus, sealStatus, buildStatusActionBlocks, buildSealedStatusActionBlocks,
  initStatusBlocks,
} from './status-helpers.js';
import {
  handleAgentSuccess, handleAgentError, initTurnTracking, finishTurnTracking,
  consumePendingTurnSupersession, type TurnTrackingToken,
} from './lifecycle.js';
import { resolveRunProfile } from './run-profile.js';

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

export async function runRetryAgent({ channel, text, adapter, statusMsg, startTime, sessionId, backendSessionId, sessionName, projectId, userMessageTs, retryPrefix, onMessagePosted, retryDest, turnTrackingToken }: { channel: string; text: string; adapter: PlatformAdapter; statusMsg: MessageRef; startTime: number; sessionId: string | null; backendSessionId: string | null; sessionName: string | null; projectId: string; userMessageTs: string; retryPrefix: string; onMessagePosted: (ref: MessageRef) => void; retryDest: Destination; turnTrackingToken: TurnTrackingToken }): Promise<void> {
  const agentMessage = normalizeSkillCommandPrefix(text || '');
  let executionId: string | null = null;
  let run: AgentRun | null = null;
  let sessionRelease: (() => void) | null = null;
  try {
    if (sessionId) {
      sessionRelease = await sessionStore.acquireSessionUse(sessionId);
      if (!sessionRelease) throw new Error(`Session not found or pending deletion: ${sessionId}`);
    }
    const retryQueue = getOutboundQueue();
    const retryDurable = retryQueue ? buildDurableHooks(retryQueue) : null;
    const onAssistantMsg = makeStreamingMessageCallback(adapter, retryDest, null, onMessagePosted, retryDurable);
    setStreamingCallback(channel, onAssistantMsg);
    const progressUpdater = buildRetryProgressUpdater(adapter, channel, statusMsg, retryPrefix, startTime, sessionName, sessionId);
    const fallbackNotifier = makeFallbackLabelNotifier(statusMsg, adapter);
    const request: RunRequest = {
      runId: randomUUID(),
      session: {
        sessionId,
        backendSessionId,
        // The pool key is the channel — what an interactive turn's engine is opened under, and not
        // something to change here (that would re-pool the session the retry is meant to continue).
        engineKey: channel,
        sessionName,
      },
      profile: resolveRunProfile(getActiveProfile(channel), channel),
      spec: bareSpec(),
      prompt: { text: agentMessage, attachments: [] },
      context: {
        channel,
        project: projectId,
        trigger: 'edit-retry',
        executionKind: 'local',
        isUserInitiated: true,
        commissionMode: false,
        commissionTools: false,
        scheduleTaskId: null,
      },
      policy: {
        // Legacy `awaitBackground` was undefined with no threadId -> no inline wait.
        background: 'none',
        recordCost: true,
        hooks: true,
        loadRules: true,
        mcpComposition: 'direct',
        browserCdpEndpoint: null,
        // Claude writes a per-turn transcript file unless told not to; only a frozen subagent
        // child opts out. `captureTranscriptLogs` defaults to ON, so this must stay true.
        captureTranscripts: true,
      },
    };
    const observer: RunObserver = {
      onEvent(event: RunEvent): void {
        switch (event.type) {
          case 'assistant_text': onAssistantMsg(event.text); return;
          case 'turn_progress': progressUpdater({ num_turns: event.numTurns, duration_ms: null }); return;
          case 'run_fallback': void fallbackNotifier(event.from, event.to); return;
          default: return;
        }
      },
    };
    run = startRun(request, [observer]);
    executionId = run.executionId;
    sessionRelease?.();
    sessionRelease = null;
    finishTurnTracking(channel, turnTrackingToken);
    const result = await run.result;
    clearStreamingCallback(channel);

    if (result?.rateLimited) {
      // Record the interrupted edit-retry conversation for auto-resume when the window resets.
      recordDirectResume({ provider: result.rateLimitProvider, channel, trackSessionId: sessionId, userMessage: text });
      const { elapsedStr } = computeElapsed(startTime);
      const rateLimitText = renderTurnStatus({ kind: 'rate-limited' }, { sessionName, sessionId, elapsedStr });
      await sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
    } else {
      await handleAgentSuccess({ result, channel, adapter, statusMsg, startTime, userMessage: text, executionId, trigger: 'edit-retry', sessionName, trackSessionId: sessionId, projectId, userMessageTs, onAssistantMessage: onAssistantMsg });
    }
  } catch (error) {
    clearStreamingCallback(channel);
    await handleAgentError({ error, channel, adapter, statusMsg, startTime, executionId, sessionName, sessionId, effectiveSessionId: run?.backendSessionId ?? null, userMessageTs });
  } finally {
    sessionRelease?.();
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
