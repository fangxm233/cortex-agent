// input:  a session id
// output: { waitpoints, cancel, cancelling } for WaitRail
// pos:    session-scoped waitpoint resource. Ownership matching happens on the server (SessionInfo
//         carries no channel), so this hook only asks for "what is this session waiting on".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';

/** Slow on purpose: the turn edges do the real work (see shouldPoll). This interval only has to
 *  catch what happens BETWEEN turns — a `progress` signal landing, a delivery retry, the expiry
 *  countdown — and it stops as soon as the session is waiting on nothing. */
const REFRESH_MS = 15_000;

/**
 * Whether to keep polling this session's waitpoints.
 *
 * `waitingOn` is the load-bearing half. Polling only while the fetched list is non-empty looks
 * frugal and is in fact a trap: empty is the state a session sits in until something is armed, so a
 * poll gated on the list alone can never notice the one transition that matters. `waitingOn` rides
 * on sessions.list, which every turn edge already invalidates, so it flips to a positive number on
 * its own and switches this query back on.
 */
export function shouldPoll(fetchedCount: number, waitingOn: number): number | false {
  return fetchedCount > 0 || waitingOn > 0 ? REFRESH_MS : false;
}

export interface SessionWaitpoints {
  waitpoints: WaitpointInfo[];
  cancel: (waitpointId: string) => void;
  cancelling: boolean;
}

export function useSessionWaitpoints(
  sessionId: string | null,
  /** SessionInfo.waitingOn — the live count, which is what tells us to start looking. */
  waitingOn = 0,
): SessionWaitpoints {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const query = useQuery({
    ...trpc.waitpoints.list.queryOptions({ sessionId: sessionId ?? '' }),
    enabled: !!sessionId,
    refetchInterval: (q) => shouldPoll(q.state.data?.length ?? 0, waitingOn),
  });

  const cancelMut = useMutation(
    trpc.waitpoints.cancel.mutationOptions({
      onSuccess: () => { queryClient.invalidateQueries(trpc.waitpoints.list.queryFilter()); },
    }),
  );

  return {
    waitpoints: query.data ?? [],
    cancel: (waitpointId: string) => cancelMut.mutate({ waitpointId }),
    cancelling: cancelMut.isPending,
  };
}
