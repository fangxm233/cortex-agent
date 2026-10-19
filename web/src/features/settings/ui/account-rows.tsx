import { useState, type CSSProperties, type ReactNode } from 'react';
import type { AuthType } from '@cortex-agent/ui-contract';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { fmt, useLang, useVocab, type Vocab } from '@/i18n';
import {
  authTypeLabelKey,
  connectedMeta,
  expiryText,
  externalSourceText,
  reloginLabel,
  type AccountActionTarget,
  type AvailableProviderVm,
  type ClaudeAccountVm,
  type ClaudeSlotVm,
  type ConnectedProviderVm,
  type CredentialHealth,
} from '@/features/settings/vm/accounts-vm';
import { SLinkAction, SMeta, SRowGroup, SStatus, S_CONTROL_STYLE } from './settings-ui';

// One row family for every place accounts are listed: Settings → Accounts, the mobile Accounts
// screen and the provider setup page. Inline styles on shared tokens, so each host only supplies
// the surrounding page. Rows and grids are unboxed; a host that wants rows inset from its edge sets
// `--settings-row-inset`.

export interface AccountRowHandlers {
  onLogin: (target: AccountActionTarget) => void;
  /** Absent where logging out is not offered (provider setup). */
  onLogout?: (target: AccountActionTarget) => void;
  disabled?: boolean;
}

const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 10, rowGap: 6,
  padding: '8px var(--settings-row-inset, 0px)', minHeight: 40, boxSizing: 'border-box', minWidth: 0,
};
const LEAD_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto', minWidth: 0,
};
const NAME_STYLE: CSSProperties = {
  fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', whiteSpace: 'nowrap', flex: 'none',
};
const META_STYLE: CSSProperties = {
  fontSize: 12, color: 'var(--proto-muted-2)', whiteSpace: 'nowrap', overflow: 'hidden',
  textOverflow: 'ellipsis', minWidth: 0, flex: '0 1 auto',
};
const ACTIONS_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap',
  columnGap: 12, rowGap: 4, marginLeft: 'auto', flex: 'none', maxWidth: '100%',
};

function Row({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) {
  return <div {...rest} style={ROW_STYLE}>{children}</div>;
}

function ProviderMark({ provider, label }: { provider: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', width: 18, justifyContent: 'center', flex: 'none', color: 'var(--proto-ink)' }}>
      <ProviderIcon provider={provider} label={label} size={16} />
    </span>
  );
}

/** A small hairline-outline (secondary) button: the login entry of a row that has nothing to
 *  manage yet. Ink on the control surface, not accent — the accent is kept for state. */
export function AccountButton({ children, disabled, onClick, ...rest }: {
  children: ReactNode; disabled?: boolean; onClick: () => void;
} & Record<string, unknown>) {
  const [hover, setHover] = useState(false);
  return (
    <button {...rest} type="button" disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        fontFamily: 'inherit', fontSize: 12, fontWeight: 600, lineHeight: 1.4, whiteSpace: 'nowrap',
        padding: '3px 9px', borderRadius: 7, flex: 'none',
        border: '1px solid var(--proto-line-3)', color: 'var(--proto-ink)',
        background: hover && !disabled ? 'var(--proto-alt)' : 'var(--material-control-bg)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
      }}>
      {children}
    </button>
  );
}

function HealthStatus({ health, expiresAt }: { health: CredentialHealth; expiresAt: string | null }) {
  const L = useVocab();
  const lang = useLang();
  if (health === 'expired') return <SStatus data-account-health="expired" tone="danger">{L.accountsExpired}</SStatus>;
  if (health !== 'expiring') return null;
  return (
    <SStatus data-account-health="expiring" tone="amber">
      {expiryText(expiresAt, Date.now(), lang, L) ?? L.accountsExpired}
    </SStatus>
  );
}

/** Expiry far enough out to be informational; near or past dates are carried by the status. */
function quietExpiry(health: CredentialHealth, expiresAt: string | null, L: Vocab, lang: 'en' | 'zh'): string | null {
  if (health === 'expiring' || health === 'expired') return null;
  return expiryText(expiresAt, Date.now(), lang, L);
}

function confirmKey(target: AccountActionTarget): string {
  return `${target.backend}:${target.provider}:${target.authType}`;
}

