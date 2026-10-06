import { useQueries } from '@tanstack/react-query';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useVocabOptional } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { pendingQuestionText } from './worker-roster';

/** What each worker that needs you is asking, by sessionId. Queried only for those workers, and
 *  only by the open team list; the live sync refreshes it when an interaction changes. */
export function useWorkerQuestions(workers: SessionInfo[]): Record<string, string> {
  const trpc = useTRPC();
  const L = useVocabOptional();
  const asking = workers.filter((w) => w.awaitingInput);
  const results = useQueries({
    queries: asking.map((w) => trpc.sessions.pendingInteraction.queryOptions({ sessionId: w.sessionId })),
  });
  const questions: Record<string, string> = {};
  asking.forEach((w, i) => {
    const text = pendingQuestionText(results[i]?.data, L);
    if (text) questions[w.sessionId] = text;
  });
  return questions;
}
