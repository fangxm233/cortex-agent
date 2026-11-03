import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AuthType } from '@cortex-agent/ui-contract';
import { fmt, useLang, useVocab, type Vocab } from '@/i18n';
import {
  authTypeLabelKey, reloginLabel, type AccountActionTarget, type NamedAccountVm,
} from '@/features/settings/vm/accounts-vm';
import { SLinkAction, S_CONTROL_STYLE } from './settings-ui';
import {
  ACTIONS_STYLE, AccountButton, ConfirmStrip, HealthStatus, LEAD_STYLE, META_STYLE, NAME_STYLE, Row,
  quietExpiry, targetAttrs, type AccountRowHandlers, type LogoutConfirm,
} from './account-row-kit';

// Accounts added beside a provider's default login, and the row that adds one. They sit at the end
// of the provider's group; `indent` lines them up with the provider name when its row leads with an
// icon.

export interface AccountGroup {
  backend: 'claude' | 'pi';
  provider: string;
  /** The provider's display name; an account reads as "Claude Code (School)". */
  providerLabel: string;
  indent?: number;
}

/** The group's indent on top of the host's row inset, which the row padding already carries. */
function indentStyle(group: AccountGroup): CSSProperties {
  return group.indent ? { paddingLeft: `calc(var(--settings-row-inset, 0px) + ${group.indent}px)` } : {};
}

function accountName(group: AccountGroup, account: string, L: Vocab): string {
  return fmt(L.accountsAccountName, { provider: group.providerLabel, account });
}

function accountTarget(group: AccountGroup, account: NamedAccountVm, L: Vocab): AccountActionTarget {
  return {
    backend: group.backend, provider: group.provider, authType: account.loginType,
    connection: account.connection, label: accountName(group, account.label, L),
  };
}

/** The pill on a default login once other accounts sit beside it. */
export function DefaultTag() {
  const L = useVocab();
  return (
    <span data-account-default style={{
      fontSize: 11, fontWeight: 600, lineHeight: '16px', padding: '0 5px', borderRadius: 5, flex: 'none',
      color: 'var(--proto-muted)', border: '1px solid var(--proto-line-3)', whiteSpace: 'nowrap',
    }}>
      {L.default}
    </span>
  );
}

function namedMeta(account: NamedAccountVm, L: Vocab, lang: 'en' | 'zh'): string {
  if (!account.connected) return L.accountsSignedOut;
  return [account.identity, quietExpiry(account.health, account.expiresAt, L, lang)]
    .filter(Boolean).join(' · ');
}

