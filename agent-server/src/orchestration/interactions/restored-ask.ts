import { conversationHistory, type HistoryEvent, type InteractionResolvedVia } from '@store/conversation-history-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { deliverToSessionDetached } from '../session-gateway.js';
import { askAnswerMessageText } from './ask-answer-message.js';
import { interactionRecords as defaultInteractionRecords, type InteractionRecords } from './interaction-records.js';
import type { AnswerQuestionOutcome } from './answer-question.js';

export interface RestoredAskDeps {
  readEvents: (sessionId: string) => Promise<HistoryEvent[]>;
  channelOf: (sessionId: string) => Promise<string>;
  interactionRecords: Pick<InteractionRecords, 'restore' | 'resolve'>;
  deliver: (channel: string, text: string) => void;
}

const defaultDeps: RestoredAskDeps = {
  readEvents: async (sessionId) => (await conversationHistory.getHistory(sessionId, { includeToolDebug: false }))?.events ?? [],
  channelOf: async (sessionId) => (await sessionStore.getById(sessionId))?.channel ?? `web:${sessionId}`,
  interactionRecords: defaultInteractionRecords,
  deliver: (channel, text) => deliverToSessionDetached({ channel, text, origin: 'ask-user-answer' }),
};

function findAsk(events: HistoryEvent[], requestId: string): HistoryEvent | null {
  return events.find((e) => e.type === 'interaction' && e.id === requestId) ?? null;
}

/**
 * Answer a non-blocking ask the server no longer holds in memory (it restarted after the card
 * was posted). Nobody waits on such an ask, so it stays answerable: the record is rebuilt from
 * the session's history and resolved, and the answer reaches the session as an ordinary user
 * message — the same delivery a live non-blocking ask gets. A blocking ask lost its waiting
 * caller with the restart, so it is not revived.
 */
export async function answerRestoredAsk(
  sessionId: string,
  requestId: string,
  answers: Record<string, string>,
  resolvedVia: InteractionResolvedVia,
  deps: RestoredAskDeps = defaultDeps,
): Promise<AnswerQuestionOutcome> {
  const ask = findAsk(await deps.readEvents(sessionId), requestId);
  if (!ask || ask.kind !== 'ask-user' || ask.payload?.blocking !== false) return 'not-found';
  if (ask.status !== 'pending') return 'already-resolved';
  const channel = await deps.channelOf(sessionId);
  deps.interactionRecords.restore({ id: requestId, sessionId, channel, kind: 'ask-user', payload: ask.payload, createdAt: Date.parse(ask.ts) });
  const outcome = await deps.interactionRecords.resolve({ id: requestId, status: 'answered', result: { answers }, resolvedVia });
  if (outcome === 'unknown') return 'not-found';
  if (outcome === 'already-resolved') return 'already-resolved';
  const text = askAnswerMessageText(answers);
  if (text) deps.deliver(channel, text);
  return 'resolved';
}
