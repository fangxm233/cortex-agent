import type { CSSProperties } from 'react';
import type { AuthType } from '@cortex-agent/ui-contract';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { fmt, useLang, useVocab, type Vocab } from '@/i18n';
import {
  authTypeLabelKey,
  connectedMeta,
  externalSourceText,
  reloginLabel,
  type AccountActionTarget,
  type AvailableProviderVm,
  type ClaudeAccountVm,
  type ClaudeSlotVm,
  type ConnectedProviderVm,
  type CredentialHealth,
} from '@/features/settings/vm/accounts-vm';
import { SLinkAction, SMeta, SRowGroup, S_CONTROL_STYLE } from './settings-ui';
import {
  ACTIONS_STYLE, AccountButton, ConfirmStrip, HealthStatus, LEAD_STYLE, META_STYLE, NAME_STYLE, Row,
  quietExpiry, targetAttrs, type AccountRowHandlers, type LogoutConfirm,
} from './account-row-kit';
import { AddAccountRow, DefaultTag, NamedAccountRow, type AccountGroup } from './named-account-rows';

export { AccountButton, useLogoutConfirm, type AccountRowHandlers, type LogoutConfirm } from './account-row-kit';

// One row family for every place accounts are listed: Settings → Accounts, the mobile Accounts
// screen and the provider setup page. Inline styles on shared tokens, so each host only supplies
// the surrounding page. Rows and grids are unboxed; a host that wants rows inset from its edge sets
// `--settings-row-inset`.

// A PI row leads with an 18px provider mark and an 8px gap; its accounts line up with the name.
const PI_ACCOUNT_INDENT = 26;

function ProviderMark({ provider, label }: { provider: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', width: 18, justifyContent: 'center', flex: 'none', color: 'var(--proto-ink)' }}>
      <ProviderIcon provider={provider} label={label} size={16} />
    </span>
  );
}

function ExternalNote() {
  const L = useVocab();
  return (
    <span data-account-external title={L.accountsExternalHint}
      style={{ fontSize: 12, color: 'var(--proto-muted-3)', whiteSpace: 'nowrap', cursor: 'help' }}>
      {L.accountsExternal}
    </span>
  );
}

interface ManageProps {
  backend: 'claude' | 'pi';
  provider: string;
  label: string;
  activeType: AuthType | null;
  health: CredentialHealth;
  inUse: boolean;
  loginTypes: AuthType[];
  logoutTypes: AuthType[];
  external: boolean;
  handlers: AccountRowHandlers;
  confirm: LogoutConfirm;
}

function loginActionLabel(type: AuthType, activeType: AuthType | null, backend: 'claude' | 'pi', L: Vocab): string {
  if (type === activeType || activeType === null) return reloginLabel(type, L);
  return fmt(L.accountsLoginWith, { type: L[authTypeLabelKey(type, backend)] as string });
}

/** Re-login and logout for a connected account; an armed logout replaces them with its confirm. */
function ManageActions(props: ManageProps) {
  const L = useVocab();
  const target = (authType: AuthType): AccountActionTarget => ({
    backend: props.backend, provider: props.provider, authType, label: props.label,
  });
  const armed = props.logoutTypes.find(type => props.confirm.isArmed(target(type)));
  if (armed && props.handlers.onLogout) {
    const armedTarget = target(armed);
    return (
      <ConfirmStrip action="logout" target={armedTarget} disabled={props.handlers.disabled}
        message={props.inUse ? `${L.accountsLogoutConfirm} ${L.accountsLogoutConfirmInUse}` : L.accountsLogoutConfirm}
        confirmLabel={L.accountsLogout}
        onConfirm={() => { props.confirm.disarm(); props.handlers.onLogout?.(armedTarget); }}
        onCancel={props.confirm.disarm} />
    );
  }
  const logins = props.loginTypes.map(type => {
    const attrs = {
      'data-auth-action': 'login', 'data-backend': props.backend,
      'data-provider': props.provider, 'data-auth-type': type, disabled: props.handlers.disabled,
      onClick: () => props.handlers.onLogin(target(type)),
    };
    const text = loginActionLabel(type, props.activeType, props.backend, L);
    // An expired credential needs the login; it gets the button rather than a quiet link.
    return props.health === 'expired' && type === props.activeType
      ? <AccountButton key={`login:${type}`} {...attrs}>{text}</AccountButton>
      : <SLinkAction key={`login:${type}`} tone="muted" {...attrs}>{text}</SLinkAction>;
  });
  const logouts = props.handlers.onLogout ? props.logoutTypes.map(type => (
    <SLinkAction key={`logout:${type}`} tone="danger" data-auth-action="logout" data-backend={props.backend}
      data-provider={props.provider} data-auth-type={type} disabled={props.handlers.disabled}
      onClick={() => props.confirm.arm(target(type))}>
      {props.logoutTypes.length > 1
        ? fmt(L.accountsLogoutType, { type: L[authTypeLabelKey(type, props.backend)] as string })
        : L.accountsLogout}
    </SLinkAction>
  )) : [];
  return (
    <span style={ACTIONS_STYLE}>
      {logins}
      {logouts}
      {props.external && logouts.length === 0 ? <ExternalNote /> : null}
    </span>
  );
}