function ArmedConfirm({ target, handlers, confirm }: {
  target: AccountActionTarget; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  const remove = confirm.isArmed(target, 'remove');
  const run = remove ? handlers.onRemove : handlers.onLogout;
  return (
    <ConfirmStrip action={remove ? 'remove' : 'logout'} target={target} disabled={handlers.disabled}
      message={remove ? L.accountsRemoveConfirm : `${L.accountsLogoutConfirm} ${L.accountsAccountLogoutConfirm}`}
      confirmLabel={remove ? L.accountsRemove : L.accountsLogout}
      onConfirm={() => { confirm.disarm(); run?.(target); }} onCancel={confirm.disarm} />
  );
}

/** A signed-out or expired account needs the login, so it gets the button rather than a quiet link. */
function LoginAction({ account, target, handlers }: {
  account: NamedAccountVm; target: AccountActionTarget; handlers: AccountRowHandlers;
}) {
  const L = useVocab();
  const props = { ...targetAttrs('login', target), disabled: handlers.disabled, onClick: () => handlers.onLogin(target) };
  if (!account.connected) return <AccountButton {...props}>{L.accountsLogin}</AccountButton>;
  const text = reloginLabel(account.loginType, L);
  return account.health === 'expired'
    ? <AccountButton {...props}>{text}</AccountButton>
    : <SLinkAction tone="muted" {...props}>{text}</SLinkAction>;
}

function NamedAccountActions({ group, account, handlers, confirm }: {
  group: AccountGroup; account: NamedAccountVm; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  const target = accountTarget(group, account, L);
  if (confirm.isArmed(target, 'remove') || confirm.isArmed(target, 'logout')) {
    return <ArmedConfirm target={target} handlers={handlers} confirm={confirm} />;
  }
  const canLogout = account.canLogout && !!handlers.onLogout;
  return (
    <span style={ACTIONS_STYLE}>
      <LoginAction account={account} target={target} handlers={handlers} />
      {canLogout ? (
        <SLinkAction tone="muted" {...targetAttrs('logout', target)} disabled={handlers.disabled}
          onClick={() => confirm.arm(target, 'logout')}>{L.accountsLogout}</SLinkAction>
      ) : null}
      {handlers.onRemove ? (
        <SLinkAction tone="danger" {...targetAttrs('remove', target)} disabled={handlers.disabled}
          onClick={() => confirm.arm(target, 'remove')}>{L.accountsRemove}</SLinkAction>
      ) : null}
    </span>
  );
}

export function NamedAccountRow({ group, account, handlers, confirm }: {
  group: AccountGroup; account: NamedAccountVm; handlers: AccountRowHandlers; confirm: LogoutConfirm;
}) {
  const L = useVocab();
  const lang = useLang();
  const meta = namedMeta(account, L, lang);
  return (
    <Row data-account-row={`${group.backend}:${group.provider}:${account.connection}`}
      data-account-connected={account.connected ? '' : undefined} style={indentStyle(group)}>
      <span style={LEAD_STYLE}>
        <span style={NAME_STYLE}>{account.label}</span>
        {meta ? <span data-account-meta style={META_STYLE}>{meta}</span> : null}
        <HealthStatus health={account.health} expiresAt={account.expiresAt} />
      </span>
      <NamedAccountActions group={group} account={account} handlers={handlers} confirm={confirm} />
    </Row>
  );
}

function AddAccountButtons({ group, types, ready, submit }: {
  group: AccountGroup; types: AuthType[]; ready: boolean; submit: (type: AuthType) => void;
}) {
  const L = useVocab();
  // A provider that signs in either way asks which before the login starts.
  if (types.length < 2) {
    return <AccountButton data-account-add-submit disabled={!ready} onClick={() => submit(types[0] ?? 'oauth')}>{L.accountsLogin}</AccountButton>;
  }
  return <>{types.map(type => (
    <AccountButton key={type} data-account-add-submit={type} disabled={!ready} onClick={() => submit(type)}>
      {L[authTypeLabelKey(type, group.backend)] as string}
    </AccountButton>
  ))}</>;
}

/** "Add account", then a name field; the login starts once the account is named. */
export function AddAccountRow({ group, types, handlers }: {
  group: AccountGroup; types: AuthType[]; handlers: AccountRowHandlers;
}) {
  const L = useVocab();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <Row data-account-add={`${group.backend}:${group.provider}`} style={{ ...indentStyle(group), minHeight: 32 }}>
        <SLinkAction data-account-add-open disabled={handlers.disabled} onClick={() => setDraft('')}>
          + {L.accountsAddAccount}
        </SLinkAction>
      </Row>
    );
  }
  const label = draft.trim();
  const submit = (authType: AuthType) => {
    if (!label) return;
    setDraft(null);
    handlers.onLogin({
      backend: group.backend, provider: group.provider, authType, newAccount: label, label: accountName(group, label, L),
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') setDraft(null);
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && types.length < 2) submit(types[0] ?? 'oauth');
  };
  return (
    <Row data-account-add-form={`${group.backend}:${group.provider}`} style={indentStyle(group)}>
      <input data-account-add-label aria-label={L.accountsAccountLabel} placeholder={L.accountsAccountLabelPlaceholder}
        autoFocus maxLength={64} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown}
        style={{ ...S_CONTROL_STYLE, minHeight: 30, padding: '4px 10px', flex: '1 1 160px', width: 'auto', maxWidth: 280 }} />
      <span style={ACTIONS_STYLE}>
        <AddAccountButtons group={group} types={types} ready={!!label && !handlers.disabled} submit={submit} />
        <SLinkAction tone="muted" data-account-add-cancel onClick={() => setDraft(null)}>{L.cancel}</SLinkAction>
      </span>
    </Row>
  );
}
