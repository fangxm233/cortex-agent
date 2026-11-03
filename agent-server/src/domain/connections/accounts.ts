// Accounts in the connections file: the label the user typed, an id derived from it, and a pending
// flag while the first login runs. Signing an account in and out lives with auth
// (domain/auth/accounts.ts); this module only keeps the registry.

import {
  CONNECTIONS_FILE, SUBSCRIPTION_CONNECTION, isAccountConnection, readConnections, removeConnection,
  upsertConnection, type AccountConnection,
} from '@core/connections-file.js';
import { API_KEY_CONNECTION } from '../auth/anthropic-env.js';

export interface AccountInput {
  backend: 'claude' | 'pi';
  label: string;
  /** PI only: the provider the account signs in to. */
  provider?: string;
}

export interface AccountRef {
  backend: 'claude' | 'pi';
  id: string;
}

export type AccountIssue = 'label-required' | 'provider-required' | 'write-failed';

export type AccountCreate =
  | { ok: true; account: AccountConnection }
  | { ok: false; errors: AccountIssue[] };

export interface AccountRegistryDeps {
  file?: string;
  /** Ids no account may take beyond the file's own: PI's provider names. */
  reservedIds?: Iterable<string>;
}

const MAX_ID_LENGTH = 32;
const RESERVED_CLAUDE_IDS = [SUBSCRIPTION_CONNECTION, API_KEY_CONNECTION];

/** A slug of the label, suffixed `-2`, `-3`… until it is free. A label with nothing to slug
 *  (say, all CJK) becomes `account`. */
export function accountId(label: string, taken: ReadonlySet<string>): string {
  const slug = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '').slice(0, MAX_ID_LENGTH).replace(/-+$/, '');
  const base = slug || 'account';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** Ids are unique across backends: a Claude account and a PI account of `anthropic` sharing one
 *  would share a route, and with it a throttle and a usage row. So no stored connection's id of
 *  either backend, no name Claude's default logins go by, and no PI provider's name (a provider's
 *  default login is named by it). */
function takenIds(input: AccountInput, deps: AccountRegistryDeps): Set<string> {
  const stored = readConnections(deps.file ?? CONNECTIONS_FILE).map((entry) => entry.id);
  const reserved = [...RESERVED_CLAUDE_IDS, input.provider?.trim() ?? '', ...(deps.reservedIds ?? [])];
  return new Set([...stored, ...reserved].filter(Boolean));
}

function accountIssues(input: AccountInput): AccountIssue[] {
  const issues: AccountIssue[] = [];
  if (!input.label.trim()) issues.push('label-required');
  if (input.backend === 'pi' && !input.provider?.trim()) issues.push('provider-required');
  return issues;
}

function pendingAccount(input: AccountInput, id: string): AccountConnection {
  const label = input.label.trim();
  return input.backend === 'claude'
    ? { id, backend: 'claude', type: 'account', label, pending: true }
    : { id, backend: 'pi', type: 'account', label, provider: input.provider!.trim(), pending: true };
}

/** Register a new account, pending until its first login lands. */
export function createPendingAccount(input: AccountInput, deps: AccountRegistryDeps = {}): AccountCreate {
  const issues = accountIssues(input);
  if (issues.length > 0) return { ok: false, errors: issues };
  const account = pendingAccount(input, accountId(input.label.trim(), takenIds(input, deps)));
  try {
    upsertConnection(account, deps.file ?? CONNECTIONS_FILE);
  } catch {
    return { ok: false, errors: ['write-failed'] };
  }
  return { ok: true, account };
}

/** The stored account, pending or not. */
export function findAccount(ref: AccountRef, file: string = CONNECTIONS_FILE): AccountConnection | null {
  const found = readConnections(file).find((entry) => entry.backend === ref.backend && entry.id === ref.id);
  return found && isAccountConnection(found) ? found : null;
}

/** The first login landed: the account is no longer pending. */
export function confirmAccount(ref: AccountRef, file: string = CONNECTIONS_FILE): void {
  const account = findAccount(ref, file);
  if (!account?.pending) return;
  const { pending: _pending, ...confirmed } = account;
  upsertConnection(confirmed, file);
}

export function removeAccountEntry(ref: AccountRef, file: string = CONNECTIONS_FILE): boolean {
  return findAccount(ref, file) ? removeConnection(ref, file) : false;
}

/** Accounts whose first login never finished, e.g. the daemon stopped mid-login. */
export function pendingAccounts(file: string = CONNECTIONS_FILE): AccountConnection[] {
  return readConnections(file).filter((entry): entry is AccountConnection => isAccountConnection(entry) && !!entry.pending);
}
