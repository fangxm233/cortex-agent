// input:  auth status/logout tRPC, LoginFlow, mobile navigation
// output: data-bound accounts screen with serialized logout
// pos:    Mobile accounts query and mutation container
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { AuthStatusSnapshot, CustomProviderView } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { MScreen, MC } from '@/mobile/ui/kit';
import {
  buildCustomProviderArgs,
  emptyCustomProviderForm,
  formStateFromCustomProvider,
  validateCustomProviderForm,
  type CustomProviderFormState,
} from '@/features/settings/custom-provider-vm';
import { MAccountsView } from './MAccountsView';
import { MCustomProviderSheet } from './MCustomProviderSheet';
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

  const [draft, setDraft] = useState<CustomProviderFormState | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const customList = useQuery(trpc.auth.customProviders.queryOptions({}));
  const customProviders = customList.data ?? [];
  const refreshCustom = (): void => {
    void queryClient.invalidateQueries(trpc.auth.customProviders.queryFilter({}));
    void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
  };
  const customFailed = (error: { message: string }) => toast({ title: `${L.cpvToastFailed}: ${error.message}`, tone: 'failed' });
  const saveCustom = useMutation(trpc.auth.upsertCustomProvider.mutationOptions({
    onSuccess: () => {
      refreshCustom();
      setDraft(null);
      toast({ title: L.cpvToastSaved, tone: 'done' });
    },
    onError: customFailed,
  }));
  const removeCustom = useMutation(trpc.auth.removeCustomProvider.mutationOptions({
    onSuccess: () => {
      refreshCustom();
      setConfirmingDelete(null);
      toast({ title: L.cpvToastDeleted, tone: 'done' });
    },
    onError: customFailed,
  }));
  const customErrors = draft
    ? validateCustomProviderForm(draft, {
      mode: creating ? 'create' : 'update',
      existingNames: customProviders.map((provider: CustomProviderView) => provider.name),
    })
    : {};
  const custom = {
    providers: customProviders,
    confirmingDelete,
    onNew: () => { setCreating(true); setDraft(emptyCustomProviderForm()); },
    onEdit: (provider: CustomProviderView) => { setCreating(false); setDraft(formStateFromCustomProvider(provider)); },
    // First tap arms the row, the second removes the gateway route the gateway is serving.
    onDelete: (name: string) => {
      if (confirmingDelete !== name) setConfirmingDelete(name);
      else removeCustom.mutate({ name });
    },
  };
  const busy = logout.isPending || saveCustom.isPending || removeCustom.isPending;

  return (
    <MScreen label={L.accountsTitle}>
      {status.isLoading
        ? <div style={{ padding: 16, color: MC.muted }}>{L.accountsLoading}</div>
        : status.isError
          ? <div style={{ padding: 16, color: MC.fail }}>{L.accountsLoadFailed}</div>
          : <MAccountsView
              vm={vm} onBack={() => navigate('/m/settings')}
              onLogin={openLogin} onLogout={onLogout} actionsDisabled={busy}
              custom={custom}
            />}
      {draft ? (
        <MCustomProviderSheet
          draft={draft} creating={creating} errors={customErrors}
          onChange={setDraft} onClose={() => setDraft(null)}
          onSave={() => saveCustom.mutate(buildCustomProviderArgs(draft))}
        />
      ) : null}
    </MScreen>
  );
}
