import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

/** One entry of the shared `config.get` snapshot; undefined while loading or when the server omits it. */
export function useServerSetting(key: string): unknown {
  const trpc = useTRPC();
  const query = useQuery(trpc.config.get.queryOptions({}));
  return query.data?.settings?.find((s) => s.key === key)?.value;
}
