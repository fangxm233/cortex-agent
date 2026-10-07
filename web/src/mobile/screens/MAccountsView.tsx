import type { CustomProviderView } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MPill, MC, MONO } from '@/mobile/ui/kit';
import { MSettingsSurfaceCard as MCard, MSettingsHeader as MDrillHeader,
  MSettingsFrame as MScreen, MSettingsBody as MScrollBody, MSettingsGroupLabel as MGroupLabel } from './MSettingsControls';
import type { AccountActionTarget, AccountsVm } from '@/features/settings/vm/accounts-vm';
import {
  AvailableGrid, ClaudeHeading, ClaudeSlots, ConnectedList, ProviderSearch, useLogoutConfirm,
} from '@/features/settings/ui/account-rows';

/**
 * Custom providers carry no login: the credential sits in the gateway route, so the card offers an
 * editor and a two-tap delete instead of the login/logout pair above.
 */
function CustomProviderCard({ provider, editDisabled, deleteDisabled, confirming, onEdit, onDelete }: {
  provider: CustomProviderView;
  editDisabled: boolean;
  deleteDisabled: boolean;
  confirming: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const L = useVocab();
  return (
    <MCard>
      <div data-custom-provider={provider.name} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: MC.ink }}>{provider.name}</span>
        <span style={{ font: `400 12px ${MONO}`, color: MC.muted }}>{provider.api}</span>
        {provider.routed ? null : <MPill tone="waiting">{L.cpvUnrouted}</MPill>}
        <MPill tone="cancelled">{provider.hasApiKey ? L.cpvKeyStored : L.cpvNoKey}</MPill>
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ font: `400 12px ${MONO}`, color: MC.muted, overflowWrap: 'anywhere' }}>
          {provider.upstreamUrl ?? '—'}
        </span>
        <span style={{ font: `400 12px ${MONO}`, color: MC.muted, overflowWrap: 'anywhere' }}>
          {provider.models.map(model => model.id).join(', ')}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button
          type="button" data-cpv-action="edit" data-cpv-provider={provider.name}
          disabled={editDisabled} onClick={onEdit}
          style={{
            border: `1px solid ${MC.run}`, borderRadius: 'var(--r-chip)', padding: '6px 9px', background: 'var(--material-inset-bg)',
            color: MC.run, fontSize: 10.5, fontWeight: 650,
            cursor: editDisabled ? 'not-allowed' : 'pointer', opacity: editDisabled ? 0.45 : 1,
          }}
        >
          {L.cpvEdit}
        </button>
        <button
          type="button" data-cpv-action="delete" data-cpv-provider={provider.name}
          disabled={deleteDisabled} onClick={onDelete}
          style={{
            border: '1px solid var(--proto-danger-bg)', borderRadius: 'var(--r-chip)', padding: '6px 9px',
            background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.fail, fontSize: 10.5, fontWeight: 650,
            cursor: deleteDisabled ? 'not-allowed' : 'pointer', opacity: deleteDisabled ? 0.45 : 1,
          }}
        >
          {confirming ? L.cpvConfirmDelete : L.cpvDelete}
        </button>
      </div>
    </MCard>
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
    <button type="button" data-accounts-sync disabled={rescanning} onClick={onRescan}
      style={{ border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-chip)', padding: '5px 8px',
        background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.run, fontSize: 10, fontWeight: 650 }}>
      {L.accountsSyncModels}
    </button>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <MGroupLabel><ClaudeHeading inUse={vm.claude.inUse} /></MGroupLabel>
            <ClaudeSlots account={vm.claude} handlers={handlers} confirm={confirm} />
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <MGroupLabel>{L.accountsConnected} · {vm.connected.length}</MGroupLabel>
          <ConnectedList providers={vm.connected} handlers={handlers} confirm={confirm} />
        </div>
        {vm.availableTotal > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <MGroupLabel>{L.accountsAddProvider} · {vm.availableTotal}</MGroupLabel>
            <div>
              <ProviderSearch value={filter} onChange={onFilter} />
              <AvailableGrid providers={vm.available} handlers={handlers} />
            </div>
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <MGroupLabel>
            {L.cpvTitle} · {custom.providers.length}
            <button
              type="button" data-cpv-action="new" disabled={custom.savePending}
              onClick={custom.onNew}
              style={{
                marginLeft: 8, border: `1px solid ${MC.run}`, borderRadius: 'var(--r-chip)', padding: '3px 8px',
                background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.run, fontSize: 10, fontWeight: 650, cursor: 'pointer',
              }}
            >
              {L.cpvNew}
            </button>
          </MGroupLabel>
          {custom.providers.length > 0
            ? custom.providers.map(provider => (
              <CustomProviderCard
                key={provider.name} provider={provider}
                editDisabled={custom.savePending} deleteDisabled={custom.removePending}
                confirming={custom.confirmingDelete === provider.name}
                onEdit={() => custom.onEdit(provider)}
                onDelete={() => custom.onDelete(provider.name)}
              />
            ))
            : <MCard><span style={{ fontSize: 12, color: MC.muted }}>{L.cpvNone}</span></MCard>}
        </div>
      </MScrollBody>
    </MScreen>
  );
}
