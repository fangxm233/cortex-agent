import * as path from 'node:path';
import { mutateFileAtomically } from '@core/atomic-write.js';
import { CONFIG_DIR } from '@core/paths.js';
import { claudeSubscriptionLogin, credentialValue } from '@core/claude-credentials.js';
import {
  claudeKeyConnections, readConnections, removeConnection, upsertConnection, type ClaudeKeyConnection,
} from '@core/connections-file.js';

const ENV_FILE = path.join(CONFIG_DIR, '.env');

/** The connection the Accounts surfaces call "the Anthropic API key". */
export const API_KEY_CONNECTION = 'api';

function apiKeyConnection(): ClaudeKeyConnection | null {
  return claudeKeyConnections(readConnections()).find((entry) => entry.id === API_KEY_CONNECTION) ?? null;
}

/** The secrets behind the Accounts surfaces' Claude slots — the `api` connection's key and a
 *  legacy OAuth token — so a failure removing one can be reported with both masked. */
export function savedClaudeSecrets(): string[] {
  return [apiKeyConnection()?.key, claudeSubscriptionLogin()?.token]
    .filter((value): value is string => !!value);
}

function requireAnthropicApiKey(value: string): string {
  const key = credentialValue(value);
  if (!key || /[\s"\\]/.test(key)) throw new Error('Enter a valid Anthropic API key.');
  return key;
}

function savedEnvMatcher(name: string, flags: string): RegExp {
  return new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, flags);
}

function removeSavedEnv(contents: string, name: string): string {
  const line = savedEnvMatcher(name, 'gm');
  return contents.replace(new RegExp(`${line.source}(?:\\r?\\n|$)`, 'gm'), '');
}

async function removeCredentials(names: string[]): Promise<void> {
  await mutateFileAtomically(
    ENV_FILE,
    contents => names.reduce(removeSavedEnv, contents),
    { mode: 0o600 },
  );
}

/** Save the key on the `api` connection. An existing connection keeps its endpoint and auth style;
 *  a new one targets the official Anthropic API. */
export async function saveAnthropicApiKey(value: string): Promise<void> {
  const key = requireAnthropicApiKey(value);
  const existing = apiKeyConnection();
  upsertConnection(existing ? { ...existing, key } : {
    id: API_KEY_CONNECTION, backend: 'claude', label: API_KEY_CONNECTION,
    authStyle: 'x-api-key', key, billing: 'metered',
  });
}

/** Remove the `api` connection, and any key a pre-connections install left in CONFIG_DIR/.env. */
export async function removeAnthropicApiKey(): Promise<void> {
  removeConnection({ backend: 'claude', id: API_KEY_CONNECTION });
  await removeCredentials(['ANTHROPIC_API_KEY']);
}

export async function removeClaudeCodeOAuthToken(): Promise<void> {
  await removeCredentials([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT',
  ]);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT;
}

/** Endpoint and key variables a Claude route decides per spawn. */
const ROUTE_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const;

/**
 * The daemon's own environment carries no routing credential: every Claude spawn gets its endpoint
 * and key from its connection, so a value loaded from CONFIG_DIR/.env or inherited from the shell
 * would only leak into processes that never asked for it. A legacy OAuth token stays only while
 * Claude's own store holds nothing — then it is the subscription credential (see
 * claudeSubscriptionLogin); once Claude's store has a login, the static copy would shadow it.
 *
 * Called once at startup, after migrations have moved any key they found into a connection.
 */
export function dropRoutingEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ROUTE_ENV_VARS) delete env[name];
  if (claudeSubscriptionLogin()?.source !== 'claude-store') return;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT;
}
