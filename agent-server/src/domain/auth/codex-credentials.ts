import * as path from 'node:path';
import { CODEX_PROVIDER } from '@core/codex-quota.js';
import { decodeJwtPayload, findChatgptAccountId } from '@core/codex-token.js';
import { PI_AGENT_DIR } from '../../agent-adapter/pi/defaults.js';
import type { CodexCredentials } from '@domain/costs/codex-account.js';
import { loadPiRuntime, type LoadPiRuntimeOptions, type PiRuntimeLoadResult } from './pi-runtime.js';

export interface CodexCredentialDeps {
  /** auth.json the daemon's PI sessions read; token refreshes land where those sessions see them. */
  authPath?: string;
  loadRuntime?: (options: LoadPiRuntimeOptions) => Promise<PiRuntimeLoadResult>;
}

/**
 * The Codex OAuth access token and its ChatGPT account id, refreshed by the PI runtime when it is
 * near expiry. Null when Codex is not signed in, or the stored credential is not a ChatGPT-plan
 * token (an API key carries no account).
 */
export async function loadCodexCredentials(deps: CodexCredentialDeps = {}): Promise<CodexCredentials | null> {
  const loaded = await (deps.loadRuntime ?? loadPiRuntime)({
    authPath: deps.authPath ?? path.join(PI_AGENT_DIR, 'auth.json'),
  });
  if (!loaded.available) throw new Error(loaded.error);
  const { runtime } = loaded;
  if (!runtime.getProviderAuthStatus(CODEX_PROVIDER).configured || !runtime.getAuth) return null;
  const token = (await runtime.getAuth(CODEX_PROVIDER))?.auth.apiKey;
  if (!token) return null;
  const accountId = findChatgptAccountId(decodeJwtPayload(token));
  return accountId ? { token, accountId } : null;
}
