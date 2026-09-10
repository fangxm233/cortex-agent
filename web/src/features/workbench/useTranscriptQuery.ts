// input:  a session id and the cached transcript for it
// output: the transcript query, refetched as a delta whenever it can be
// pos:    Single entry point for reading sessions.transcript
// >>> Once updated, update this header and parent CORTEX.md <<<
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionTranscript } from '@cortex-agent/ui-contract';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import { mergeTranscriptDelta } from './transcript-delta';

// Every surface that shows a transcript goes through here, so the cursor is kept in exactly one
// place: the cached response itself. Live events keep invalidating the query as before — the
// difference is what the refetch costs. The query KEY is the plain
// `{ sessionId, compactSubagents: true }` one, so every existing
// `invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }))` still matches.

export function useTranscriptQuery(sessionId: string, enabled = true) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const options = trpc.sessions.transcript.queryOptions({ sessionId, compactSubagents: true });

  return useQuery({
    ...options,
    enabled: enabled && !!sessionId,
    queryFn: async (): Promise<SessionTranscript> => {
      const input = { sessionId, compactSubagents: true } as const;
      // Read the cached value ONCE and merge against that same object: a concurrent write cannot
      // then leave us folding a delta onto a transcript it was not computed from.
      const previous = queryClient.getQueryData<SessionTranscript>(options.queryKey);
      if (previous?.cursor) {
        const response = await client.sessions.transcript.query({ ...input, since: previous.cursor });
        const merged = mergeTranscriptDelta(previous, response);
        if (merged) return merged;
      }
      return await client.sessions.transcript.query(input);
    },
  });
}
