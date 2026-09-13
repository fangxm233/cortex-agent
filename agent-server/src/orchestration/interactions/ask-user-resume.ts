// input:  an ask-user answer plus its pending question group
// output: the follow-up run that delivers the answer back to the agent
// pos:    orchestration/interactions — the resume half of ask-user-question.ts
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef } from '@platform/index.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { startRun } from '@domain/runs/service.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { RunObserver, RunRequest } from '@domain/runs/request.js';
import { bareSpec } from '@domain/runs/spec-loader.js';
import type { RunEvent } from '@domain/runs/events.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { buildDurableHooks } from '../durable-helpers.js';
import { makeStreamingMessageCallback } from '../status-helpers.js';
import { handleAgentSuccess, handleAgentError } from '../lifecycle.js';
import { resolveRunProfile } from '../run-profile.js';
import * as askUserQuestion from './ask-user-question.js';

const log = createLogger('ask-user-resume');

/** Ask-user groups are thread-less in practice, but the legacy facade fell back to
 *  `shouldAwaitBgInline` (settings-gated, thread-keyed); mirror that decision here. */
export async function resumeAskUserQuestionGroup({ adapter, group, responseText }: { adapter: PlatformAdapter; group: { channel: string; sessionId: string; groupId: string; threadId?: string | null }; responseText: string }): Promise<void> {
  let sessionRelease: (() => void) | null = null;
  let statusMsg: MessageRef | null = null;
  const startTime = Date.now();
  let executionId: string | null = null;
  let run: AgentRun | null = null;
  try {
    sessionRelease = await sessionStore.acquireSessionUse(group.sessionId);
    if (!sessionRelease) {
      log.warn(`AskUserQuestion resume skipped for missing or deleting session: ${group.sessionId}`);
      return;
    }
    const askDest: Destination = { type: 'interactive-reply', conduit: group.channel, sessionId: group.sessionId };
    statusMsg = await adapter.postMessage(askDest, { text: `${Icons.processing} ${t('status.processingAskResponse')}` });
    // group.sessionId is the stable track id; resolve the backend resume target + name + project
    // from its registry record. Cost/execution attribution uses the session's bound project, NOT a
    // re-derivation from the response text.
    const askRec = await sessionStore.getById(group.sessionId);
    const askBackendSessionId = askRec ? effectiveBackendSessionId(askRec) : null;
    const askSessionName = askRec?.name ?? null;
    const askProjectId = askRec?.projectId ?? 'general';
    const askQueue = getOutboundQueue();
    const askDurable = askQueue ? buildDurableHooks(askQueue) : null;
    const onAssistantMsg = makeStreamingMessageCallback(adapter, askDest, null, null, askDurable);
    const request: RunRequest = {
      runId: randomUUID(),
      session: {
        sessionId: group.sessionId,
        backendSessionId: askBackendSessionId,
        // The legacy run set no session key, so the spec builder fell back to the channel.
        engineKey: group.channel,
        sessionName: askSessionName,
      },
      profile: resolveRunProfile(null, group.channel),
      spec: bareSpec(),
      prompt: { text: responseText, attachments: [] },
      context: {
        channel: group.channel,
        project: askProjectId,
        trigger: 'ask-user-question',
        // The pre-refactor resume passed no threadId and never waited for background work inline.
        // Both are load-bearing: a threadId lands in CORTEX_THREAD_ID and switches the facade's
        // inline background wait on, which would make the resume turn block on background tasks.
        threadId: null,
        executionKind: 'local',
        isUserInitiated: false,
        commissionMode: false,
        commissionTools: false,
        scheduleTaskId: null,
      },
      policy: {
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
        if (event.type === 'assistant_text') onAssistantMsg(event.text);
      },
    };
    run = startRun(request, [observer]);
    executionId = run.executionId;
    sessionRelease();
    sessionRelease = null;
    const result = await run.result;
    await handleAgentSuccess({ result, channel: group.channel, adapter, statusMsg, startTime, userMessage: responseText, executionId, trigger: 'ask-user-question', sessionName: askSessionName, trackSessionId: group.sessionId, projectId: askProjectId, onAssistantMessage: onAssistantMsg });
  } catch (error) {
    if (statusMsg) {
      await handleAgentError({ error: error as { message: string; cancelled?: boolean }, channel: group.channel, adapter, statusMsg, startTime, executionId, effectiveSessionId: run?.backendSessionId ?? null });
    } else {
      log.error(`AskUserQuestion resume failed before status creation: ${(error as Error).message}`);
    }
  } finally {
    sessionRelease?.();
    askUserQuestion.deleteGroup(group.groupId);
  }
}
