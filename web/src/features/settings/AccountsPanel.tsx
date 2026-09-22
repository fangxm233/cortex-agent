import { useState, type CSSProperties } from 'react';
import type { AuthType } from '@cortex-agent/ui-contract';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useVocab, type Vocab } from '@/i18n';
import {
  buildAccountsVm,
  type AccountActionTarget,
  type AccountCredentialVm,
  type AccountStatusTone,
  type AccountStatusVm,
  type ClaudeAccountVm,
  type ClaudeCredentialSlotVm,
  type PiProviderVm,
} from '@/features/settings/accounts-vm';
import { CustomProvidersCard } from './CustomProvidersCard';
import { useAccountsController } from './useAccountsController';
import {
  SButton, SCount, SDot, SEntityName, SEntityRow, SLinkAction, SNotice, SPill, SRow, SRowGroup,
  SSection, S_CONTROL_STYLE, type SPillTone,
} from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";

// One state, two renderings: the pill carries the words, the dot repeats it as colour so a long
// provider list can be read down its left edge without parsing a single label.
const STATE_STYLE: Record<AccountStatusTone, { tone: SPillTone; dot: string }> = {
  done: { tone: 'success', dot: 'var(--proto-success)' },
  waiting: { tone: 'amber', dot: 'var(--proto-amber)' },
  failed: { tone: 'danger', dot: 'var(--proto-danger)' },
  cancelled: { tone: 'neutral', dot: 'var(--proto-muted-3)' },
};

const META_STYLE: CSSProperties = { font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-2)' };

const PANEL_TEXT_STYLE: CSSProperties = { fontSize: 12.5, color: 'var(--proto-muted-2)' };

function StatePill({ value }: { value: AccountStatusVm }) {
  const L = useVocab();
  return (
    <SPill data-account-state={value.kind} tone={STATE_STYLE[value.tone].tone} mono>
      {L[value.labelKey]}
    </SPill>
  );
}

export interface AccountsPanelProps {
  onLogin?: (target: AccountActionTarget) => void;
}

function authTypeLabel(L: Vocab, authType: AuthType, backend: 'claude' | 'pi'): string {
  if (authType === 'api_key') return L.authLoginApiKey;
  return backend === 'claude' ? L.authLoginSubscription : L.authLoginOAuth;
}

/** State, source and expiry for one stored credential — the description line of a Claude slot. */
function CredentialLine({ value }: { value: AccountCredentialVm }) {
  const L = useVocab();
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <StatePill value={value} />
      <span style={META_STYLE}>{L.accountsSource}: {value.source ?? '—'}</span>
      {value.expiresAt ? <span style={META_STYLE}>{L.accountsExpires}: {value.expiresAt}</span> : null}
    </span>
  );
}

interface ActionsProps {
  backend: 'claude' | 'pi';
  provider: string;
  loginTypes: AuthType[];
  logoutTypes: AuthType[];
  disabled: boolean;
  onLogin: (target: AccountActionTarget) => void;
  onLogout: (target: AccountActionTarget) => void;
}

type SharedActions = Omit<ActionsProps, 'backend' | 'provider' | 'loginTypes' | 'logoutTypes'>;

function AccountActions(props: ActionsProps) {
  const L = useVocab();
  const target = (authType: AuthType): AccountActionTarget => ({ backend: props.backend, provider: props.provider, authType });
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {props.loginTypes.map(authType => (
        <SButton
          key={`login:${authType}`} tone="accent" disabled={props.disabled}
          data-auth-action="login" data-backend={props.backend}
          data-provider={props.provider} data-auth-type={authType}
          aria-label={`${L.accountsLogin} ${authTypeLabel(L, authType, props.backend)}`}
          onClick={() => props.onLogin(target(authType))}
        >
          {L.accountsLogin} {authTypeLabel(L, authType, props.backend)}
        </SButton>
      ))}
      {props.logoutTypes.map(authType => (
        <SButton
          key={`logout:${authType}`} tone="danger" disabled={props.disabled}
          data-auth-action="logout" data-backend={props.backend}
          data-provider={props.provider} data-auth-type={authType}
          aria-label={`${L.accountsLogout} ${authTypeLabel(L, authType, props.backend)}`}
          onClick={() => props.onLogout(target(authType))}
        >
          {L.accountsLogout} {authTypeLabel(L, authType, props.backend)}
        </SButton>
      ))}
    </div>
  );
}

function ClaudeSlotRow({ slot, provider, actions }: {
  slot: ClaudeCredentialSlotVm;
  provider: string;
  actions: SharedActions;
}) {
  const L = useVocab();
  return (
    <SRow
      title={authTypeLabel(L, slot.authType, 'claude')}
      desc={(
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {slot.credentials.map((credential, index) => (
            <CredentialLine key={`${credential.source ?? 'none'}:${index}`} value={credential} />
          ))}
        </span>
      )}
      control={(
        <AccountActions
          {...actions} backend="claude" provider={provider}
          loginTypes={slot.canLogin ? [slot.authType] : []}
          logoutTypes={slot.canLogout ? [slot.authType] : []}
        />
      )}
    />
  );
}

