import { useCallback, useEffect, useState } from 'react';
import { markServerUpdateApplied, subscribeManualCheckResult } from '@/lib/manual-update-check-result';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';

const IDLE: SystemUpdateStatus = { available: null, state: 'idle' };

/** Watch closely while an install is in flight; idle needs no chatter. */
export function updateStatusPollMs(state: SystemUpdateStatus['state']): number {
  return state === 'idle' ? 60_000 : 2_000;
}

/** The dialog is up for everything except `idle`, unless the user waved this version away. */
export function serverUpdateVisible(status: SystemUpdateStatus, dismissed: string | null): boolean {
  if (status.state === 'idle') return false;
  return dismissed !== (status.available ?? '');
}

export interface ServerUpdate {
  status: SystemUpdateStatus;
  hasStatus: boolean;
  visible: boolean;
  busy: boolean;
  apply: () => void;
  skip: () => void;
  dismiss: () => void;
}

function useManualServerResult(reopen: (value: null) => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  useEffect(() => subscribeManualCheckResult(({ server }) => {
    if (!server) return;
    if (server.status === 'available' && server.update) {
      reopen(null);
      const available = server.update.version;
      queryClient.setQueryData(trpc.system.updateStatus.queryKey({}), (old) => {
        if (old?.state === 'installing' || old?.state === 'restarting') return old;
        return { available, state: 'prompting' as const };
      });
    }
    void queryClient.invalidateQueries(trpc.system.updateStatus.queryFilter());
  }), [trpc, queryClient, reopen]);
}

function useServerStatus() {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.system.updateStatus.queryOptions({}),
    // The server restarts itself out from under this query; keep polling through the outage and
    // keep showing the last known state rather than flipping the dialog away on a failed fetch.
    refetchInterval: (q) => updateStatusPollMs(q.state.data?.state ?? 'idle'),
    refetchIntervalInBackground: true,
    retry: true,
  });

  return { status: query.data ?? IDLE, hasStatus: query.data !== undefined };
}

function useServerActions() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries(trpc.system.updateStatus.queryFilter());
  const applyMutation = useMutation(trpc.system.applyUpdate.mutationOptions({
    onSuccess: (result) => {
      if (result.accepted) markServerUpdateApplied();
      queryClient.setQueryData(trpc.system.updateStatus.queryKey({}), result.status);
    },
    onSettled: invalidate,
  }));
  const skipMutation = useMutation(trpc.system.skipUpdate.mutationOptions({ onSettled: invalidate }));
  const { mutate: applyMutate } = applyMutation;
  const { mutate: skipMutate } = skipMutation;

  const apply = useCallback(() => { applyMutate({}); }, [applyMutate]);
  const skip = useCallback(() => { skipMutate({}); }, [skipMutate]);
  return { apply, skip, busy: applyMutation.isPending || skipMutation.isPending };
}

export function useServerUpdate(): ServerUpdate {
  const { status, hasStatus } = useServerStatus();
  const actions = useServerActions();
  const [dismissed, setDismissed] = useState<string | null>(null);
  useManualServerResult(setDismissed);
  const dismiss = useCallback(() => { setDismissed(status.available ?? ''); }, [status.available]);
  return { status, hasStatus, visible: serverUpdateVisible(status, dismissed), ...actions, dismiss };
}
