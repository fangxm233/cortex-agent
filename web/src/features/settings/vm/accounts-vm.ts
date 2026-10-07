import type {
  AuthAccountState,
  AuthAccountStatus,
  AuthCredentialStatus,
  AuthStatusSnapshot,
  AuthType,
} from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';
import { timeUntil, type TimeLang } from '@/i18n/time-format';

export interface AccountActionTarget {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
  /** Display label, carried so the login dialog and toasts never fall back to the id. */
  label?: string;
}

/** Vocab key naming an auth type; Claude's OAuth login is its subscription. */
export function authTypeLabelKey(authType: AuthType, backend: 'claude' | 'pi'): keyof Vocab {
  if (authType === 'api_key') return 'authLoginApiKey';
  return backend === 'claude' ? 'authLoginSubscription' : 'authLoginOAuth';
}

export type CredentialHealth = 'ok' | 'expiring' | 'expired' | 'unknown';

/** Where a credential Cortex cannot remove lives. Cortex-saved credentials have no source shown. */
export type ExternalSource = 'environment' | 'models_json' | 'runtime';

export interface ClaudeSlotVm {
  authType: AuthType;
  connected: boolean;
  inUse: boolean;
  health: CredentialHealth;
  expiresAt: string | null;
  external: ExternalSource | null;
  canLogin: boolean;
  canLogout: boolean;
}

export interface ClaudeAccountVm {
  provider: string;
  label: string;
  /** In use and actually connected — a logged-out account is never shown as in use. */
  inUse: boolean;
  slots: ClaudeSlotVm[];
}

export interface ConnectedProviderVm {
  provider: string;
  label: string;
  inUse: boolean;
  /** The credential type the provider currently resolves to. */
  authType: AuthType | null;
  health: CredentialHealth;
  expiresAt: string | null;
  external: ExternalSource | null;
  loginTypes: AuthType[];
  logoutTypes: AuthType[];
}

export interface AvailableProviderVm {
  provider: string;
  label: string;
  loginTypes: AuthType[];
}

export interface AccountsVm {
  claude: ClaudeAccountVm | null;
  connected: ConnectedProviderVm[];
  /** Providers without credentials, filtered by the search text. */
  available: AvailableProviderVm[];
  /** Providers without credentials before filtering. */
  availableTotal: number;
}

export const CLAUDE_CODE_LABEL = 'Claude Code';

const HEALTH: Record<AuthAccountState, CredentialHealth> = {
  'logged-in': 'ok',
  expiring: 'expiring',
  expired: 'expired',
  unknown: 'unknown',
  'logged-out': 'unknown',
};

const CLAUDE_SLOT_ORDER: AuthType[] = ['oauth', 'api_key'];

export function externalSource(source: string | null): ExternalSource | null {
  switch (source) {
    case 'environment': return 'environment';
    case 'models_json_key':
    case 'models_json_command': return 'models_json';
    case 'runtime':
    case 'fallback': return 'runtime';
    default: return null;
  }
}

function credentialExternal(credential: AuthCredentialStatus | undefined): ExternalSource | null {
  if (!credential || credential.manageable) return null;
  return externalSource(credential.source) ?? 'runtime';
}

/** A type can be logged out when any credential of that type is one Cortex manages. */
function logoutTypes(credentials: AuthCredentialStatus[]): AuthType[] {
  return [...new Set(credentials.filter(item => item.manageable).map(item => item.authType))];
}

function activeCredential(account: AuthAccountStatus): AuthCredentialStatus | undefined {
  const matching = account.credentials.filter(item => item.authType === account.authType);
  return matching.find(item => item.source === account.source) ?? matching[0] ?? account.credentials[0];
}

function claudeSlot(account: AuthAccountStatus, authType: AuthType): ClaudeSlotVm {
  const credentials = account.credentials.filter(item => item.authType === authType);
  const current = credentials.find(item => item.source === account.source) ?? credentials[0];
  return {
    authType,
    connected: !!current,
    inUse: account.inUse && account.authType === authType && !!current,
    health: current ? HEALTH[current.state] : 'unknown',
    expiresAt: current?.expiresAt ?? null,
    external: credentialExternal(current),
    canLogin: account.capabilities.includes(authType),
    canLogout: credentials.some(item => item.manageable),
  };
}