function ClaudeCard({ account, actions }: { account: ClaudeAccountVm; actions: SharedActions }) {
  const L = useVocab();
  const label = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <ProviderIcon provider="claude-code" label="Claude Code" size={14} />
      Claude Code
    </span>
  );
  return (
    <SSection label={label} action={account.inUse ? <SPill tone="success">{L.accountsInUse}</SPill> : undefined}>
      <SRowGroup>
        {account.slots.map(slot => (
          <ClaudeSlotRow key={slot.authType} slot={slot} provider={account.provider} actions={actions} />
        ))}
      </SRowGroup>
    </SSection>
  );
}

function ProviderName({ provider }: { provider: PiProviderVm }) {
  const L = useVocab();
  return (
    <>
      <ProviderIcon provider={provider.provider} label={provider.label} size={16} />
      <SEntityName>{provider.label}</SEntityName>
      {provider.inUse ? <SPill tone="success">{L.accountsInUse}</SPill> : null}
      {provider.loginTypes.map(authType => (
        <SPill key={authType} tone="accent" mono>
          {authType === 'api_key' ? L.authLoginApiKey : L.authLoginOAuth}
        </SPill>
      ))}
    </>
  );
}

function providerMeta(L: Vocab, provider: PiProviderVm): string {
  const parts = [provider.provider, `${L.accountsSource}: ${provider.source ?? '—'}`];
  if (provider.expiresAt) parts.push(`${L.accountsExpires}: ${provider.expiresAt}`);
  return parts.join('  ·  ');
}

function ProviderRow({ provider, actions }: { provider: PiProviderVm; actions: SharedActions }) {
  const L = useVocab();
  return (
    <SEntityRow
      dot={<SDot color={STATE_STYLE[provider.status.tone].dot} />}
      name={<ProviderName provider={provider} />}
      meta={providerMeta(L, provider)}
      trailing={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatePill value={provider.status} />
          <AccountActions
            {...actions} backend="pi" provider={provider.provider}
            loginTypes={provider.loginTypes} logoutTypes={provider.logoutTypes}
          />
        </div>
      )}
    />
  );
}

function ProviderFilter({ filter, onFilter }: { filter: string; onFilter: (value: string) => void }) {
  const L = useVocab();
  return (
    <div>
      <input
        data-accounts-filter aria-label={L.accountsFilter}
        value={filter} onChange={event => onFilter(event.target.value)}
        placeholder={L.accountsFilterPlaceholder} style={S_CONTROL_STYLE}
      />
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--proto-muted-2)', marginTop: 8, padding: '0 2px' }}>
        {L.accountsSyncModelsHint}
      </div>
    </div>
  );
}

function SectionCount({ label, count }: { label: string; count: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      {label}
      <SCount tone="accent">{count}</SCount>
    </span>
  );
}

function PiProviderList({ providers, filter, onFilter, actions, onRescan, rescanning }: {
  providers: PiProviderVm[];
  filter: string;
  onFilter: (value: string) => void;
  actions: SharedActions;
  onRescan: () => void;
  rescanning: boolean;
}) {
  const L = useVocab();
  const rescan = (
    <SLinkAction data-accounts-sync disabled={rescanning} onClick={onRescan}>
      {L.accountsSyncModels}
    </SLinkAction>
  );
  return (
    <SSection label={<SectionCount label={L.accountsPiProviders} count={providers.length} />} action={rescan}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ProviderFilter filter={filter} onFilter={onFilter} />
        {providers.map(provider => (
          <ProviderRow key={provider.provider} provider={provider} actions={actions} />
        ))}
        {providers.length === 0 ? <SNotice tone="muted">{L.accountsNoProviders}</SNotice> : null}
      </div>
    </SSection>
  );
}

export function AccountsPanel({ onLogin }: AccountsPanelProps) {
  const L = useVocab();
  const { openLogin } = useLoginFlow();
  const controller = useAccountsController();
  const [filter, setFilter] = useState('');
  if (controller.statusLoading) return <div style={PANEL_TEXT_STYLE}>{L.accountsLoading}</div>;
  if (controller.statusError || !controller.status) {
    return <div style={{ ...PANEL_TEXT_STYLE, color: 'var(--proto-danger)' }}>{L.accountsLoadFailed}</div>;
  }
  const vm = buildAccountsVm(controller.status, filter);
  const actions = {
    disabled: controller.logoutPending,
    onLogin: onLogin ?? openLogin,
    onLogout: controller.logout,
  };
  return (
    <>
      {vm.claude ? <ClaudeCard account={vm.claude} actions={actions} /> : null}
      <PiProviderList
        providers={vm.piProviders} filter={filter} onFilter={setFilter} actions={actions}
        onRescan={controller.syncGateway} rescanning={controller.syncPending}
      />
      <CustomProvidersCard />
    </>
  );
}
