// Adding and removing an account together with its login. A new account is registered pending and
// its first login starts at once; only a login that lands keeps it — a failed, cancelled or expired
// one takes the entry and its directory away again. Removing signs the account out first, then
// deletes its directory and its entry.

import { createLogger } from '@core/log.js';
import type { AccountConnection } from '@core/connections-file.js';
import {
  confirmAccount, createPendingAccount, ensureClaudeAccountDir, ensurePiAccountDir, findAccount, pendingAccounts,
  piAccountAuthType, removeAccountEntry, removeClaudeAccountDir, removePiAccountDir, type AccountIssue, type AccountRef,
} from '../connections/index.js';
import type { AuthType } from './auth-status.js';
import { hasActiveFlow, type LoginFlowState } from './login-flow.js';
import { authLoginService, type AuthLoginService } from './login-service.js';
import { logoutAccount, type AuthLogoutResult, type LogoutAccountInput } from './logout.js';
import { loadPiProviders, type PiProviderInfo } from './pi-providers.js';

const log = createLogger('accounts');

const CLAUDE_PROVIDER = 'anthropic';

export interface AddAccountInput {
  backend: 'claude' | 'pi';
  label: string;
  /** PI only: the provider the account signs in to. */
  provider?: string;
  /** PI only: how the first login signs in; absent, OAuth where the provider offers it, else an
   *  API key. A Claude account always signs in with OAuth. */
  authType?: AuthType;
}

/** An account as the add and remove results name it; never a credential. */
export interface AccountSummary {
  id: string;
  backend: 'claude' | 'pi';
  provider: string;
  label: string;
}

export type AddAccountIssue = AccountIssue | 'not-supported' | 'login-failed';
export type RemoveAccountIssue = 'not-found' | 'write-failed';

export type AddAccountResult =
  | { ok: true; account: AccountSummary; flow: LoginFlowState }
  | { ok: false; errors: AddAccountIssue[] };

export type RemoveAccountResult =
  | { ok: true; account: AccountSummary; loggedOut: boolean }
  | { ok: false; errors: RemoveAccountIssue[] };

export interface AccountLifecycleDeps {
  login?: AuthLoginService;
  /** The providers PI knows: their names are no account's id, and they say how each signs in. */
  piProviders?: () => Promise<PiProviderInfo[]>;
  logout?: (input: LogoutAccountInput) => Promise<AuthLogoutResult>;
  /** After an account is gone, so state filed under it (usage, throttle) can follow. */
  onRemoved?: (account: AccountSummary) => Promise<void> | void;
}

function providerOf(backend: 'claude' | 'pi', provider: string | undefined): string {
  return backend === 'claude' ? CLAUDE_PROVIDER : provider ?? '';
}

/** Where each backend keeps an account's own directory. */
const ACCOUNT_DIRS = {
  claude: { ensure: ensureClaudeAccountDir, remove: removeClaudeAccountDir },
  pi: { ensure: ensurePiAccountDir, remove: removePiAccountDir },
} as const;

/** Delete an account's directory and entry; never throws, since it runs on a failed login. */
function discard(ref: AccountRef): void {
  try {
    ACCOUNT_DIRS[ref.backend].remove(ref.id);
    removeAccountEntry(ref);
  } catch (error) {
    log.warn(`Discarding account '${ref.id}' failed: ${(error as Error).message}`);
  }
}

/** A pending account whose login is no longer running was left by a stopped daemon. */
function discardAbandoned(backend: 'claude' | 'pi'): void {
  for (const account of pendingAccounts()) {
    if (account.backend !== backend) continue;
    const provider = account.backend === 'claude' ? CLAUDE_PROVIDER : account.provider;
    if (!hasActiveFlow({ backend, provider, connection: account.id })) discard(account);
  }
}

async function startFirstLogin(
  account: AccountSummary, authType: AuthType, login: AuthLoginService,
): Promise<LoginFlowState> {
  const ref: AccountRef = { backend: account.backend, id: account.id };
  return login.start({
    backend: account.backend, provider: account.provider, connection: account.id, authType,
    channel: null, sessionId: null,
  }, {
    onSuccess: () => confirmAccount(ref),
    onFailure: () => discard(ref),
  });
}

