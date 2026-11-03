import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { connectionNames, defaultLoginName, type BackendConnectionNames } from '@/lib/model-selection';

/** Connection display names for pickers, per backend: accounts by label, Claude's default login by
 *  the email it is signed in as, else `defaultLoginFallback`. Queries only while `enabled`. */
export function useConnectionNames(defaultLoginFallback: string, enabled = true): BackendConnectionNames {
  const trpc = useTRPC();
  const connections = useQuery(trpc.connections.list.queryOptions({}, { enabled }));
  const status = useQuery(trpc.auth.status.queryOptions({}, { enabled }));
  const defaultLogin = defaultLoginName(status.data, defaultLoginFallback);
  return {
    claude: connectionNames(connections.data, defaultLogin, 'claude'),
    pi: connectionNames(connections.data, undefined, 'pi'),
  };
}
