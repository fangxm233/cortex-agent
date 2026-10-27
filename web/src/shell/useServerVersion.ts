import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

export interface ServerVersion {
  version: string | null;
  failed: boolean;
}

/** Version of the server this UI is connected to. */
export function useServerVersion(): ServerVersion {
  const trpc = useTRPC();
  const query = useQuery(trpc.system.version.queryOptions({}));
  return { version: query.data?.version ?? null, failed: query.isError };
}
