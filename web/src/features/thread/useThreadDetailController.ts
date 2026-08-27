// input:  thread id, artifact mode, tRPC/Query clients, live events, timer, and cancel callback
// output: shared thread detail query, one-second clock, and cancellation controller
// pos:    Headless desktop/mobile thread detail resource lifecycle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { threadIsLive } from './thread-detail-facts';
import { useThreadGetLiveSync } from './useThreadGetLiveSync';

export interface ThreadDetailControllerOptions {
  threadId: string;
  includeArtifactContent?: boolean;
  onCancelled?: () => void;
}

export interface ThreadDetailController {
  detail: ThreadDetail | undefined;
  loading: boolean;
  error: { message: string } | null;
  now: number;
  cancel: () => void;
  cancelPending: boolean;
}

function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [active]);
  return now;
}

function threadGetInput(threadId: string, includeArtifactContent: boolean) {
  return includeArtifactContent ? { threadId, includeArtifactContent: true as const } : { threadId };
}

export function useThreadDetailController(
  options: ThreadDetailControllerOptions,
): ThreadDetailController {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const full = options.includeArtifactContent ?? false;
  const input = threadGetInput(options.threadId, full);
  const getOptions = trpc.threads.get.queryOptions(input);
  const query = useQuery(getOptions);
  useThreadGetLiveSync(options.threadId, full);
  const live = query.data ? threadIsLive(query.data.status) : false;
  const now = useNowTick(live);
  const cancel = useMutation(trpc.threads.cancel.mutationOptions({
    onSuccess: options.onCancelled,
    onSettled: () => Promise.all([
      queryClient.invalidateQueries(trpc.threads.list.queryFilter()),
      queryClient.invalidateQueries({ queryKey: getOptions.queryKey, exact: true }),
    ]),
  }));
  return {
    detail: query.data, loading: query.isPending, error: query.error,
    now, cancel: () => cancel.mutate({ threadId: options.threadId }), cancelPending: cancel.isPending,
  };
}
