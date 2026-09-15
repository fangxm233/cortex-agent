import { createLogger } from '@core/log.js';
import type { PlatformAdapter } from '@platform/index.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { acquireSessionUse } from '@domain/sessions/session-use.js';
import type { RunRequest } from '@domain/runs/request.js';
import { continuationRunRequest } from '@domain/runs/builders.js';
import { getDefaultProfileName } from '@domain/agents/profile-manager.js';
import { resolveRunConfig } from '@domain/runs/config-resolver.js';
import { openTurn } from '../turn/turn.js';
import * as askUserQuestion from './ask-user-question.js';

const log = createLogger('ask-user-resume');

/** Ask-user groups are thread-less in practice, but the pre-refactor path fell back to
 *  `shouldAwaitBgInline` (settings-gated, thread-keyed); mirror that decision here. */
export async function resumeAskUserQuestionGroup({ adapter, group, responseText }: { adapter: PlatformAdapter; group: { channel: string; sessionId: string; groupId: string; threadId?: string | null }; responseText: string }): Promise<void> {
  let sessionRelease: (() => void) | null = null;
  try {
    sessionRelease = await acquireSessionUse(group.sessionId);
    if (!sessionRelease) {
      log.warn(`AskUserQuestion resume skipped for missing or deleting session: ${group.sessionId}`);
      return;
    }
    // group.sessionId is the stable track id; resolve the backend resume target + name + project
    // from its registry record. Cost/execution attribution uses the session's bound project, NOT a
    // re-derivation from the response text.
    const askRec = await sessionStore.getById(group.sessionId);
    const askBackendSessionId = askRec ? effectiveBackendSessionId(askRec) : null;
    const askSessionName = askRec?.name ?? null;
    const askProjectId = askRec?.projectId ?? 'general';
    // The answer is delivered as a full turn: status message, transcript rows, streaming callback,
    // terminal seal and busy bracket all come from the Turn. `ledger: null` is the one thing this
    // surface does NOT do — an ask-user answer opens no conversation-ledger turn (it continues the
    // turn that asked), so nothing here completes or supersedes a ledger row.
    await openTurn({
      channel: group.channel, adapter, threadAnchorId: null,
      session: {
        sessionId: group.sessionId,
        sessionName: askSessionName,
        backendSessionId: askBackendSessionId,
        projectId: askProjectId,
        lease: { release: sessionRelease },
      },
      user: { text: responseText },
      ledger: null,
      trigger: 'ask-user-question',
      prepareRequest: async (ids) => {
        const base = continuationRunRequest({
          session: {
            sessionId: ids.sessionId,
            backendSessionId: ids.backendSessionId,
            // The pool key is the channel — what the interrupted turn's engine was opened under, so
            // the resume lands on the same pooled session.
            engineKey: group.channel,
            sessionName: ids.sessionName,
          },
          // The retired `resolveRunProfile(null, channel)` resolved `resolveProfileConfig(null)`,
          // i.e. the DEFAULT profile — never the channel's. Spelled out as an explicit override so
          // that module's deletion changed no behaviour (see T1.3's report: the plan's §3 change 2
          // would make this the channel's profile instead, which is a decision for the reviewer).
          profile: resolveRunConfig({ channel: group.channel, override: getDefaultProfileName() }).profile,
          prompt: responseText,
          channel: group.channel,
          project: ids.projectId,
          trigger: 'ask-user-question',
        });
        const request: RunRequest = {
          ...base,
          context: {
            ...base.context,
            // The pre-refactor resume passed an explicit null threadId and never waited for
            // background work inline. Both are load-bearing: a threadId lands in CORTEX_THREAD_ID
            // and switches the run's inline background wait on, which would make the resume turn
            // block on background tasks. Spelled out here (rather than left off) to keep the field
            // set byte-identical to the literal this replaced.
            threadId: null,
          },
        };
        return { request, backendPrompt: request.prompt.text };
      },
    });
  } catch (error) {
    // Everything from the status message onwards is rendered by the Turn; what reaches here is a
    // failure BEFORE it opened (the session lookup, the status post), which the pre-Turn path also
    // only logged.
    log.error(`AskUserQuestion resume failed before status creation: ${(error as Error).message}`);
  } finally {
    // Idempotent: the Turn already dropped this lease at execution registration.
    sessionRelease?.();
    askUserQuestion.deleteGroup(group.groupId);
  }
}
