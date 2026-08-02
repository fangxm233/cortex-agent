// input:  auth status/logout tRPC, shared accounts VM, LoginFlow
// output: desktop Claude and PI account-management panel
// pos:    Dedicated desktop accounts settings section
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthType } from '@cortex-agent/ui-contract';
import { StatusPill, useToast } from '@/design';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  buildAccountsVm,
  type AccountActionTarget,
  type AccountCredentialVm,
  type ClaudeAccountVm,
  type PiProviderVm,
} from '@/mobile/v3/m-accounts-vm';
import { SButton, SCard, SCardHeader, SFieldRow, S_CONTROL_STYLE } from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";

export interface AccountsPanelProps {
  onLogin?: (target: AccountActionTarget) => void;
}

function authTypeLabel(L: Vocab, authType: AuthType, backend: 'claude' | 'pi'): string {
  if (authType === 'api_key') return L.authLoginApiKey;
  return backend === 'claude' ? L.authLoginSubscription : L.authLoginOAuth;
}

function StatusMetadata({ value }: { value: AccountCredentialVm }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <StatusPill tone={value.tone} label={L[value.labelKey]} />
      <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-2)' }}>
        {L.accountsSource}: {value.source ?? '—'}
      </span>
      {value.expiresAt ? <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-2)' }}>{L.accountsExpires}: {value.expiresAt}</span> : null}
      {value.refreshExpiresAt ? <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-2)' }}>{L.accountsRefreshExpires}: {value.refreshExpiresAt}</span> : null}
    </div>
  );
}

function CapabilityBadge({ authType }: { authType: AuthType }) {
  const L = useVocab();
  return (
    <span style={{ font: `600 9px ${MONO}`, color: 'var(--proto-accent)', background: 'var(--proto-accent-bg)', borderRadius: 999, padding: '2px 7px' }}>
      {authType === 'api_key' ? L.authLoginApiKey : L.authLoginOAuth}
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

function AccountActions(props: ActionsProps) {
  const L = useVocab();
  const target = (authType: AuthType): AccountActionTarget => ({ backend: props.backend, provider: props.provider, authType });
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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

function ClaudeCard({ account, actions }: { account: ClaudeAccountVm; actions: Omit<ActionsProps, 'backend' | 'provider' | 'loginTypes' | 'logoutTypes'> }) {
  const L = useVocab();
  return (
    <SCard style={{ marginTop: 12, maxWidth: 980 }}>
      <SCardHeader title="Claude Code" right={account.inUse ? L.accountsInUse : undefined} />
      <div style={{ padding: '8px 14px' }}>
        {account.slots.map(slot => (
          <SFieldRow key={slot.authType} label={authTypeLabel(L, slot.authType, 'claude')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {slot.credentials.map((credential, index) => <StatusMetadata key={`${credential.source ?? 'none'}:${index}`} value={credential} />)}
              <AccountActions
                {...actions} backend="claude" provider={account.provider}
                loginTypes={slot.canLogin ? [slot.authType] : []}
                logoutTypes={slot.canLogout ? [slot.authType] : []}
              />
            </div>
          </SFieldRow>
        ))}
      </div>
    </SCard>
  );
}

function ProviderRow({ provider, actions }: { provider: PiProviderVm; actions: Omit<ActionsProps, 'backend' | 'provider' | 'loginTypes' | 'logoutTypes'> }) {
  const L = useVocab();
  const metadata: AccountCredentialVm = {
    ...provider.status,
    source: provider.source,
    expiresAt: provider.expiresAt,
    refreshExpiresAt: provider.refreshExpiresAt,
  };
  return (
    <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--proto-alt)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{provider.label}</span>
        <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>{provider.provider}</span>
        {provider.inUse ? <span style={{ fontSize: 9, fontWeight: 650, color: 'var(--proto-success)', background: 'var(--proto-success-bg)', borderRadius: 999, padding: '2px 7px' }}>{L.accountsInUse}</span> : null}
        {provider.loginTypes.map(authType => <CapabilityBadge key={authType} authType={authType} />)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        <StatusMetadata value={metadata} />
        <span style={{ marginLeft: 'auto' }}>
          <AccountActions
            {...actions} backend="pi" provider={provider.provider}
            loginTypes={provider.loginTypes} logoutTypes={provider.logoutTypes}
          />
        </span>
      </div>
    </div>
  );
}

function PiProviderList({ providers, filter, onFilter, actions }: {
  providers: PiProviderVm[];
  filter: string;
  onFilter: (value: string) => void;
  actions: Omit<ActionsProps, 'backend' | 'provider' | 'loginTypes' | 'logoutTypes'>;
}) {
  const L = useVocab();
  return (
    <SCard style={{ marginTop: 12, maxWidth: 980, overflow: 'hidden' }}>
      <SCardHeader title={L.accountsPiProviders} right={`${providers.length}`} />
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--proto-line-2)' }}>
        <input
          data-accounts-filter aria-label={L.accountsFilter}
          value={filter} onChange={event => onFilter(event.target.value)}
          placeholder={L.accountsFilterPlaceholder} style={S_CONTROL_STYLE}
        />
      </div>
      {providers.length > 0
        ? providers.map(provider => <ProviderRow key={provider.provider} provider={provider} actions={actions} />)
        : <div style={{ padding: '12px 14px', color: 'var(--proto-muted-3)', fontSize: 11 }}>{L.accountsNoProviders}</div>}
    </SCard>
  );
}

export function AccountsPanel({ onLogin }: AccountsPanelProps) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openLogin } = useLoginFlow();
  const [filter, setFilter] = useState('');
  const status = useQuery(trpc.auth.status.queryOptions({}));
  const logout = useMutation(trpc.auth.logout.mutationOptions({
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
      toast({ title: L.accountsLogoutDone, tone: 'done' });
    },
    onError: error => toast({ title: `${L.accountsLogoutFailed}: ${error.message}`, tone: 'failed' }),
  }));
  if (status.isLoading) return <div style={{ marginTop: 16 }}>{L.accountsLoading}</div>;
  if (status.isError || !status.data) return <div style={{ marginTop: 16, color: 'var(--proto-danger)' }}>{L.accountsLoadFailed}</div>;
  const vm = buildAccountsVm(status.data, filter);
  const actions = {
    disabled: logout.isPending,
    onLogin: onLogin ?? openLogin,
    onLogout: (target: AccountActionTarget) => logout.mutate(target),
  };
  return (
    <>
      {vm.claude ? <ClaudeCard account={vm.claude} actions={actions} /> : null}
      <PiProviderList providers={vm.piProviders} filter={filter} onFilter={setFilter} actions={actions} />
    </>
  );
}
