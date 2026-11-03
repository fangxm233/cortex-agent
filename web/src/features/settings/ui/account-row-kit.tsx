import { useState, type CSSProperties, type ReactNode } from 'react';
import { useLang, useVocab, type Vocab } from '@/i18n';
import {
  expiryText, type AccountActionTarget, type CredentialHealth,
} from '@/features/settings/vm/accounts-vm';
import { SLinkAction, SStatus } from './settings-ui';

// The row primitives every account listing shares: provider rows, Claude slots and named accounts.

export interface AccountRowHandlers {
  onLogin: (target: AccountActionTarget) => void;
  /** Absent where logging out is not offered (provider setup). */
  onLogout?: (target: AccountActionTarget) => void;
  /** Deletes a named account. Absent where accounts are not managed: no add or delete is offered. */
  onRemove?: (target: AccountActionTarget) => void;
  disabled?: boolean;
}

export const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 10, rowGap: 6,
  padding: '8px var(--settings-row-inset, 0px)', minHeight: 40, boxSizing: 'border-box', minWidth: 0,
};
export const LEAD_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto', minWidth: 0,
};
export const NAME_STYLE: CSSProperties = {
  fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', whiteSpace: 'nowrap', flex: 'none',
};
export const META_STYLE: CSSProperties = {
  fontSize: 12, color: 'var(--proto-muted-2)', whiteSpace: 'nowrap', overflow: 'hidden',
  textOverflow: 'ellipsis', minWidth: 0, flex: '0 1 auto',
};
export const ACTIONS_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap',
  columnGap: 12, rowGap: 4, marginLeft: 'auto', flex: 'none', maxWidth: '100%',
};

export function Row({ children, style, ...rest }: { children: ReactNode; style?: CSSProperties } & Record<string, unknown>) {
  return <div {...rest} style={{ ...ROW_STYLE, ...style }}>{children}</div>;
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

export function HealthStatus({ health, expiresAt }: { health: CredentialHealth; expiresAt: string | null }) {
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
export function quietExpiry(health: CredentialHealth, expiresAt: string | null, L: Vocab, lang: 'en' | 'zh'): string | null {
  if (health === 'expiring' || health === 'expired') return null;
  return expiryText(expiresAt, Date.now(), lang, L);
}

export type ConfirmAction = 'logout' | 'remove';

// Only a delete reads as danger; a logout's question stays in the ink.
const CONFIRM_TONES: Record<ConfirmAction, { text: string; border: string }> = {
  remove: { text: 'var(--proto-danger)', border: 'var(--proto-danger-bg)' },
  logout: { text: 'var(--proto-ink)', border: 'var(--proto-line-3)' },
};

function confirmKey(target: AccountActionTarget, action: ConfirmAction): string {
  return [action, target.backend, target.provider, target.connection ?? '', target.authType].join(':');
}

/** Which logout or delete is armed for confirmation; one at a time across the list. */
export function useLogoutConfirm() {
  const [armed, setArmed] = useState<string | null>(null);
  return {
    isArmed: (target: AccountActionTarget, action: ConfirmAction = 'logout') => armed === confirmKey(target, action),
    arm: (target: AccountActionTarget, action: ConfirmAction = 'logout') => setArmed(confirmKey(target, action)),
    disarm: () => setArmed(null),
  };
}

export type LogoutConfirm = ReturnType<typeof useLogoutConfirm>;

/** The armed question in place of a row's actions: what the action does, then do it or cancel. */
export function ConfirmStrip({ action, target, message, confirmLabel, disabled, onConfirm, onCancel }: {
  action: ConfirmAction; target: AccountActionTarget; message: string; confirmLabel: string;
  disabled?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const L = useVocab();
  const tone = CONFIRM_TONES[action];
  return (
    <span data-logout-confirm role="group" style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0, marginLeft: 'auto' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: tone.text, overflowWrap: 'anywhere' }}>{message}</span>
      {/* The two answers wrap as one unit, never apart. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flex: 'none', marginLeft: 'auto' }}>
        <button type="button" {...targetAttrs(`${action}-confirm`, target)} disabled={disabled} onClick={onConfirm}
          style={{
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 7,
            border: `1px solid ${tone.border}`, color: tone.text,
            background: 'var(--material-control-bg)', cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
          {confirmLabel}
        </button>
        <SLinkAction tone="muted" data-auth-action={`${action}-cancel`} onClick={onCancel}>{L.cancel}</SLinkAction>
      </span>
    </span>
  );
}

/** Data attributes naming a row action's target, for tests and automation. */
export function targetAttrs(action: string, target: AccountActionTarget): Record<string, unknown> {
  return {
    'data-auth-action': action, 'data-backend': target.backend, 'data-provider': target.provider,
    'data-auth-type': target.authType, ...(target.connection ? { 'data-connection': target.connection } : {}),
  };
}
