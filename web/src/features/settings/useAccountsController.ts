// input:  auth status/logout/syncGateway tRPC, query cache, and localized toasts
// output: shared account snapshot and independently pending logout/rescan actions
// pos:    Cross-surface accounts data and mutation controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import type { AccountActionTarget } from './accounts-vm';

export interface AccountsController {
  status: AuthStatusSnapshot | undefined;
  statusLoading: boolean;
  statusError: { message: string } | null;
  logout: (target: AccountActionTarget) => void;
  syncGateway: () => void;
  logoutPending: boolean;
  syncPending: boolean;
}

export function useAccountsController(): AccountsController {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = useQuery(trpc.auth.status.queryOptions({}));
  const logout = useMutation(trpc.auth.logout.mutationOptions({
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
      toast({ title: L.accountsLogoutDone, tone: 'done' });
    },
    onError: error => toast({ title: `${L.accountsLogoutFailed}: ${error.message}`, tone: 'failed' }),
  }));
  const sync = useMutation(trpc.auth.syncGateway.mutationOptions({
    onSuccess: result => {
      if (!result.configured) return toast({ title: L.accountsSyncModelsEmpty, tone: 'waiting' });
      void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
      void queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
      toast({ title: L.accountsSyncModelsDone, tone: 'done' });
    },
    onError: error => toast({ title: `${L.accountsSyncModelsFailed}: ${error.message}`, tone: 'failed' }),
  }));
  return {
    status: status.data, statusLoading: status.isLoading, statusError: status.error,
    logout: logout.mutate, syncGateway: () => sync.mutate({}),
    logoutPending: logout.isPending, syncPending: sync.isPending,
  };
}
