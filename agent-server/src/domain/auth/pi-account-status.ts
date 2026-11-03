// One status row per PI account: what the account's own auth.json holds for its provider. Unlike
// the provider's default row, nothing ambient counts — an environment or runtime key is the
// default login's, never an account's.

import { chatgptIdentity } from '@core/codex-token.js';
import type { PiAccountConnection } from '@core/connections-file.js';
import { piAccountAuthPath } from '../connections/pi-account-dir.js';
import type { AuthAccountIdentity, AuthAccountStatus, AuthCredentialStatus, AuthType } from './auth-status.js';
import type { PiCredential, PiProvider } from './pi-runtime.js';

export interface PiAccountRowDeps {
  /** The providers PI knows, for each account's capabilities. */
  providers: readonly PiProvider[];
  readStored: (providerId: string, authPath?: string) => PiCredential | undefined;
  credentialStatus: (credential: PiCredential) => AuthCredentialStatus;
  capabilities: (provider: PiProvider) => AuthType[];
  /** Whether a model on this provider is in use, by a favorite or the default. */
  inUse: (provider: string) => boolean;
  accountsDir?: string;
}

/** Known only for a ChatGPT sign-in, whose token names its email and plan. */
function identityOf(credential: PiCredential | undefined): AuthAccountIdentity | null {
  if (credential?.type !== 'oauth' || typeof credential.access !== 'string') return null;
  const { email, plan } = chatgptIdentity(credential.access);
  return email || plan ? { email, organization: null, plan } : null;
}

function storedCredential(account: PiAccountConnection, deps: PiAccountRowDeps): PiCredential | undefined {
  try {
    return deps.readStored(account.provider, piAccountAuthPath(account.id, { accountsDir: deps.accountsDir }));
  } catch {
    return undefined;
  }
}

function piAccountRow(account: PiAccountConnection, deps: PiAccountRowDeps): AuthAccountStatus {
  const provider = deps.providers.find((candidate) => candidate.id === account.provider);
  const credential = storedCredential(account, deps);
  const status = credential ? deps.credentialStatus(credential) : null;
  return {
    backend: 'pi', provider: account.provider, connection: account.id, isDefault: false,
    label: account.label, identity: identityOf(credential),
    capabilities: provider ? deps.capabilities(provider) : [],
    authType: status?.authType ?? null, state: status?.state ?? 'logged-out', source: status?.source ?? null,
    expiresAt: status?.expiresAt ?? null, refreshExpiresAt: null,
    inUse: !!status && deps.inUse(account.provider), credentials: status ? [status] : [],
  };
}

export function piAccountRows(accounts: readonly PiAccountConnection[], deps: PiAccountRowDeps): AuthAccountStatus[] {
  return accounts.map((account) => piAccountRow(account, deps));
}
