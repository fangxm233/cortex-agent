// Each additional PI account runs PI on an agent dir of its own, whose auth.json holds that
// account's credential. The adapter writes the same provider catalog there as into Cortex's own
// agent dir, so an account differs from the default login only in the credential it signs in with.

import fs from 'node:fs';
import path from 'node:path';
import { CONNECTIONS_FILE, type PiAccountConnection } from '@core/connections-file.js';
import { PI_ACCOUNTS_HOME } from '@core/paths.js';
import { ensureQuotaVisibleTransport } from '../../agent-adapter/pi/agent-dir.js';
import { storedAuthType } from '../../agent-adapter/pi/chatgpt-signin.js';
import { piAccountDir, piAuthPath } from '../../agent-adapter/pi/defaults.js';
import { findAccount } from './accounts.js';

export interface PiAccountDirDeps {
  /** Where account dirs live. */
  accountsDir?: string;
}

/** The account's agent dir, created on first use with the transport its quota readings need. */
export function ensurePiAccountDir(id: string, deps: PiAccountDirDeps = {}): string {
  const dir = piAccountDir(id, deps.accountsDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensureQuotaVisibleTransport({ agentDir: dir });
  return dir;
}

export function removePiAccountDir(id: string, deps: PiAccountDirDeps = {}): void {
  fs.rmSync(piAccountDir(id, deps.accountsDir), { recursive: true, force: true });
}

/** The auth.json an account signs in to. */
export function piAccountAuthPath(id: string, deps: PiAccountDirDeps = {}): string {
  return piAuthPath(piAccountDir(id, deps.accountsDir));
}

/** The type of the credential the account holds for its provider; null while it is signed out. */
export function piAccountAuthType(
  account: Pick<PiAccountConnection, 'id' | 'provider'>,
  deps: PiAccountDirDeps = {},
): 'api_key' | 'oauth' | null {
  return storedAuthType(piAccountAuthPath(account.id, deps), account.provider);
}

/** The stored PI account an agent dir belongs to; null for any other dir. */
export function piAccountOfDir(
  agentDir: string,
  deps: PiAccountDirDeps & { file?: string } = {},
): PiAccountConnection | null {
  const resolved = path.resolve(agentDir);
  if (path.dirname(resolved) !== path.resolve(deps.accountsDir ?? PI_ACCOUNTS_HOME)) return null;
  const account = findAccount({ backend: 'pi', id: path.basename(resolved) }, deps.file ?? CONNECTIONS_FILE);
  return account?.backend === 'pi' ? account : null;
}