/** Which logout is armed for confirmation; one at a time across the list. */
export function useLogoutConfirm() {
  const [armed, setArmed] = useState<string | null>(null);
  return {
    isArmed: (target: AccountActionTarget) => armed === confirmKey(target),
    arm: (target: AccountActionTarget) => setArmed(confirmKey(target)),
    disarm: () => setArmed(null),
  };
}

export type LogoutConfirm = ReturnType<typeof useLogoutConfirm>;

function ConfirmLogout({ target, inUse, handlers, confirm }: {
  target: AccountActionTarget; inUse: boolean; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  return (
    <span data-logout-confirm role="group" style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0, marginLeft: 'auto' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-danger)', overflowWrap: 'anywhere' }}>
        {L.accountsLogoutConfirm}{inUse ? ` ${L.accountsLogoutConfirmInUse}` : ''}
      </span>
      {/* The two answers wrap as one unit, never apart. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flex: 'none', marginLeft: 'auto' }}>
        <button type="button" data-auth-action="logout-confirm" data-backend={target.backend}
          data-provider={target.provider} data-auth-type={target.authType} disabled={handlers.disabled}
          onClick={() => { confirm.disarm(); handlers.onLogout?.(target); }}
          style={{
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 7,
            border: '1px solid var(--proto-danger-bg)', color: 'var(--proto-danger)',
            background: 'var(--material-control-bg)', cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
          {L.accountsLogout}
        </button>
        <SLinkAction tone="muted" data-auth-action="logout-cancel" onClick={confirm.disarm}>{L.cancel}</SLinkAction>
      </span>
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
    return <ConfirmLogout target={target(armed)} inUse={props.inUse} handlers={props.handlers} confirm={props.confirm} />;
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

export function ConnectedProviderRow({ provider, handlers, confirm }: {
  provider: ConnectedProviderVm; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  const lang = useLang();
  const meta = [connectedMeta(provider, 'pi', L), quietExpiry(provider.health, provider.expiresAt, L, lang)]
    .filter(Boolean).join(' · ');
  return (
    <Row data-account-row={provider.provider} data-account-connected>
      <span style={LEAD_STYLE}>
        <ProviderMark provider={provider.provider} label={provider.label} />
        <span style={NAME_STYLE}>{provider.label}</span>
        {meta ? <span data-account-meta style={META_STYLE}>{meta}</span> : null}
        <HealthStatus health={provider.health} expiresAt={provider.expiresAt} />
      </span>
      <ManageActions backend="pi" provider={provider.provider} label={provider.label}
        activeType={provider.authType} health={provider.health} inUse={provider.inUse}
        loginTypes={provider.loginTypes} logoutTypes={provider.logoutTypes}
        external={!!provider.external} handlers={handlers} confirm={confirm} />
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
  const meta = [
    slot.external ? externalSourceText(slot.external, L) : null,
    slot.inUse ? L.accountsInUse : null,
    quietExpiry(slot.health, slot.expiresAt, L, lang),
  ].filter(Boolean).join(' · ');
  return (
    <Row data-account-row={`claude:${slot.authType}`} data-account-connected>
      <span style={LEAD_STYLE}>
        <span style={NAME_STYLE}>{name}</span>
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
  return (
    <SRowGroup data-account-group="claude">
      {account.slots.map(slot => (
        <ClaudeSlotRow key={slot.authType} account={account} slot={slot} handlers={handlers} confirm={confirm} />
      ))}
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
        <ConnectedProviderRow key={provider.provider} provider={provider} handlers={handlers} confirm={confirm} />
      ))}
    </SRowGroup>
  );
}

export function AvailableProviderRow({ provider, handlers }: {
  provider: AvailableProviderVm; handlers: AccountRowHandlers;
}) {
  const L = useVocab();
  return (
    <Row data-account-row={provider.provider}>
      <span style={LEAD_STYLE}>
        <ProviderMark provider={provider.provider} label={provider.label} />
        <span style={{ ...NAME_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', minWidth: 0 }}>
          {provider.label}
        </span>
      </span>
      <span style={{ ...ACTIONS_STYLE, columnGap: 6 }}>
        {provider.loginTypes.map(type => (
          <AccountButton key={type} data-auth-action="login" data-backend="pi" data-provider={provider.provider}
            data-auth-type={type} disabled={handlers.disabled}
            onClick={() => handlers.onLogin({ backend: 'pi', provider: provider.provider, authType: type, label: provider.label })}>
            {L[authTypeLabelKey(type, 'pi')] as string}
          </AccountButton>
        ))}
      </span>
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
