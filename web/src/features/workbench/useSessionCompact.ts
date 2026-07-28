// input:  selected session state, sessions.compact mutation, query cache
// output: ContextCompactAction for the shared context modal
// pos:    Desktop/mobile manual context compaction hook
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import type {
  ContextCompactAction,
  ContextCompactDisabledReason,
} from './ContextUsageControl';

interface SessionCompactOptions {
  running: boolean;
  hasBackendHistory: boolean;
}

export function useSessionCompact(
  sessionId: string,
  options: SessionCompactOptions,
): ContextCompactAction {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'compacted' | 'not-needed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabledReason: ContextCompactDisabledReason = options.running
    ? 'running'
    : !options.hasBackendHistory
      ? 'no-history'
      : null;
  const mutation = useMutation(trpc.sessions.compact.mutationOptions({
    onSuccess: (data) => {
      setStatus(data.status);
      setError(null);
      queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
    },
    onError: (failure) => {
      setStatus(null);
      setError(failure.message);
    },
  }));

  useEffect(() => {
    setStatus(null);
    setError(null);
  }, [sessionId]);

  const onCompact = useCallback(() => {
    if (!sessionId || mutation.isPending || disabledReason) return;
    setStatus(null);
    setError(null);
    mutation.mutate({ sessionId });
  }, [disabledReason, mutation, sessionId]);

  return {
    onCompact,
    pending: mutation.isPending,
    disabled: !sessionId || disabledReason !== null,
    status,
    error,
    disabledReason,
  };
}
