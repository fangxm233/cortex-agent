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
  /** A named account; absent or null is the provider's default login. */
  connection?: string | null;
  /** Register a new account under this name, then sign it in. */
  newAccount?: string;
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

/** An account added beside a provider's default login: a second subscription, a second key. */
export interface NamedAccountVm {
  connection: string;
  label: string;
  /** Email and plan, where the vendor records them. */
  identity: string | null;
  // No in-use flag: the server's marks the provider in use, not this account.
  connected: boolean;
  health: CredentialHealth;
  expiresAt: string | null;
  /** What logging in again uses: the current type, else the provider's first. */
  loginType: AuthType;
  canLogout: boolean;
}

export interface ClaudeAccountVm {
  provider: string;
  label: string;
  /** In use and actually connected — a logged-out account is never shown as in use. */
  inUse: boolean;
  slots: ClaudeSlotVm[];
  /** Who the default subscription login belongs to. */
  identity: string | null;
  accounts: NamedAccountVm[];
  /** Login types a new account can use. */
  addTypes: AuthType[];
}

export interface ConnectedProviderVm {
  provider: string;
  label: string;
  /** Whether the default login holds a credential; a provider with only named accounts has none. */
  connected: boolean;
  inUse: boolean;
  /** The credential type the provider currently resolves to. */
  authType: AuthType | null;
  health: CredentialHealth;
  expiresAt: string | null;
  external: ExternalSource | null;
  loginTypes: AuthType[];
  logoutTypes: AuthType[];
  accounts: NamedAccountVm[];
  addTypes: AuthType[];
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

function identityText(account: AuthAccountStatus): string | null {
  const { email, plan } = account.identity ?? {};
  return [email, plan].filter(Boolean).join(' · ') || null;
}

function isConnected(account: AuthAccountStatus): boolean {
  return account.credentials.length > 0 || (account.state !== 'logged-out' && account.source !== null);
}

function namedAccountVm(account: AuthAccountStatus): NamedAccountVm {
  const active = activeCredential(account);
  const connected = isConnected(account);
  return {
    connection: account.connection ?? '',
    label: account.label,
    identity: identityText(account),
    connected,
    health: connected ? HEALTH[account.state] : 'unknown',
    expiresAt: account.expiresAt ?? active?.expiresAt ?? null,
    loginType: account.authType ?? active?.authType ?? account.capabilities[0] ?? 'oauth',
    canLogout: account.credentials.some(item => item.manageable),
  };
}

/** Named accounts of one provider, in registry order. */
function accountsOf(rows: AuthAccountStatus[], provider: string): NamedAccountVm[] {
  return rows.filter(row => !!row.connection && row.provider === provider).map(namedAccountVm);
}

function claudeVm(rows: AuthAccountStatus[]): ClaudeAccountVm | null {
  const account = rows.find(row => !row.connection);
  if (!account) return null;
  const slots = CLAUDE_SLOT_ORDER.map(authType => claudeSlot(account, authType));
  return {
    provider: account.provider,
    label: CLAUDE_CODE_LABEL,
    inUse: account.inUse && slots.some(slot => slot.connected),
    slots,
    identity: slots[0].connected ? identityText(account) : null,
    accounts: accountsOf(rows, account.provider),
    addTypes: ['oauth'],
  };
}

function connectedVm(account: AuthAccountStatus, accounts: NamedAccountVm[]): ConnectedProviderVm {
  const active = activeCredential(account);
  return {
    provider: account.provider,
    label: account.label,
    connected: isConnected(account),
    inUse: account.inUse,
    authType: account.authType ?? active?.authType ?? null,
    health: HEALTH[account.state],
    expiresAt: account.expiresAt ?? active?.expiresAt ?? null,
    external: active ? credentialExternal(active) : externalSource(account.source),
    loginTypes: [...account.capabilities],
    logoutTypes: logoutTypes(account.credentials),
    accounts,
    addTypes: [...account.capabilities],
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
  const piRows = snapshot.accounts.filter(account => account.backend === 'pi');
  const pi = piRows.filter(account => !account.connection)
    .map(account => ({ account, named: accountsOf(piRows, account.provider) }));
  const shown = pi.filter(({ account, named }) => isConnected(account) || named.length > 0);
  const loginable = pi.filter(entry => !shown.includes(entry) && entry.account.capabilities.length > 0)
    .map(({ account }) => account);
  return {
    claude: claudeVm(snapshot.accounts.filter(account => account.backend === 'claude')),
    connected: shown.map(({ account, named }) => connectedVm(account, named)).sort(connectedOrder),
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
