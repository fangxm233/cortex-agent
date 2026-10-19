import { createLogger } from '@core/log.js';
import type { PlatformAdapter } from '@platform/index.js';
import { sessionStore, effectiveBackendSessionId } from '@store/session-registry-repo.js';
import { acquireSessionUse } from '@domain/sessions/session-use.js';
import { openTurn } from '../turn/turn.js';
import { prepareConversationRequest } from '../conversation-request.js';
import * as askUserQuestion from './ask-user-question.js';

const log = createLogger('ask-user-resume');

/** Resume the session an answered ask-user group belongs to, with the answers as its next turn. */
export async function resumeAskUserQuestionGroup({ adapter, group, responseText }: { adapter: PlatformAdapter; group: { channel: string; sessionId: string; groupId: string }; responseText: string }): Promise<void> {
  let sessionRelease: (() => void) | null = null;
  try {
    sessionRelease = await acquireSessionUse(group.sessionId);
    if (!sessionRelease) {
      log.warn(`AskUserQuestion resume skipped for missing or deleting session: ${group.sessionId}`);
      return;
    }
    await openAnswerTurn(adapter, group, responseText, { release: sessionRelease });
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

/**
 * The answer is delivered as a full user turn on the session's live engine: status message,
 * transcript rows, streaming callback, terminal seal and busy bracket all come from the Turn.
 * `ledger: null` is the one thing this surface does NOT do — an ask-user answer opens no
 * conversation-ledger turn (it continues the turn that asked), so nothing here completes or
 * supersedes a ledger row.
 */
async function openAnswerTurn(
  adapter: PlatformAdapter,
  group: { channel: string; sessionId: string },
  responseText: string,
  lease: { release: () => void },
): Promise<void> {
  const { channel } = group;
  // Cost/execution attribution uses the session's bound project, NOT a re-derivation from the text.
  const session = await sessionStore.getById(group.sessionId);
  await openTurn({
    channel, adapter, threadAnchorId: null,
    session: {
      sessionId: group.sessionId,
      backendSessionId: session ? effectiveBackendSessionId(session) : null,
      projectId: session?.projectId ?? 'general',
      lease,
    },
    user: { text: responseText },
    ledger: null,
    trigger: 'ask-user-question',
    prepareRequest: (ids) => prepareConversationRequest({
      ids, channel, session, userMessage: responseText, trigger: 'ask-user-question',
    }),
  });
}
