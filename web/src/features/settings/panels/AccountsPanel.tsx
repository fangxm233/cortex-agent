import { useState, type CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { buildAccountsVm, type AccountActionTarget } from '@/features/settings/vm/accounts-vm';
import { useAccountsController } from '@/features/settings/controllers/useAccountsController';
import {
  AvailableGrid, ClaudeHeading, ClaudeSlots, ConnectedList, ProviderSearch, useLogoutConfirm,
} from '@/features/settings/ui/account-rows';
import { SCount, SLinkAction, SSection } from '@/features/settings/ui/settings-ui';
import { CustomProvidersCard } from './CustomProvidersCard';

const PANEL_TEXT_STYLE: CSSProperties = { fontSize: 13, color: 'var(--proto-muted-2)', overflowWrap: 'anywhere' };

export interface AccountsPanelProps {
  onLogin: (target: AccountActionTarget) => void;
}

function SectionCount({ label, count }: { label: string; count: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      {label}
      <SCount tone="accent">{count}</SCount>
    </span>
  );
}

export function AccountsPanel({ onLogin }: AccountsPanelProps) {
  const L = useVocab();
  const controller = useAccountsController();
  const confirm = useLogoutConfirm();
  const [filter, setFilter] = useState('');
  if (controller.statusLoading) return <div style={PANEL_TEXT_STYLE}>{L.accountsLoading}</div>;
  if (controller.statusError || !controller.status) {
    return <div style={{ ...PANEL_TEXT_STYLE, color: 'var(--proto-danger)' }}>{L.accountsLoadFailed}</div>;
  }
  const vm = buildAccountsVm(controller.status, filter);
  const handlers = { onLogin, onLogout: controller.logout, disabled: controller.logoutPending };
  const rescan = (
    <SLinkAction data-accounts-sync disabled={controller.syncPending} onClick={controller.syncGateway}>
      {L.accountsSyncModels}
    </SLinkAction>
  );
  return (
    <>
      {vm.claude ? (
        <SSection label={<ClaudeHeading inUse={vm.claude.inUse} />}>
          <ClaudeSlots account={vm.claude} handlers={handlers} confirm={confirm} />
        </SSection>
      ) : null}
      <SSection label={<SectionCount label={L.accountsConnected} count={vm.connected.length} />} action={rescan}>
        <ConnectedList providers={vm.connected} handlers={handlers} confirm={confirm} />
      </SSection>
      {vm.availableTotal > 0 ? (
        <SSection label={<SectionCount label={L.accountsAddProvider} count={vm.availableTotal} />}>
          <ProviderSearch value={filter} onChange={setFilter} />
          <AvailableGrid providers={vm.available} handlers={handlers} />
        </SSection>
      ) : null}
      <CustomProvidersCard />
    </>
  );
}
