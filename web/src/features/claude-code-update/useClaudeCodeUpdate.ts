import { useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaudeCodeStatus } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { claudeCodeBusy } from './claude-code-vm';

export interface ClaudeCodeUpdate {
  status: ClaudeCodeStatus | undefined;
  /** A check or an update is running, here or on the server. */
  busy: boolean;
  check: () => void;
  update: () => void;
}

/** Shared by the Settings row and the chat card; `autoCheck` reads the versions once per server run. */
export function useClaudeCodeUpdate({ autoCheck = false }: { autoCheck?: boolean } = {}): ClaudeCodeUpdate {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery({
    ...trpc.system.claudeCode.queryOptions({}),
    refetchInterval: (q) => (claudeCodeBusy(q.state.data) ? 2_000 : false),
  });
  const store = useCallback((data: ClaudeCodeStatus) => {
    queryClient.setQueryData(trpc.system.claudeCode.queryKey({}), data);
  }, [queryClient, trpc]);
  const checkMutation = useMutation(trpc.system.checkClaudeCode.mutationOptions({ onSuccess: store }));
  const updateMutation = useMutation(trpc.system.updateClaudeCode.mutationOptions({ onSuccess: store }));
  const { mutate: checkMutate } = checkMutation;
  const { mutate: updateMutate } = updateMutation;
  const status = query.data;
  const unchecked = !!status && !status.checkedAt && status.state === 'idle';

  useEffect(() => {
    if (autoCheck && unchecked) checkMutate({});
  }, [autoCheck, unchecked, checkMutate]);

  return {
    status,
    busy: claudeCodeBusy(status) || checkMutation.isPending || updateMutation.isPending,
    check: useCallback(() => checkMutate({}), [checkMutate]),
    update: useCallback(() => updateMutate({}), [updateMutate]),
  };
}