/** How a new account signs in: OAuth for Claude; for PI the type asked for, else OAuth where the
 *  provider offers it, else an API key. */
function firstAuthType(input: AddAccountInput, providers: PiProviderInfo[]): AuthType {
  if (input.backend === 'claude') return 'oauth';
  if (input.authType) return input.authType;
  const offered = providers.find((provider) => provider.id === input.provider?.trim())?.capabilities ?? [];
  return offered.includes('oauth') ? 'oauth' : 'api_key';
}

/** Every account needs them: no account's id may be a PI provider's name. */
function piProvidersFor(deps: AccountLifecycleDeps): Promise<PiProviderInfo[]> {
  return (deps.piProviders ?? loadPiProviders)();
}

/** A provider PI knows that cannot sign in the way asked; an unknown one is left to its login. */
function unsupportedAuth(input: AddAccountInput, providers: PiProviderInfo[]): boolean {
  if (input.backend !== 'pi') return false;
  const known = providers.find((provider) => provider.id === input.provider?.trim());
  return !!known && !known.capabilities.includes(firstAuthType(input, providers));
}

/** Register an account and start its first login. Its id is never another connection's, of either
 *  backend, nor a PI provider's name. */
export async function addAccount(input: AddAccountInput, deps: AccountLifecycleDeps = {}): Promise<AddAccountResult> {
  discardAbandoned(input.backend);
  const providers = await piProvidersFor(deps);
  if (unsupportedAuth(input, providers)) return { ok: false, errors: ['not-supported'] };
  const created = createPendingAccount(input, { reservedIds: providers.map((provider) => provider.id) });
  if (created.ok === false) return { ok: false, errors: created.errors };
  const { id, label } = created.account;
  const account: AccountSummary = { id, backend: input.backend, provider: providerOf(input.backend, input.provider), label };
  try {
    ACCOUNT_DIRS[input.backend].ensure(id);
    const flow = await startFirstLogin(account, firstAuthType(input, providers), deps.login ?? authLoginService);
    return { ok: true, account, flow };
  } catch (error) {
    log.warn(`Starting the login for account '${id}' failed: ${(error as Error).message}`);
    discard(created.account);
    return { ok: false, errors: ['login-failed'] };
  }
}

/** The credential type an account holds: Claude's is always an OAuth login. */
function heldAuthType(stored: AccountConnection): AuthType {
  return stored.backend === 'pi' ? piAccountAuthType(stored) ?? 'api_key' : 'oauth';
}

/** Sign out where a login exists; a failure is logged and the removal goes on, since the account's
 *  credential leaves with its directory either way. */
async function signOut(account: AccountSummary, authType: AuthType, deps: AccountLifecycleDeps): Promise<boolean> {
  const result = await (deps.logout ?? logoutAccount)({
    backend: account.backend, provider: account.provider, connection: account.id, authType,
  });
  if (result.ok === false && result.error.code !== 'not_manageable') {
    log.warn(`Signing out account '${account.id}' failed: ${result.error.message}`);
  }
  return result.ok;
}

export async function removeAccount(ref: AccountRef, deps: AccountLifecycleDeps = {}): Promise<RemoveAccountResult> {
  const stored = findAccount(ref);
  if (!stored) return { ok: false, errors: ['not-found'] };
  const account: AccountSummary = {
    id: stored.id, backend: stored.backend, label: stored.label,
    provider: stored.backend === 'claude' ? CLAUDE_PROVIDER : stored.provider,
  };
  const loggedOut = stored.pending ? false : await signOut(account, heldAuthType(stored), deps);
  try {
    ACCOUNT_DIRS[ref.backend].remove(ref.id);
    removeAccountEntry(ref);
  } catch (error) {
    log.warn(`Removing account '${ref.id}' failed: ${(error as Error).message}`);
    return { ok: false, errors: ['write-failed'] };
  }
  await deps.onRemoved?.(account);
  return { ok: true, account, loggedOut };
}
