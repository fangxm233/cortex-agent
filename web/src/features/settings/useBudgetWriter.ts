// input:  budget scope/value writes, config.set, and the shared query cache
// output: synchronously serialized nullable writes with unified config and cost invalidation
// pos:    Shared desktop/mobile budget mutation controller
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useRef } from 'react';
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
  write: (scope: BudgetScopeId, value: BudgetValue) => Promise<'write' | null>;
  clear: (projectId: string) => Promise<'clear' | null>;
  isPending: boolean;
}

export function useBudgetWriter(): BudgetWriter {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const gate = useRef(false);
  const mutation = useMutation(trpc.config.set.mutationOptions({
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries(trpc.config.get.queryFilter({})),
        queryClient.invalidateQueries(trpc.cost.summary.queryFilter()),
      ]);
    },
  }));

  const run = async <T extends BudgetWriterOperation>(operation: T, args: ReturnType<typeof budgetSetArgs>) => {
    if (gate.current) return null;
    gate.current = true;
    try {
      await mutation.mutateAsync(args);
      return operation;
    } finally {
      gate.current = false;
    }
  };
  const write = (scope: BudgetScopeId, value: BudgetValue) =>
    run('write', budgetSetArgs(scope, value));
  const clear = (projectId: string) => run('clear', budgetClearArgs(projectId));

  return { write, clear, isPending: mutation.isPending };
}
