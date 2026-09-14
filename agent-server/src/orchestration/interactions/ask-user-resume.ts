import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef } from '@platform/index.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { startRun } from '@domain/runs/service.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { RunObserver, RunRequest } from '@domain/runs/request.js';
import { continuationRunRequest } from '@domain/runs/builders.js';
import type { RunEvent } from '@domain/runs/events.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { buildDurableHooks } from '../durable-helpers.js';
import { makeStreamingMessageCallback } from '../status-helpers.js';
import { handleAgentSuccess, handleAgentError } from '../lifecycle.js';
import { resolveRunProfile } from '../run-profile.js';
import * as askUserQuestion from './ask-user-question.js';

const log = createLogger('ask-user-resume');

/** Ask-user groups are thread-less in practice, but the pre-refactor path fell back to
 *  `shouldAwaitBgInline` (settings-gated, thread-keyed); mirror that decision here. */
export async function resumeAskUserQuestionGroup({ adapter, group, responseText }: { adapter: PlatformAdapter; group: { channel: string; sessionId: string; groupId: string; threadId?: string | null }; responseText: string }): Promise<void> {
  let sessionRelease: (() => void) | null = null;
  let statusMsg: MessageRef | null = null;
  const startTime = Date.now();
  let executionId: string | null = null;
  let run: AgentRun | null = null;
  // Hoisted: the failure path names the same session the success path does.
  let askSessionName: string | null = null;
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
    askSessionName = askRec?.name ?? null;
    const askProjectId = askRec?.projectId ?? 'general';
    const askQueue = getOutboundQueue();
    const askDurable = askQueue ? buildDurableHooks(askQueue) : null;
    const onAssistantMsg = makeStreamingMessageCallback(adapter, askDest, null, null, askDurable);
    const askBase = continuationRunRequest({
      session: {
        sessionId: group.sessionId,
        backendSessionId: askBackendSessionId,
        // The pool key is the channel — what the interrupted turn's engine was opened under, so the
        // resume lands on the same pooled session.
        engineKey: group.channel,
        sessionName: askSessionName,
      },
      profile: resolveRunProfile(null, group.channel),
      prompt: responseText,
      channel: group.channel,
      project: askProjectId,
      trigger: 'ask-user-question',
    });
    const request: RunRequest = {
      ...askBase,
      context: {
        ...askBase.context,
        // The pre-refactor resume passed an explicit null threadId and never waited for background
        // work inline. Both are load-bearing: a threadId lands in CORTEX_THREAD_ID and switches the
        // run's inline background wait on, which would make the resume turn block on background
        // tasks. Spelled out here (rather than left off) to keep the field set byte-identical to
        // the literal this replaced.
        threadId: null,
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
      // Same identity pair the success call above passes: the track id names the session (binding,
      // registry, delivery), the backend id is only this turn's resume target.
      await handleAgentError({
        error: error as { message: string; cancelled?: boolean },
        channel: group.channel, adapter, statusMsg, startTime, executionId,
        sessionName: askSessionName, sessionId: group.sessionId,
        effectiveSessionId: run?.backendSessionId ?? null,
      });
    } else {
      log.error(`AskUserQuestion resume failed before status creation: ${(error as Error).message}`);
    }
  } finally {
    sessionRelease?.();
    askUserQuestion.deleteGroup(group.groupId);
  }
}
