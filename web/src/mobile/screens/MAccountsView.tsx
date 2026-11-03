import { useVocab } from '@/i18n';
import { MButton, MC } from '@/mobile/ui/kit';
import { MSettingsHeader as MDrillHeader,
  MSettingsFrame as MScreen, MSettingsBody as MScrollBody, MSettingsGroupLabel as MGroupLabel } from './MSettingsControls';
import type { AccountActionTarget, AccountsVm } from '@/features/settings/vm/accounts-vm';
import {
  AvailableGrid, ClaudeHeading, ClaudeSlots, ConnectedList, ProviderSearch, useLogoutConfirm,
} from '@/features/settings/ui/account-rows';
import { MConnectionsSection, type MConnectionsProps } from './MConnectionsSection';

export type { MConnectionsProps } from './MConnectionsSection';

export function MAccountsView({
  vm, filter, onFilter, onBack, onLogin, onLogout, onRemove, actionsDisabled, connections, onRescan, rescanning,
}: {
  vm: AccountsVm;
  filter: string;
  onFilter: (value: string) => void;
  onBack: () => void;
  onLogin: (target: AccountActionTarget) => void;
  onLogout: (target: AccountActionTarget) => void;
  /** Deletes a named account; absent, no account can be added or deleted. */
  onRemove?: (target: AccountActionTarget) => void;
  actionsDisabled: boolean;
  connections: MConnectionsProps;
  onRescan: () => void;
  rescanning: boolean;
}) {
  const L = useVocab();
  const confirm = useLogoutConfirm();
  const handlers = { onLogin, onLogout, onRemove, disabled: actionsDisabled };
  const trailing = (
    <MButton compact data-accounts-sync disabled={rescanning} onClick={onRescan}>{L.accountsSyncModels}</MButton>
  );
  const header = (
    <MDrillHeader onBack={onBack} trailing={trailing}>
      <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{L.accountsTitle}</div>
    </MDrillHeader>
  );
  return (
    <MScreen label={L.accountsTitle} header={header}>
      <MScrollBody>
        {vm.claude ? (
          <section>
            <MGroupLabel><ClaudeHeading inUse={vm.claude.inUse} /></MGroupLabel>
            <ClaudeSlots account={vm.claude} handlers={handlers} confirm={confirm} />
          </section>
        ) : null}
        <section>
          <MGroupLabel>{L.accountsConnected} · {vm.connected.length}</MGroupLabel>
          <ConnectedList providers={vm.connected} handlers={handlers} confirm={confirm} />
        </section>
        {vm.availableTotal > 0 ? (
          <section>
            <MGroupLabel>{L.accountsAddProvider} · {vm.availableTotal}</MGroupLabel>
            <ProviderSearch value={filter} onChange={onFilter} />
            <AvailableGrid providers={vm.available} handlers={handlers} />
          </section>
        ) : null}
        <MConnectionsSection connections={connections} />
      </MScrollBody>
    </MScreen>
  );
}
