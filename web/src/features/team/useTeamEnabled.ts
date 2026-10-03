import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

/**
 * The experimental team-mode switch (`settings.teamEnabled`, off by default). Read from the shared
 * `config.get` snapshot. Fail-closed: reports `false` while loading or when the server omits it.
 */
export function useTeamEnabled(): boolean {
  const trpc = useTRPC();
  const query = useQuery(trpc.config.get.queryOptions({}));
  return query.data?.settings?.some((s) => s.key === 'teamEnabled' && s.value === true) ?? false;
}
