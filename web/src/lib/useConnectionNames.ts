import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { connectionNames, defaultLoginName, type ConnectionNames } from '@/lib/model-selection';

/** Connection display names for pickers: accounts by label, Claude's default login by the email it
 *  is signed in as, else `defaultLoginFallback`. Queries only while `enabled`. */
export function useConnectionNames(defaultLoginFallback: string, enabled = true): ConnectionNames {
  const trpc = useTRPC();
  const connections = useQuery(trpc.connections.list.queryOptions({}, { enabled }));
  const status = useQuery(trpc.auth.status.queryOptions({}, { enabled }));
  return connectionNames(connections.data, defaultLoginName(status.data, defaultLoginFallback));
}
