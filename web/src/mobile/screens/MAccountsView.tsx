import type { CustomProviderView } from '@cortex-agent/ui-contract';
import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { MButton, MC, MDot, MONO } from '@/mobile/ui/kit';
import { MSET_INSET, MSettingsGroup, MSettingsHeader as MDrillHeader,
  MSettingsFrame as MScreen, MSettingsBody as MScrollBody, MSettingsGroupLabel as MGroupLabel } from './MSettingsControls';
import type { AccountActionTarget, AccountsVm } from '@/features/settings/vm/accounts-vm';
import {
  AvailableGrid, ClaudeHeading, ClaudeSlots, ConnectedList, ProviderSearch, useLogoutConfirm,
} from '@/features/settings/ui/account-rows';

const META: CSSProperties = { fontSize: 12, color: MC.muted };
const CODE: CSSProperties = { font: `400 12px ${MONO}`, color: MC.muted, overflowWrap: 'anywhere' };

/** Unrouted is the one state worth flagging; the key line is a plain fact. */
function CustomProviderStatus({ provider }: { provider: CustomProviderView }) {
  const L = useVocab();
  return <div style={{ ...META, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
    {provider.routed ? null : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: MC.amberText }}>
      <MDot color={MC.amber} />{L.cpvUnrouted}
    </span>}
    {provider.routed ? null : <span aria-hidden="true">·</span>}
    <span>{provider.hasApiKey ? L.cpvKeyStored : L.cpvNoKey}</span>
  </div>;
}

/**
 * Custom providers carry no login: the credential sits in the gateway route, so the row offers an
 * editor and a two-tap delete instead of the login/logout pair above.
 */
function CustomProviderRow({ provider, editDisabled, deleteDisabled, confirming, onEdit, onDelete }: {
  provider: CustomProviderView;
  editDisabled: boolean;
  deleteDisabled: boolean;
  confirming: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const L = useVocab();
  return (
    <div data-custom-provider={provider.name} style={{ padding: `12px ${MSET_INSET}px`, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 650, color: MC.ink }}>{provider.name}</span>
        <span style={CODE}>{provider.api}</span>
      </div>
      <span style={CODE}>{provider.upstreamUrl ?? '—'}</span>
      <span style={{ ...META, fontSize: 13, overflowWrap: 'anywhere' }}>{provider.models.map(model => model.id).join(', ')}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <CustomProviderStatus provider={provider} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <MButton compact data-cpv-action="edit" data-cpv-provider={provider.name}
            disabled={editDisabled} onClick={onEdit}>{L.cpvEdit}</MButton>
          <MButton compact variant="danger-outline" data-cpv-action="delete" data-cpv-provider={provider.name}
            disabled={deleteDisabled} onClick={onDelete}>{confirming ? L.cpvConfirmDelete : L.cpvDelete}</MButton>
        </span>
      </div>
    </div>
  );
}

export interface MCustomProvidersProps {
  providers: CustomProviderView[];
  /** Name armed for deletion by a first tap, or null. */
  confirmingDelete: string | null;
  savePending: boolean;
  removePending: boolean;
  onNew: () => void;
  onEdit: (provider: CustomProviderView) => void;
  onDelete: (name: string) => void;
}

export function MAccountsView({
  vm, filter, onFilter, onBack, onLogin, onLogout, actionsDisabled, custom, onRescan, rescanning,
}: {
  vm: AccountsVm;
  filter: string;
  onFilter: (value: string) => void;
  onBack: () => void;
  onLogin: (target: AccountActionTarget) => void;
  onLogout: (target: AccountActionTarget) => void;
  actionsDisabled: boolean;
  custom: MCustomProvidersProps;
  onRescan: () => void;
  rescanning: boolean;
}) {
  const L = useVocab();
  const confirm = useLogoutConfirm();
  const handlers = { onLogin, onLogout, disabled: actionsDisabled };
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
        <section>
          <MGroupLabel trailing={
            <MButton compact data-cpv-action="new" disabled={custom.savePending} onClick={custom.onNew}>{L.cpvNew}</MButton>
          }>{L.cpvTitle} · {custom.providers.length}</MGroupLabel>
          {custom.providers.length > 0
            ? <MSettingsGroup>{custom.providers.map(provider => (
              <CustomProviderRow
                key={provider.name} provider={provider}
                editDisabled={custom.savePending} deleteDisabled={custom.removePending}
                confirming={custom.confirmingDelete === provider.name}
                onEdit={() => custom.onEdit(provider)}
                onDelete={() => custom.onDelete(provider.name)}
              />
            ))}</MSettingsGroup>
            : <div style={{ ...META, padding: `4px ${MSET_INSET}px` }}>{L.cpvNone}</div>}
        </section>
      </MScrollBody>
    </MScreen>
  );
}
