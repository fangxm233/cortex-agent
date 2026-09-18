// input:  a session id
// output: { waitpoints, cancel, cancelling } for WaitRail
// pos:    session-scoped waitpoint resource. Ownership matching happens on the server (SessionInfo
//         carries no channel), so this hook only asks for "what is this session waiting on".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';

/** Slow on purpose. The interesting transition — a waitpoint firing — arrives for free: the wake is
 *  a turn, so `session.status` fires and the session queries are invalidated by the live sync. This
 *  interval only covers arming (no event) and expiry, and it stops the moment nothing is armed. */
const REFRESH_MS = 15_000;

export interface SessionWaitpoints {
  waitpoints: WaitpointInfo[];
  cancel: (waitpointId: string) => void;
  cancelling: boolean;
}

export function useSessionWaitpoints(sessionId: string | null): SessionWaitpoints {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const query = useQuery({
    ...trpc.waitpoints.list.queryOptions({ sessionId: sessionId ?? '' }),
    enabled: !!sessionId,
    // Poll only while something is actually armed; an idle session costs nothing.
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? REFRESH_MS : false),
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
