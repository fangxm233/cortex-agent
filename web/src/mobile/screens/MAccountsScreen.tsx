import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useAccountsController } from '@/features/settings/controllers/useAccountsController';
import { useConnectionsController } from '@/features/settings/controllers/useConnectionsController';
import { useVocab } from '@/i18n';
import { MC } from '@/mobile/ui/kit';
import { MSettingsPage } from './MSettingsControls';
import { MAccountsView } from './MAccountsView';
import { MConnectionSheet } from './MConnectionSheet';
import { buildAccountsVm } from '@/features/settings/vm/accounts-vm';

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
  const connections = useConnectionsController();
  const [filter, setFilter] = useState('');
  const vm = useMemo(() => buildAccountsVm(accounts.status ?? EMPTY_STATUS, filter), [accounts.status, filter]);
  return (
    <>
      {accounts.statusLoading
        ? <MSettingsPage title={L.accountsTitle} onBack={() => mobileHeaderBack(navigate, '/m/settings')}>
            <div style={{ color: MC.muted }}>{L.accountsLoading}</div></MSettingsPage>
        : accounts.statusError
          ? <MSettingsPage title={L.accountsTitle} onBack={() => mobileHeaderBack(navigate, '/m/settings')}>
              <div style={{ color: MC.fail }}>{L.accountsLoadFailed}</div></MSettingsPage>
          : <MAccountsView vm={vm} filter={filter} onFilter={setFilter} onBack={() => mobileHeaderBack(navigate, '/m/settings')}
              onLogin={openLogin} onLogout={accounts.logout} onRemove={accounts.remove}
              actionsDisabled={accounts.logoutPending || accounts.removePending}
              onRescan={accounts.syncModels} rescanning={accounts.syncPending}
              connections={{
                rows: connections.rows, confirmingDelete: connections.confirmingDelete,
                savePending: connections.savePending, removePending: connections.removePending,
                onNew: connections.openCreate, onEdit: connections.openEdit, onDelete: connections.requestDelete,
              }} />}
      {connections.draft ? (
        <MConnectionSheet draft={connections.draft} creating={connections.creating}
          errors={connections.errors} pending={connections.savePending}
          kinds={connections.kinds} overridable={connections.overridable}
          onChange={connections.changeDraft} onClose={connections.closeDraft} onSave={connections.save} />
      ) : null}
    </>
  );
}
