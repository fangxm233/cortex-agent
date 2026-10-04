import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { todayBudget, type TodayBudget } from './machines-menu-vm';

/** Today's spend for the current project against its resolved daily limit. */
export function useTodayBudget(): TodayBudget {
  const trpc = useTRPC();
  const { currentProjectId } = useCurrentProject();
  const projectId = currentProjectId ?? undefined;
  const cost = useQuery({ ...trpc.cost.summary.queryOptions({ projectId }), enabled: !!projectId });
  return todayBudget(cost.data?.today, cost.data?.dailyBudget);
}
