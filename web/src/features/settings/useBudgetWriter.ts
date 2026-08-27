// input:  budget scope/value writes, config.set, and the shared query cache
// output: write/clear operations with unified config and cost invalidation
// pos:    Shared desktop/mobile budget mutation controller
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BudgetValue } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import {
  budgetClearArgs,
  budgetSetArgs,
  type BudgetScopeId,
} from './budget-vm';

export type BudgetWriterOperation = 'write' | 'clear';

export interface BudgetWriter {
  write: (scope: BudgetScopeId, value: BudgetValue) => Promise<'write'>;
  clear: (projectId: string) => Promise<'clear'>;
  isPending: boolean;
}

export function useBudgetWriter(): BudgetWriter {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation(trpc.config.set.mutationOptions({
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries(trpc.config.get.queryFilter({})),
        queryClient.invalidateQueries(trpc.cost.summary.queryFilter()),
      ]);
    },
  }));

  const write = async (scope: BudgetScopeId, value: BudgetValue): Promise<'write'> => {
    await mutation.mutateAsync(budgetSetArgs(scope, value));
    return 'write';
  };

  const clear = async (projectId: string): Promise<'clear'> => {
    await mutation.mutateAsync(budgetClearArgs(projectId));
    return 'clear';
  };

  return { write, clear, isPending: mutation.isPending };
}
