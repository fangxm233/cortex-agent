// input:  system usage query/refresh procedures and selected language
// output: queried usage view with unthrottled refresh state
// pos:    Shared usage data hook for desktop and mobile consumers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLang } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { buildUsageView, type UsageView } from './usage-vm';

export interface UsageFeatureState {
  view: UsageView;
  isLoading: boolean;
  queryError: { message: string } | null;
  refreshError: { message: string } | null;
  isRefreshing: boolean;
  refresh: () => void;
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function useUsage(): UsageFeatureState {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const lang = useLang();
  const statusOptions = trpc.system.usageStatus.queryOptions({});
  const query = useQuery(statusOptions);
  const refresh = useMutation(trpc.system.refreshUsage.mutationOptions({
    onSuccess: data => queryClient.setQueryData(statusOptions.queryKey, data),
  }));
  return {
    view: buildUsageView(query.data, currentEpochSeconds(), lang),
    isLoading: query.isLoading,
    queryError: query.isError ? query.error : null,
    refreshError: refresh.isError ? refresh.error : null,
    isRefreshing: refresh.isPending,
    refresh: () => refresh.mutate({}),
  };
}
