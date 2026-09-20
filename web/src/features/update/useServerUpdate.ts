// input:  system.updateStatus / applyUpdate / skipUpdate over tRPC
// output: the server self-update prompt state plus the shell re-check cascade
// pos:    Server-backed half of the unified update prompt; owns no shell state
// >>> If updated, update this header and parent AGENTS.md <<<

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { checkForUpdates } from './manual-update-check';

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
  visible: boolean;
  busy: boolean;
  apply: () => void;
  skip: () => void;
  dismiss: () => void;
}

/**
 * The app shell's update manifest is capped at the server's version, so a new release only becomes
 * visible to the shell once the server is already running it. Re-check the moment the server comes
 * back from `restarting` — without this the shell would not notice for up to 24h and the "one
 * confirmation" promise would quietly become "one confirmation, then wait a day".
 */
export function useShellRecheckCascade(state: SystemUpdateStatus['state']): void {
  const wasRestarting = useRef(false);
  useEffect(() => {
    if (state === 'restarting') {
      wasRestarting.current = true;
      return;
    }
    if (!wasRestarting.current) return;
    wasRestarting.current = false;
    void checkForUpdates();
  }, [state]);
}

export function useServerUpdate(): ServerUpdate {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<string | null>(null);

  const query = useQuery({
    ...trpc.system.updateStatus.queryOptions({}),
    // The server restarts itself out from under this query; keep polling through the outage and
    // keep showing the last known state rather than flipping the dialog away on a failed fetch.
    refetchInterval: (q) => updateStatusPollMs(q.state.data?.state ?? 'idle'),
    refetchIntervalInBackground: true,
    retry: true,
  });

  const status = query.data ?? IDLE;
  const invalidate = () => queryClient.invalidateQueries(trpc.system.updateStatus.queryFilter());
  const applyMutation = useMutation(trpc.system.applyUpdate.mutationOptions({ onSettled: invalidate }));
  const skipMutation = useMutation(trpc.system.skipUpdate.mutationOptions({ onSettled: invalidate }));
  const { mutate: applyMutate } = applyMutation;
  const { mutate: skipMutate } = skipMutation;

  useShellRecheckCascade(status.state);

  const apply = useCallback(() => { applyMutate({}); }, [applyMutate]);
  const skip = useCallback(() => { skipMutate({}); }, [skipMutate]);
  const dismiss = useCallback(() => { setDismissed(status.available ?? ''); }, [status.available]);

  return {
    status,
    visible: serverUpdateVisible(status, dismissed),
    busy: applyMutation.isPending || skipMutation.isPending,
    apply,
    skip,
    dismiss,
  };
}
