// input:  PlatformAdapter + sessionStore + status-helpers
// output: finalizeThreadSuccess + buildProgressUpdater
// pos:    shared helper functions used by both the scheduled-task and task-dispatch jobs

import type { PlatformAdapter, MessageRef } from '@platform/index.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { buildSessionTag, buildUserProcessingMessage, computeElapsed, formatMetricsSuffix } from '@core/status-format.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../../core/icons.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getOutboundQueue, durableUpdate } from '@store/outbound-queue.js';
import { getActiveBackend, getActiveProfile } from '../../agents/index.js';

const log = createLogger('scheduler');

export function buildProgressUpdater(adapter: PlatformAdapter, statusMsg: MessageRef, startTime: number, effectiveProfile: string, sessionName: string): (progress: Record<string, any> | null) => void {
  return (progress) => {
    adapter.updateMessage(statusMsg, {
      text: buildUserProcessingMessage({
        startTime,
        elapsed_s: progress?.duration_ms != null ? progress.duration_ms / 1000 : null,
        num_turns: progress?.num_turns ?? null,
        profileName: effectiveProfile, sessionName,
      }),
    }).catch((e: Error) => {
      log.error('Failed to update processing status:', e.message);
    });
  };
}

export async function finalizeThreadSuccess(adapter: PlatformAdapter, channel: string, statusMsg: MessageRef | null, { startTime, sessionName, result, threadResult, project, trigger, label, sessionKind, sessionOrigin, statusPrefix, scheduleId }: {
  startTime: number; sessionName: string; result: AgentResult | null; threadResult: Record<string, any>;
  project: string; trigger: string; label: string | null; sessionKind: 'scheduled' | 'local';
  /** How the finalized session was initiated: scheduled jobs pass 'scheduled', task-dispatch
   *  threads pass 'thread'. Passed explicitly because sessionKind='local' cannot distinguish
   *  a dispatch thread (origin 'thread') from a direct session. */
  sessionOrigin: 'scheduled' | 'thread'; statusPrefix: string;
  /** ScheduleTask.id whose fire produced this run (scheduled-task job). Persisted on the session
   *  record so the UI can group runs by schedule and render the trigger card. */
  scheduleId?: string | null;
}): Promise<void> {
  const { elapsedStr, elapsedS } = computeElapsed(startTime);
  if (result?.sessionId) {
    // Register under the last REAL agent step's TRACK id: the conversation transcript and the
    // session.message stream are keyed by it (threads/runner.ts step recorder), so registering
    // the backend id instead yields a session with no transcript. Hook-injected steps (onEnd
    // hooks in targetAgent mode, e.g. post-task-hook's compound/commit step) record
    // sessionName=null and run under the backend resume id — they write no transcript, so they
    // must not supply the registration key (a ghost id renders an empty chat in the UI). Real
    // agent steps always carry a sessionName minted at step start; `hook:` slots are excluded
    // defensively for the legacy insertAgent mode. The step registration for the same track id
    // (origin 'thread') is intentionally overwritten — one record per run. The backend id is
    // kept as backendSessionId, the resume target if the user replies to the run.
    const steps: any[] = threadResult.thread?.steps ?? [];
    const realStep = [...steps]
      .reverse()
      .find((s) => s?.sessionName && !String(s?.agentSlotId ?? '').startsWith('hook:'));
    const trackSessionId = realStep?.sessionId ?? steps[steps.length - 1]?.sessionId ?? null;
    await sessionStore.registerSession(sessionName, {
      sessionId: trackSessionId || result.sessionId, channel,
      backend: getActiveBackend(), kind: sessionKind,
      origin: sessionOrigin,
      label,
      profileName: getActiveProfile(channel),
      projectId: project,
      backendSessionId: result.sessionId,
      scheduleId: scheduleId ?? null,
    });
  }
  const metrics = formatMetricsSuffix({ costUsd: threadResult.totalCostUsd, numTurns: threadResult.totalNumTurns });
  if (statusMsg) {
    const text = `${Icons.ok} ${statusPrefix} | ${buildSessionTag(sessionName, result?.sessionId)}(${elapsedStr}${metrics})`;
    const queue = getOutboundQueue();
    if (queue) {
      await durableUpdate(queue, adapter, statusMsg, { text });
    } else {
      await adapter.updateMessage(statusMsg, { text });
    }
  }
}
