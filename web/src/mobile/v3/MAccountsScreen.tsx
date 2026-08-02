// input:  auth status/logout tRPC, LoginFlow, mobile navigation
// output: data-bound accounts screen with serialized logout
// pos:    Mobile accounts query and mutation container
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MAccountsView } from './MAccountsView';
import { buildAccountsVm, type AccountActionTarget } from './m-accounts-vm';

const EMPTY_STATUS: AuthStatusSnapshot = {
  generatedAt: '',
  accounts: [],
  piRuntime: { available: false, version: null, entry: null, error: null },
};

export function MAccountsScreen() {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openLogin } = useLoginFlow();
  const status = useQuery(trpc.auth.status.queryOptions({}));
  const vm = useMemo(() => buildAccountsVm(status.data ?? EMPTY_STATUS), [status.data]);
  const logout = useMutation(trpc.auth.logout.mutationOptions({
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
      toast({ title: L.accountsLogoutDone, tone: 'done' });
    },
    onError: error => toast({ title: `${L.accountsLogoutFailed}: ${error.message}`, tone: 'failed' }),
  }));
  const onLogout = (target: AccountActionTarget) => logout.mutate(target);
  return (
    <MScreen label={L.accountsTitle}>
      {status.isLoading
        ? <div style={{ padding: 16, color: MC.muted }}>{L.accountsLoading}</div>
        : status.isError
          ? <div style={{ padding: 16, color: MC.fail }}>{L.accountsLoadFailed}</div>
          : <MAccountsView
              vm={vm} onBack={() => navigate('/m/settings')}
              onLogin={openLogin} onLogout={onLogout} actionsDisabled={logout.isPending}
            />}
    </MScreen>
  );
}
