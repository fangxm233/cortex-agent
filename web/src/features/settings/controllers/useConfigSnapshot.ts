import { useQuery } from '@tanstack/react-query';
import type { ConfigSnapshot, CostSummary, ProjectConduitInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import type { BudgetScopeId } from '@/features/settings/vm/budget-vm';

/** A read a settings surface renders in one of three states: loading, failed or loaded. */
export interface SettingsQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

/** The shared `config.get` snapshot the settings panels render from. */
export function useConfigSnapshot(): SettingsQuery<ConfigSnapshot> {
  const trpc = useTRPC();
  const query = useQuery(trpc.config.get.queryOptions({}));
  return { data: query.data, isLoading: query.isLoading, isError: query.isError, error: query.error };
}

/** The projects a budget can be scoped to; empty until the list loads. */
export function useProjectList(): ProjectConduitInfo[] {
  const trpc = useTRPC();
  return useQuery(trpc.projects.list.queryOptions({})).data ?? [];
}

/** Spend for one budget scope, so project limits are never compared with all-project spend. */
export function useBudgetSpend(scope: BudgetScopeId): CostSummary | undefined {
  const trpc = useTRPC();
  return useQuery(trpc.cost.summary.queryOptions(scope === null ? {} : { projectId: scope })).data;
}
