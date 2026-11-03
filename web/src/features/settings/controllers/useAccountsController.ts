import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { fmt, useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { CLAUDE_CODE_LABEL, type AccountActionTarget } from '@/features/settings/vm/accounts-vm';

export interface AccountsController {
  status: AuthStatusSnapshot | undefined;
  statusLoading: boolean;
  statusError: { message: string } | null;
  logout: (target: AccountActionTarget) => void;
  /** Deletes a named account: it is signed out and its sessions move to the default account. */
  remove: (target: AccountActionTarget) => void;
  syncModels: () => void;
  logoutPending: boolean;
  removePending: boolean;
  syncPending: boolean;
}

function accountLabel(target: AccountActionTarget): string {
  return target.label ?? (target.backend === 'claude' ? CLAUDE_CODE_LABEL : target.provider);
}

function useAccountMutations() {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // The API-key slot's credential is the `api` connection, and an account is a connection too: the
  // connections list, the catalog and the usage rows move with a logout or a delete.
  const refresh = () => {
    void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
    void queryClient.invalidateQueries(trpc.connections.list.queryFilter({}));
    void queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
    void queryClient.invalidateQueries(trpc.models.catalog.queryFilter({}));
  };
  const logout = useMutation(trpc.auth.logout.mutationOptions({
    onSuccess: refresh,
    onError: error => toast({ title: `${L.accountsLogoutFailed}: ${error.message}`, tone: 'failed' }),
  }));
  const remove = useMutation(trpc.auth.removeAccount.mutationOptions({
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries(trpc.system.usageStatus.queryFilter({}));
      void queryClient.invalidateQueries(trpc.system.rateLimitStatus.queryFilter({}));
    },
    onError: error => toast({ title: `${L.accountsRemoveFailed}: ${error.message}`, tone: 'failed' }),
  }));
  return { logout, remove };
}

function useSyncModels() {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation(trpc.auth.syncModels.mutationOptions({
    onSuccess: result => {
      if (!result.configured) return toast({ title: L.accountsSyncModelsEmpty, tone: 'waiting' });
      void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
      void queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
      void queryClient.invalidateQueries(trpc.models.catalog.queryFilter({}));
      toast({ title: L.accountsSyncModelsDone, tone: 'done' });
    },
    onError: error => toast({ title: `${L.accountsSyncModelsFailed}: ${error.message}`, tone: 'failed' }),
  }));
}

export function useAccountsController(): AccountsController {
  const L = useVocab();
  const trpc = useTRPC();
  const { toast } = useToast();
  const status = useQuery(trpc.auth.status.queryOptions({}));
  const { logout, remove } = useAccountMutations();
  const sync = useSyncModels();
  return {
    status: status.data, statusLoading: status.isLoading, statusError: status.error,
    logout: target => logout.mutate(
      {
        backend: target.backend, provider: target.provider, authType: target.authType,
        ...(target.connection ? { connection: target.connection } : {}),
      },
      { onSuccess: () => toast({ title: fmt(L.accountsLogoutDone, { provider: accountLabel(target) }), tone: 'done' }) },
    ),
    remove: target => {
      if (!target.connection) return;
      remove.mutate(
        { backend: target.backend, id: target.connection },
        { onSuccess: () => toast({ title: fmt(L.accountsRemoveDone, { account: accountLabel(target) }), tone: 'done' }) },
      );
    },
    syncModels: () => sync.mutate({}),
    logoutPending: logout.isPending, removePending: remove.isPending, syncPending: sync.isPending,
  };
}