function claudeVm(account: AuthAccountStatus | undefined): ClaudeAccountVm | null {
  if (!account) return null;
  const slots = CLAUDE_SLOT_ORDER.map(authType => claudeSlot(account, authType));
  return {
    provider: account.provider,
    label: CLAUDE_CODE_LABEL,
    inUse: account.inUse && slots.some(slot => slot.connected),
    slots,
  };
}

function isConnected(account: AuthAccountStatus): boolean {
  return account.credentials.length > 0 || (account.state !== 'logged-out' && account.source !== null);
}

function connectedVm(account: AuthAccountStatus): ConnectedProviderVm {
  const active = activeCredential(account);
  return {
    provider: account.provider,
    label: account.label,
    inUse: account.inUse,
    authType: account.authType ?? active?.authType ?? null,
    health: HEALTH[account.state],
    expiresAt: account.expiresAt ?? active?.expiresAt ?? null,
    external: active ? credentialExternal(active) : externalSource(account.source),
    loginTypes: [...account.capabilities],
    logoutTypes: logoutTypes(account.credentials),
  };
}

function matchesFilter(account: AuthAccountStatus, filter: string): boolean {
  const needle = filter.trim().toLocaleLowerCase();
  return !needle
    || account.label.toLocaleLowerCase().includes(needle)
    || account.provider.toLocaleLowerCase().includes(needle);
}

function byLabel(left: { label: string }, right: { label: string }): number {
  return left.label.localeCompare(right.label);
}

function connectedOrder(left: ConnectedProviderVm, right: ConnectedProviderVm): number {
  return Number(right.inUse) - Number(left.inUse) || byLabel(left, right);
}

export function buildAccountsVm(snapshot: AuthStatusSnapshot, filter = ''): AccountsVm {
  const pi = snapshot.accounts.filter(account => account.backend === 'pi');
  const loginable = pi.filter(account => !isConnected(account) && account.capabilities.length > 0);
  return {
    claude: claudeVm(snapshot.accounts.find(account => account.backend === 'claude')),
    connected: pi.filter(isConnected).map(connectedVm).sort(connectedOrder),
    available: loginable.filter(account => matchesFilter(account, filter))
      .map(account => ({ provider: account.provider, label: account.label, loginTypes: [...account.capabilities] }))
      .sort(byLabel),
    availableTotal: loginable.length,
  };
}

// ── Copy helpers shared by the desktop, mobile and onboarding renderings ──────────────────────

const SOURCE_KEY: Record<ExternalSource, keyof Vocab> = {
  environment: 'accountsSourceEnv',
  models_json: 'accountsSourceModelsJson',
  runtime: 'accountsSourceRuntime',
};

export function externalSourceText(source: ExternalSource, L: Vocab): string {
  return L[SOURCE_KEY[source]] as string;
}

const SOON_MS = 14 * 24 * 60 * 60 * 1000;

/** `expires in 3d` near the date, `expires Dec 10` further out; never a raw timestamp. */
export function expiryText(expiresAt: string | null, now: number, lang: TimeLang, L: Vocab): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  if (at <= now) return L.accountsExpired;
  if (at - now < SOON_MS) return fmt(L.accountsExpiresWhen, { when: timeUntil(at, now, lang) });
  const date = new Date(at);
  const monthDay = fmt(L.timeMonthDay, { month: L.timeMonths.split(',')[date.getMonth()] ?? '', day: date.getDate() });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return fmt(L.accountsExpiresOn, { date: sameYear ? monthDay : `${monthDay} ${date.getFullYear()}` });
}

/** Meta line after the name: auth type, where an external credential comes from, and expiry. */
export function connectedMeta(
  provider: Pick<ConnectedProviderVm, 'authType' | 'external' | 'inUse'>,
  backend: 'claude' | 'pi',
  L: Vocab,
): string {
  const parts: string[] = [];
  if (provider.authType) parts.push(L[authTypeLabelKey(provider.authType, backend)] as string);
  if (provider.external) parts.push(externalSourceText(provider.external, L));
  if (provider.inUse) parts.push(L.accountsInUse);
  return parts.join(' · ');
}

export function reloginLabel(authType: AuthType, L: Vocab): string {
  return authType === 'api_key' ? L.accountsReplaceKey : L.accountsRelogin;
}
