// Which named account a `!login cc <account>` / `!login pi <provider> <account>` means. Accounts are
// created in the Web UI; chat only signs an existing one in again.

import { t } from '@core/i18n.js';
import type { AuthAccountStatus, AuthStatusSnapshot } from '@domain/auth/index.js';

type Backend = 'claude' | 'pi';

function namedAccounts(snapshot: AuthStatusSnapshot, backend: Backend, provider: string): AuthAccountStatus[] {
  return snapshot.accounts.filter(account => (
    account.backend === backend && account.provider === provider && !!account.connection
  ));
}

/** The account named by its id, or else by its label, case-insensitively. */
export function findNamedAccount(
  snapshot: AuthStatusSnapshot, backend: Backend, provider: string, name: string,
): AuthAccountStatus | null {
  const accounts = namedAccounts(snapshot, backend, provider);
  const needle = name.toLocaleLowerCase();
  return accounts.find(account => account.connection === name)
    ?? accounts.find(account => account.connection?.toLocaleLowerCase() === needle
      || account.label.toLocaleLowerCase() === needle)
    ?? null;
}

export function unknownAccountText(snapshot: AuthStatusSnapshot, backend: Backend, provider: string, name: string): string {
  const ids = namedAccounts(snapshot, backend, provider).map(account => `\`${account.connection}\``);
  return t('cmd.auth.loginUnknownAccount', {
    account: name, accounts: ids.length > 0 ? ids.join(', ') : t('cmd.auth.loginNoAccounts'),
  });
}

/** How chat names a login: the provider, and the account when it is a named one. */
export function loginName(provider: string, connection?: string | null): string {
  return connection ? t('cmd.auth.loginAccountName', { provider, account: connection }) : provider;
}
