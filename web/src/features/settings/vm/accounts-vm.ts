import type {
  AuthAccountState,
  AuthAccountStatus,
  AuthCredentialStatus,
  AuthStatusSnapshot,
  AuthType,
} from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

export type AccountStatusKind = 'logged-in' | 'expiring' | 'logged-out' | 'invalid';
export type AccountStatusTone = 'done' | 'waiting' | 'cancelled' | 'failed';
export type AccountStatusLabelKey =
  | 'accountsStatusLoggedIn'
  | 'accountsStatusExpiring'
  | 'accountsStatusLoggedOut'
  | 'accountsStatusInvalid';

export interface AccountStatusVm {
  kind: AccountStatusKind;
  tone: AccountStatusTone;
  labelKey: AccountStatusLabelKey;
}

export interface AccountCredentialVm extends AccountStatusVm {
  source: string | null;
  expiresAt: string | null;
}

export interface AccountActionTarget {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
}

/** Vocab key naming an auth type; Claude's OAuth login is its subscription. */
export function authTypeLabelKey(authType: AuthType, backend: 'claude' | 'pi'): keyof Vocab {
  if (authType === 'api_key') return 'authLoginApiKey';
  return backend === 'claude' ? 'authLoginSubscription' : 'authLoginOAuth';
}

export interface ClaudeCredentialSlotVm {
  authType: AuthType;
  credentials: AccountCredentialVm[];
  canLogin: boolean;
  canLogout: boolean;
}

export interface ClaudeAccountVm {
  provider: string;
  inUse: boolean;
  slots: ClaudeCredentialSlotVm[];
}

export interface PiProviderVm {
  provider: string;
  label: string;
  inUse: boolean;
  loginTypes: AuthType[];
  logoutTypes: AuthType[];
  status: AccountStatusVm;
  source: string | null;
  expiresAt: string | null;
}

export type AccountGroupKey = 'in-use' | 'logged-in' | 'other';
export type AccountGroupLabelKey =
  | 'accountsGroupInUse'
  | 'accountsGroupLoggedIn'
  | 'accountsGroupOther';

export interface AccountProviderGroupVm {
  key: AccountGroupKey;
  labelKey: AccountGroupLabelKey;
  providers: PiProviderVm[];
}

export interface MAccountsVm {
  claude: ClaudeAccountVm | null;
  piProviders: PiProviderVm[];
  groups: AccountProviderGroupVm[];
}

const STATUS: Record<AuthAccountState, AccountStatusVm> = {
  'logged-in': { kind: 'logged-in', tone: 'done', labelKey: 'accountsStatusLoggedIn' },
  expiring: { kind: 'expiring', tone: 'waiting', labelKey: 'accountsStatusExpiring' },
  'logged-out': { kind: 'logged-out', tone: 'cancelled', labelKey: 'accountsStatusLoggedOut' },
  expired: { kind: 'invalid', tone: 'failed', labelKey: 'accountsStatusInvalid' },
  unknown: { kind: 'invalid', tone: 'failed', labelKey: 'accountsStatusInvalid' },
};

const CLAUDE_SLOT_ORDER: AuthType[] = ['oauth', 'api_key'];

function credentialVm(credential: AuthCredentialStatus): AccountCredentialVm {
  return {
    ...STATUS[credential.state],
    source: credential.source,
    expiresAt: credential.expiresAt,
  };
}

function emptyCredential(): AccountCredentialVm {
  return {
    ...STATUS['logged-out'],
    source: null,
    expiresAt: null,
  };
}

function claudeSlot(account: AuthAccountStatus, authType: AuthType): ClaudeCredentialSlotVm {
  const source = account.credentials.filter(item => item.authType === authType);
  return {
    authType,
    credentials: source.length > 0 ? source.map(credentialVm) : [emptyCredential()],
    canLogin: account.capabilities.includes(authType),
    canLogout: source.some(item => item.manageable),
  };
}

function claudeVm(account: AuthAccountStatus | undefined): ClaudeAccountVm | null {
  if (!account) return null;
  return {
    provider: account.provider,
    inUse: account.inUse,
    slots: CLAUDE_SLOT_ORDER.map(authType => claudeSlot(account, authType)),
  };
}

function logoutCredential(
  account: AuthAccountStatus,
  authType: AuthType,
): AuthCredentialStatus | undefined {
  const matching = account.credentials.filter(item => item.authType === authType);
  if (account.authType !== authType) return matching[0];
  return matching.find(item => item.source === account.source) ?? matching[0];
}

function manageableTypes(account: AuthAccountStatus): AuthType[] {
  const credentialTypes = [...new Set(account.credentials.map(item => item.authType))];
  return credentialTypes.filter(authType => logoutCredential(account, authType)?.manageable);
}

function piProviderVm(account: AuthAccountStatus): PiProviderVm {
  return {
    provider: account.provider,
    label: account.label,
    inUse: account.inUse,
    loginTypes: [...account.capabilities],
    logoutTypes: manageableTypes(account),
    status: STATUS[account.state],
    source: account.source,
    expiresAt: account.expiresAt,
  };
}

function providerOrder(left: PiProviderVm, right: PiProviderVm): number {
  const useOrder = Number(right.inUse) - Number(left.inUse);
  return useOrder || left.label.localeCompare(right.label);
}

function providerGroups(providers: PiProviderVm[]): AccountProviderGroupVm[] {
  const specs: Array<[AccountGroupKey, AccountGroupLabelKey, (item: PiProviderVm) => boolean]> = [
    ['in-use', 'accountsGroupInUse', item => item.inUse],
    ['logged-in', 'accountsGroupLoggedIn', item => !item.inUse && (item.status.kind === 'logged-in' || item.status.kind === 'expiring')],
    ['other', 'accountsGroupOther', item => !item.inUse && item.status.kind !== 'logged-in' && item.status.kind !== 'expiring'],
  ];
  return specs.map(([key, labelKey, matches]) => ({
    key, labelKey, providers: providers.filter(matches),
  })).filter(group => group.providers.length > 0);
}

function matchesFilter(account: AuthAccountStatus, filter: string): boolean {
  const needle = filter.trim().toLocaleLowerCase();
  return !needle
    || account.provider.toLocaleLowerCase().includes(needle)
    || account.label.toLocaleLowerCase().includes(needle);
}

export function buildAccountsVm(snapshot: AuthStatusSnapshot, filter = ''): MAccountsVm {
  const claude = snapshot.accounts.find(account => account.backend === 'claude');
  const piProviders = snapshot.accounts.filter(account => (
    account.backend === 'pi' && matchesFilter(account, filter)
  )).map(piProviderVm).sort(providerOrder);
  return {
    claude: claudeVm(claude),
    piProviders,
    groups: providerGroups(piProviders),
  };
}
