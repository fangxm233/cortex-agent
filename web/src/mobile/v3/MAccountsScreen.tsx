// input:  account controllers, login flow, mobile account views
// output: MAccountsScreen
// pos:    Mobile account screen and provider editor wiring
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useAccountsController } from '@/features/settings/useAccountsController';
import { useCustomProvidersController } from '@/features/settings/useCustomProvidersController';
import { useVocab } from '@/i18n';
import { MC } from '@/mobile/ui/kit';
import { MSettingsPage } from './MSettingsControls';
import { MAccountsView } from './MAccountsView';
import { MCustomProviderSheet } from './MCustomProviderSheet';
import { buildAccountsVm } from '@/features/settings/accounts-vm';

const EMPTY_STATUS: AuthStatusSnapshot = {
  generatedAt: '',
  accounts: [],
  piRuntime: { available: false, version: null, entry: null, error: null },
};

export function MAccountsScreen() {
  const L = useVocab();
  const navigate = useNavigate();
  const { openLogin } = useLoginFlow();
  const accounts = useAccountsController();
  const custom = useCustomProvidersController();
  const vm = useMemo(() => buildAccountsVm(accounts.status ?? EMPTY_STATUS), [accounts.status]);
  return (
    <>
      {accounts.statusLoading
        ? <MSettingsPage title={L.accountsTitle} onBack={() => navigate('/m/settings')}>
            <div style={{ color: MC.muted }}>{L.accountsLoading}</div></MSettingsPage>
        : accounts.statusError
          ? <MSettingsPage title={L.accountsTitle} onBack={() => navigate('/m/settings')}>
              <div style={{ color: MC.fail }}>{L.accountsLoadFailed}</div></MSettingsPage>
          : <MAccountsView vm={vm} onBack={() => navigate('/m/settings')}
              onLogin={openLogin} onLogout={accounts.logout}
              actionsDisabled={accounts.logoutPending}
              onRescan={accounts.syncGateway} rescanning={accounts.syncPending}
              custom={{
                providers: custom.providers, confirmingDelete: custom.confirmingDelete,
                savePending: custom.savePending, removePending: custom.removePending,
                onNew: custom.openCreate, onEdit: custom.openEdit, onDelete: custom.requestDelete,
              }} />}
      {custom.draft ? (
        <MCustomProviderSheet draft={custom.draft} creating={custom.creating}
          errors={custom.errors} pending={custom.savePending}
          onChange={custom.changeDraft} onClose={custom.closeDraft} onSave={custom.save} />
      ) : null}
    </>
  );
}
