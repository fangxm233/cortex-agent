// input:  shared accounts/custom-provider controllers, LoginFlow, and mobile navigation
// output: mobile accounts screen with operation-specific action gates and editor sheet
// pos:    Mobile composition view over canonical settings ownership
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useAccountsController } from '@/features/settings/useAccountsController';
import { useCustomProvidersController } from '@/features/settings/useCustomProvidersController';
import { useVocab } from '@/i18n';
import { MScreen, MC } from '@/mobile/ui/kit';
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
    <MScreen label={L.accountsTitle}>
      {accounts.statusLoading
        ? <div style={{ padding: 16, color: MC.muted }}>{L.accountsLoading}</div>
        : accounts.statusError
          ? <div style={{ padding: 16, color: MC.fail }}>{L.accountsLoadFailed}</div>
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
    </MScreen>
  );
}
