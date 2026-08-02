// input:  shared accounts VM, localized copy, gated actions
// output: grouped mobile account-management drill-in
// pos:    Presentational mobile accounts view
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 raw px/font by design §8.3
import type { ReactNode } from 'react';
import type { AuthType } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import {
  MCard,
  MDrillHeader,
  MGroupLabel,
  MPill,
  MScrollBody,
  MC,
  MONO,
} from '@/mobile/ui/kit';
import type {
  AccountActionTarget,
  AccountCredentialVm,
  ClaudeAccountVm,
  MAccountsVm,
  PiProviderVm,
} from './m-accounts-vm';

function authTypeLabel(L: Vocab, authType: AuthType, backend: 'claude' | 'pi'): string {
  if (authType === 'api_key') return L.authLoginApiKey;
  return backend === 'claude' ? L.authLoginSubscription : L.authLoginOAuth;
}

function Metadata({ value }: { value: AccountCredentialVm }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span><MPill tone={value.tone}>{L[value.labelKey]}</MPill></span>
      <span style={{ font: `400 9.5px ${MONO}`, color: MC.muted, overflowWrap: 'anywhere' }}>
        {L.accountsSource}: {value.source ?? '—'}
      </span>
      {value.expiresAt ? <span style={{ font: `400 9.5px ${MONO}`, color: MC.muted, overflowWrap: 'anywhere' }}>{L.accountsExpires}: {value.expiresAt}</span> : null}
      {value.refreshExpiresAt ? <span style={{ font: `400 9.5px ${MONO}`, color: MC.muted, overflowWrap: 'anywhere' }}>{L.accountsRefreshExpires}: {value.refreshExpiresAt}</span> : null}
    </div>
  );
}

function ActionButton({ children, target, action, disabled, onClick }: {
  children: ReactNode;
  target: AccountActionTarget;
  action: 'login' | 'logout';
  disabled: boolean;
  onClick: (target: AccountActionTarget) => void;
}) {
  return (
    <button
      type="button" data-auth-action={action} data-backend={target.backend}
      data-provider={target.provider} data-auth-type={target.authType}
      disabled={disabled} onClick={() => onClick(target)}
      style={{
        border: `1px solid ${action === 'logout' ? 'var(--proto-danger-bg)' : MC.run}`,
        borderRadius: 8, padding: '6px 9px', background: MC.card,
        color: action === 'logout' ? MC.fail : MC.run, fontSize: 10.5,
        fontWeight: 650, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

function AccountActions({ backend, provider, loginTypes, logoutTypes, disabled, onLogin, onLogout }: {
  backend: 'claude' | 'pi';
  provider: string;
  loginTypes: AuthType[];
  logoutTypes: AuthType[];
  disabled: boolean;
  onLogin: (target: AccountActionTarget) => void;
  onLogout: (target: AccountActionTarget) => void;
}) {
  const L = useVocab();
  const target = (authType: AuthType): AccountActionTarget => ({ backend, provider, authType });
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {loginTypes.map(authType => (
        <ActionButton
          key={`login:${authType}`} target={target(authType)} action="login"
          disabled={disabled} onClick={onLogin}
        >
          {L.accountsLogin} {authTypeLabel(L, authType, backend)}
        </ActionButton>
      ))}
      {logoutTypes.map(authType => (
        <ActionButton
          key={`logout:${authType}`} target={target(authType)} action="logout"
          disabled={disabled} onClick={onLogout}
        >
          {L.accountsLogout} {authTypeLabel(L, authType, backend)}
        </ActionButton>
      ))}
    </div>
  );
}

interface ClaudeCardProps {
  account: ClaudeAccountVm;
  actionsDisabled: boolean;
  onLogin: (target: AccountActionTarget) => void;
  onLogout: (target: AccountActionTarget) => void;
}

function ClaudeCard({ account, actionsDisabled, onLogin, onLogout }: ClaudeCardProps) {
  const L = useVocab();
  return (
    <MCard>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: MC.ink }}>Claude Code</span>
        {account.inUse ? <MPill tone="done">{L.accountsInUse}</MPill> : null}
      </div>
      {account.slots.map((slot, index) => (
        <div key={slot.authType} style={{ padding: '9px 0', borderTop: index > 0 ? `1px solid ${MC.divider}` : undefined }}>
          <div style={{ font: `600 11px ${MONO}`, color: MC.ink, marginBottom: 7 }}>
            {authTypeLabel(L, slot.authType, 'claude')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {slot.credentials.map((credential, credentialIndex) => <Metadata key={`${credential.source ?? 'none'}:${credentialIndex}`} value={credential} />)}
          </div>
          <AccountActions
            backend="claude" provider={account.provider}
            loginTypes={slot.canLogin ? [slot.authType] : []}
            logoutTypes={slot.canLogout ? [slot.authType] : []}
            disabled={actionsDisabled} onLogin={onLogin} onLogout={onLogout}
          />
        </div>
      ))}
    </MCard>
  );
}

function ProviderCard({ provider, actionsDisabled, onLogin, onLogout }: {
  provider: PiProviderVm;
  actionsDisabled: boolean;
  onLogin: (target: AccountActionTarget) => void;
  onLogout: (target: AccountActionTarget) => void;
}) {
  const L = useVocab();
  const metadata: AccountCredentialVm = {
    ...provider.status, source: provider.source,
    expiresAt: provider.expiresAt, refreshExpiresAt: provider.refreshExpiresAt,
  };
  return (
    <MCard>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: MC.ink }}>{provider.label}</span>
        <span style={{ font: `400 9px ${MONO}`, color: MC.muted }}>{provider.provider}</span>
        {provider.loginTypes.map(authType => <MPill key={authType} tone="running">{authType === 'api_key' ? L.authLoginApiKey : L.authLoginOAuth}</MPill>)}
      </div>
      <div style={{ marginTop: 8 }}><Metadata value={metadata} /></div>
      <AccountActions
        backend="pi" provider={provider.provider}
        loginTypes={provider.loginTypes} logoutTypes={provider.logoutTypes}
        disabled={actionsDisabled} onLogin={onLogin} onLogout={onLogout}
      />
    </MCard>
  );
}

export function MAccountsView({ vm, onBack, onLogin, onLogout, actionsDisabled }: {
  vm: MAccountsVm;
  onBack: () => void;
  onLogin: (target: AccountActionTarget) => void;
  onLogout: (target: AccountActionTarget) => void;
  actionsDisabled: boolean;
}) {
  const L = useVocab();
  return (
    <>
      <MDrillHeader onBack={onBack} trailing={<span style={{ font: `500 10px ${MONO}`, color: MC.muted }}>{vm.piProviders.length} PI</span>}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{L.accountsTitle}</div>
      </MDrillHeader>
      <MScrollBody gap={14}>
        {vm.claude ? (
          <ClaudeCard
            account={vm.claude} actionsDisabled={actionsDisabled}
            onLogin={onLogin} onLogout={onLogout}
          />
        ) : null}
        {vm.groups.map(group => (
          <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <MGroupLabel>{L[group.labelKey]} · {group.providers.length}</MGroupLabel>
            {group.providers.map(provider => (
              <ProviderCard
                key={provider.provider} provider={provider} actionsDisabled={actionsDisabled}
                onLogin={onLogin} onLogout={onLogout}
              />
            ))}
          </div>
        ))}
        {vm.piProviders.length === 0 ? <MCard><span style={{ fontSize: 12, color: MC.muted }}>{L.accountsNoProviders}</span></MCard> : null}
      </MScrollBody>
    </>
  );
}
