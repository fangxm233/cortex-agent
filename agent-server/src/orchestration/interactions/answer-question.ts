import { resolveRequest as resolveHookRequest } from '../routing/hook-bridge.js';
import * as askUserQuestion from './ask-user-question.js';
import { interactionRecords as defaultInteractionRecords, type InteractionRecords } from './interaction-records.js';
import type { InteractionResolvedVia } from '@store/conversation-history-repo.js';

export type AnswerQuestionOutcome = 'resolved' | 'already-resolved' | 'not-found';

export interface AnswerQuestionDeps {
  interactionRecords: Pick<InteractionRecords, 'get' | 'resolve'>;
  getGroup: (requestId: string) => any | null;
  tryResolveHook: (group: any) => boolean;
  resolveRequest: (requestId: string, data: unknown) => boolean;
}

const defaultDeps: AnswerQuestionDeps = {
  interactionRecords: defaultInteractionRecords,
  getGroup: askUserQuestion.getGroupByHookRequestId,
  tryResolveHook: askUserQuestion.tryResolveHook,
  resolveRequest: resolveHookRequest,
};

/**
 * Resolve a pending ask-user interaction by requestId. The MCP tool blocks on the HTTP response (or
 * a native PI dialog waits on `respondToDialog`); this collects the answers, resolves the entity
 * (which persists the record and broadcasts session.interaction to every client), and unblocks the
 * caller. First answer wins: a record that is no longer pending reports `already-resolved`.
 */
export function answerQuestion(
  requestId: string,
  answers: Record<string, string>,
  resolvedVia: InteractionResolvedVia,
  deps: AnswerQuestionDeps = defaultDeps,
): AnswerQuestionOutcome {
  const rec = deps.interactionRecords.get(requestId);
  if (rec && rec.status !== 'pending') return 'already-resolved';
  const group = deps.getGroup(requestId);
  if (!group) {
    // No group (raw hook request) — unblock the webhook directly if it exists.
    if (!deps.resolveRequest(requestId, { answers })) return 'not-found';
    void deps.interactionRecords.resolve({ id: requestId, status: 'answered', result: { answers }, resolvedVia });
    return 'resolved';
  }
  for (const q of group.questions) {
    const answer = answers[q.question];
    if (answer !== undefined) {
      group.answers.set(q.pendingId, { header: q.header, value: answer });
    }
  }
  if (!deps.tryResolveHook(group)) return 'not-found';
  void deps.interactionRecords.resolve({ id: requestId, status: 'answered', result: { answers }, resolvedVia });
  return 'resolved';
}
