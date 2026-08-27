// input:  daemon status/restart tRPC contracts and query cache
// output: shared 5s status polling, canonical facts and restart lifecycle
// pos:    Headless desktop/mobile daemon resource
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SystemDaemonStatus,
  SystemRestartArgs,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { buildDaemonVm, type DaemonVm } from './daemon-vm';

const STATUS_REFRESH_MS = 5_000;

export type DaemonRestartState = 'idle' | 'pending' | 'success' | 'error';

export interface UseDaemonResourceOptions {
  enabled?: boolean;
}

export interface DaemonResource {
  daemon: SystemDaemonStatus | null;
  facts: DaemonVm;
  loading: boolean;
  error: Error | null;
  restart: (kind: SystemRestartArgs['kind']) => void;
  restartState: DaemonRestartState;
  restartError: Error | null;
}

function restartState(status: string): DaemonRestartState {
  if (status === 'pending') return 'pending';
  if (status === 'success') return 'success';
  if (status === 'error') return 'error';
  return 'idle';
}

function asError(value: unknown): Error | null {
  if (!value) return null;
  if (value instanceof Error) return value;
  const message = typeof value === 'object' && 'message' in value ? String(value.message) : String(value);
  return new Error(message);
}

export function useDaemonResource(options: UseDaemonResourceOptions = {}): DaemonResource {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const statusOptions = trpc.system.daemonStatus.queryOptions({});
  const status = useQuery({
    ...statusOptions,
    enabled,
    refetchInterval: enabled ? STATUS_REFRESH_MS : false,
  });
  const restart = useMutation(trpc.system.restart.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: statusOptions.queryKey, exact: true });
      await queryClient.invalidateQueries(trpc.threads.list.queryFilter());
    },
  }));
  return {
    daemon: status.data ?? null,
    facts: buildDaemonVm(status.data),
    loading: status.isLoading,
    error: asError(status.error),
    restart: (kind) => restart.mutate({ kind }),
    restartState: restartState(restart.status),
    restartError: asError(restart.error),
  };
}
