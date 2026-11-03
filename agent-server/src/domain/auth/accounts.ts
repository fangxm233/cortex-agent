// Adding and removing an account together with its login. A new account is registered pending and
// its first login starts at once; only a login that lands keeps it — a failed, cancelled or expired
// one takes the entry and its directory away again. Removing signs the account out first, then
// deletes its directory and its entry.

import { createLogger } from '@core/log.js';
import {
  confirmAccount, createPendingAccount, ensureClaudeAccountDir, findAccount, pendingAccounts,
  removeAccountEntry, removeClaudeAccountDir, type AccountIssue, type AccountRef,
} from '../connections/index.js';
import { hasActiveFlow, type LoginFlowState } from './login-flow.js';
import { authLoginService, type AuthLoginService } from './login-service.js';
import { logoutAccount, type AuthLogoutResult, type LogoutAccountInput } from './logout.js';

const log = createLogger('accounts');

const CLAUDE_PROVIDER = 'anthropic';

export interface AddAccountInput {
  backend: 'claude' | 'pi';
  label: string;
  /** PI only: the provider the account signs in to. */
  provider?: string;
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
  logout?: (input: LogoutAccountInput) => Promise<AuthLogoutResult>;
  /** After an account is gone, so state filed under it (usage, throttle) can follow. */
  onRemoved?: (account: AccountSummary) => Promise<void> | void;
}

function providerOf(backend: 'claude' | 'pi', provider: string | undefined): string {
  return backend === 'claude' ? CLAUDE_PROVIDER : provider ?? '';
}

/** Delete an account's directory and entry; never throws, since it runs on a failed login. */
function discard(ref: AccountRef): void {
  try {
    if (ref.backend === 'claude') removeClaudeAccountDir(ref.id);
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

async function startFirstLogin(account: AccountSummary, login: AuthLoginService): Promise<LoginFlowState> {
  const ref: AccountRef = { backend: account.backend, id: account.id };
  return login.start({
    backend: account.backend, provider: account.provider, connection: account.id, authType: 'oauth',
    channel: null, sessionId: null,
  }, {
    onSuccess: () => confirmAccount(ref),
    onFailure: () => discard(ref),
  });
}

/** Register an account and start its first login. Claude only for now. */
export async function addAccount(input: AddAccountInput, deps: AccountLifecycleDeps = {}): Promise<AddAccountResult> {
  if (input.backend !== 'claude') return { ok: false, errors: ['not-supported'] };
  discardAbandoned(input.backend);
  const created = createPendingAccount(input);
  if (created.ok === false) return { ok: false, errors: created.errors };
  const { id, label } = created.account;
  const account: AccountSummary = { id, backend: input.backend, provider: providerOf(input.backend, input.provider), label };
  try {
    ensureClaudeAccountDir(id);
    return { ok: true, account, flow: await startFirstLogin(account, deps.login ?? authLoginService) };
  } catch (error) {
    log.warn(`Starting the login for account '${id}' failed: ${(error as Error).message}`);
    discard(created.account);
    return { ok: false, errors: ['login-failed'] };
  }
}

/** Sign out where a login exists; a failure is logged and the removal goes on, since the account's
 *  credential leaves with its directory either way. */
async function signOut(account: AccountSummary, deps: AccountLifecycleDeps): Promise<boolean> {
  const result = await (deps.logout ?? logoutAccount)({
    backend: account.backend, provider: account.provider, connection: account.id, authType: 'oauth',
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
  const loggedOut = stored.pending ? false : await signOut(account, deps);
  try {
    if (ref.backend === 'claude') removeClaudeAccountDir(ref.id);
    removeAccountEntry(ref);
  } catch (error) {
    log.warn(`Removing account '${ref.id}' failed: ${(error as Error).message}`);
    return { ok: false, errors: ['write-failed'] };
  }
  await deps.onRemoved?.(account);
  return { ok: true, account, loggedOut };
}