function LoginTypeButtons({ provider, label, types, handlers }: {
  provider: string; label: string; types: AuthType[]; handlers: AccountRowHandlers;
}) {
  const L = useVocab();
  return (
    <span style={{ ...ACTIONS_STYLE, columnGap: 6 }}>
      {types.map(type => {
        const target: AccountActionTarget = { backend: 'pi', provider, authType: type, label };
        return (
          <AccountButton key={type} {...targetAttrs('login', target)} disabled={handlers.disabled}
            onClick={() => handlers.onLogin(target)}>
            {L[authTypeLabelKey(type, 'pi')] as string}
          </AccountButton>
        );
      })}
    </span>
  );
}

function providerMeta(provider: ConnectedProviderVm, L: Vocab, lang: 'en' | 'zh'): string {
  if (!provider.connected) return L.accountsNotSet;
  return [connectedMeta(provider, 'pi', L), quietExpiry(provider.health, provider.expiresAt, L, lang)]
    .filter(Boolean).join(' · ');
}

/** A PI provider's default login; a provider that only has named accounts offers the login here. */
export function ConnectedProviderRow({ provider, handlers, confirm }: {
  provider: ConnectedProviderVm; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  const lang = useLang();
  const meta = providerMeta(provider, L, lang);
  return (
    <Row data-account-row={provider.provider} data-account-connected={provider.connected ? '' : undefined}>
      <span style={LEAD_STYLE}>
        <ProviderMark provider={provider.provider} label={provider.label} />
        <span style={NAME_STYLE}>{provider.label}</span>
        {provider.connected && provider.accounts.length > 0 ? <DefaultTag /> : null}
        {meta ? <span data-account-meta style={META_STYLE}>{meta}</span> : null}
        <HealthStatus health={provider.health} expiresAt={provider.expiresAt} />
      </span>
      {provider.connected ? (
        <ManageActions backend="pi" provider={provider.provider} label={provider.label}
          activeType={provider.authType} health={provider.health} inUse={provider.inUse}
          loginTypes={provider.loginTypes} logoutTypes={provider.logoutTypes}
          external={!!provider.external} handlers={handlers} confirm={confirm} />
      ) : (
        <LoginTypeButtons provider={provider.provider} label={provider.label} types={provider.loginTypes} handlers={handlers} />
      )}
    </Row>
  );
}

function ClaudeSlotRow({ account, slot, handlers, confirm }: {
  account: ClaudeAccountVm; slot: ClaudeSlotVm; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  const lang = useLang();
  const name = L[authTypeLabelKey(slot.authType, 'claude')] as string;
  const target: AccountActionTarget = {
    backend: 'claude', provider: account.provider, authType: slot.authType, label: account.label,
  };
  if (!slot.connected) {
    return (
      <Row data-account-row={`claude:${slot.authType}`}>
        <span style={LEAD_STYLE}>
          <span style={NAME_STYLE}>{name}</span>
          <span data-account-meta style={META_STYLE}>{L.accountsNotSet}</span>
        </span>
        {slot.canLogin ? (
          <span style={ACTIONS_STYLE}>
            <AccountButton data-auth-action="login" data-backend="claude" data-provider={account.provider}
              data-auth-type={slot.authType} disabled={handlers.disabled} onClick={() => handlers.onLogin(target)}>
              {slot.authType === 'api_key' ? L.accountsAddKey : L.accountsLogin}
            </AccountButton>
          </span>
        ) : null}
      </Row>
    );
  }
  const subscription = slot.authType === 'oauth';
  const meta = [
    subscription ? account.identity : null,
    slot.external ? externalSourceText(slot.external, L) : null,
    slot.inUse ? L.accountsInUse : null,
    quietExpiry(slot.health, slot.expiresAt, L, lang),
  ].filter(Boolean).join(' · ');
  return (
    <Row data-account-row={`claude:${slot.authType}`} data-account-connected>
      <span style={LEAD_STYLE}>
        <span style={NAME_STYLE}>{name}</span>
        {subscription && account.accounts.length > 0 ? <DefaultTag /> : null}
        {meta ? <span data-account-meta style={META_STYLE}>{meta}</span> : null}
        <HealthStatus health={slot.health} expiresAt={slot.expiresAt} />
      </span>
      <ManageActions backend="claude" provider={account.provider} label={account.label}
        activeType={slot.authType} health={slot.health} inUse={slot.inUse}
        loginTypes={slot.canLogin ? [slot.authType] : []} logoutTypes={slot.canLogout ? [slot.authType] : []}
        external={!!slot.external} handlers={handlers} confirm={confirm} />
    </Row>
  );
}

export function ClaudeSlots({ account, handlers, confirm }: {
  account: ClaudeAccountVm; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const group: AccountGroup = { backend: 'claude', provider: account.provider, providerLabel: account.label };
  return (
    <SRowGroup data-account-group="claude">
      {account.slots.map(slot => (
        <ClaudeSlotRow key={slot.authType} account={account} slot={slot} handlers={handlers} confirm={confirm} />
      ))}
      {account.accounts.map(named => (
        <NamedAccountRow key={named.connection} group={group} account={named} handlers={handlers} confirm={confirm} />
      ))}
      {handlers.onRemove ? <AddAccountRow group={group} types={account.addTypes} handlers={handlers} /> : null}
    </SRowGroup>
  );
}

export function ClaudeHeading({ inUse }: { inUse: boolean }) {
  const L = useVocab();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <ProviderIcon provider="claude-code" label="Claude Code" size={14} />
      Claude Code
      {inUse ? <SMeta>{L.accountsInUse}</SMeta> : null}
    </span>
  );
}

export function ConnectedList({ providers, handlers, confirm }: {
  providers: ConnectedProviderVm[]; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  if (providers.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', padding: '2px 2px 0' }}>{L.accountsNoConnected}</div>;
  }
  return (
    <SRowGroup data-account-group="connected">
      {providers.map(provider => (
        <ProviderGroup key={provider.provider} provider={provider} handlers={handlers} confirm={confirm} />
      ))}
    </SRowGroup>
  );
}

/** A provider's default login, its named accounts, and the row that adds one, as one block. */
function ProviderGroup({ provider, handlers, confirm }: {
  provider: ConnectedProviderVm; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const group: AccountGroup = {
    backend: 'pi', provider: provider.provider, providerLabel: provider.label, indent: PI_ACCOUNT_INDENT,
  };
  const canAdd = !!handlers.onRemove && provider.addTypes.length > 0;
  return (
    <div data-account-provider-group={provider.provider}>
      <ConnectedProviderRow provider={provider} handlers={handlers} confirm={confirm} />
      {provider.accounts.map(named => (
        <NamedAccountRow key={named.connection} group={group} account={named} handlers={handlers} confirm={confirm} />
      ))}
      {canAdd ? <AddAccountRow group={group} types={provider.addTypes} handlers={handlers} /> : null}
    </div>
  );
}

export function AvailableProviderRow({ provider, handlers }: {
  provider: AvailableProviderVm; handlers: AccountRowHandlers;
}) {
  return (
    <Row data-account-row={provider.provider}>
      <span style={LEAD_STYLE}>
        <ProviderMark provider={provider.provider} label={provider.label} />
        <span style={{ ...NAME_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', minWidth: 0 }}>
          {provider.label}
        </span>
      </span>
      <LoginTypeButtons provider={provider.provider} label={provider.label} types={provider.loginTypes} handlers={handlers} />
    </Row>
  );
}

// Two columns of rows with a gap between them. Each cell draws a hairline above itself; the grid
// clips its top edge, so the first row has none, whatever the column count at this width.
function gridStyle(minColumn: number): CSSProperties {
  return {
    display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minColumn}px), 1fr))`,
    columnGap: 24, clipPath: 'inset(0 -12px -12px -12px)', minWidth: 0,
  };
}
const CELL_STYLE: CSSProperties = { boxShadow: '0 -1px 0 var(--proto-line-2)', minWidth: 0 };

/** `minColumn` is the narrowest a cell may get before the grid drops a column. */
export function AvailableGrid({ providers, handlers, minColumn = 300 }: {
  providers: AvailableProviderVm[]; handlers: AccountRowHandlers; minColumn?: number;
}) {
  const L = useVocab();
  if (providers.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', padding: '2px 2px 0' }}>{L.accountsNoProviders}</div>;
  }
  return (
    <div data-account-group="available" style={gridStyle(minColumn)}>
      {providers.map(provider => (
        <div key={provider.provider} style={CELL_STYLE}>
          <AvailableProviderRow provider={provider} handlers={handlers} />
        </div>
      ))}
    </div>
  );
}

export function ProviderSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const L = useVocab();
  return (
    <input data-accounts-filter type="search" aria-label={L.accountsFilter} value={value}
      onChange={event => onChange(event.target.value)} placeholder={L.accountsFilterPlaceholder}
      style={{ ...S_CONTROL_STYLE, minHeight: 32, padding: '5px 10px', marginBottom: 4 }} />
  );
}
