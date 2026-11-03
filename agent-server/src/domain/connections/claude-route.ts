// Where one Claude Code spawn sends its requests and with which credential, decided from the
// selection's connection alone. The result is applied to that child's environment only; the
// daemon's own environment carries no routing credential.

import { claudeSubscriptionLogin, type ClaudeCredentialDeps } from '@core/claude-credentials.js';
import {
  CONNECTIONS_FILE, SUBSCRIPTION_CONNECTION, claudeKeyConnections, readConnections, type ClaudeKeyConnection,
} from '@core/connections-file.js';
import { findAccount } from './accounts.js';
import { ensureClaudeAccountDir, type ClaudeAccountDirDeps } from './claude-account-dir.js';
import { createCredentialInventory } from './inventory.js';

/** Every credential variable a route decides; whichever one it does not set, it deletes. */
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
type CredentialVar = typeof CREDENTIAL_VARS[number];

export interface ClaudeRoute {
  /** The connection the route was resolved for. Never null: a selection naming none gets the default. */
  connection: string;
  /** ANTHROPIC_BASE_URL; absent means the official endpoint (the variable is deleted). */
  baseUrl?: string;
  /** Credential variables to set. Values are secrets: never log them. */
  sets: Partial<Record<CredentialVar, string>>;
  /** Credential variables to delete, so nothing inherited can shadow the route. */
  unsets: CredentialVar[];
  /** CLAUDE_CONFIG_DIR for an account route: the account's own dir. Absent: Cortex's own. */
  configDir?: string;
}

export interface ClaudeRouteDeps {
  file?: string;
  claude?: ClaudeCredentialDeps;
  accountDir?: ClaudeAccountDirDeps;
}

function withUnsets(route: Omit<ClaudeRoute, 'unsets'>): ClaudeRoute {
  const unsets = CREDENTIAL_VARS.filter((name) => route.sets[name] === undefined);
  return { ...route, unsets };
}

/** Claude Code's own login. A static legacy token is carried only when Claude's store holds
 *  nothing; otherwise the child authenticates from the store, which it refreshes itself. */
function subscriptionRoute(deps: ClaudeCredentialDeps): ClaudeRoute {
  const token = claudeSubscriptionLogin(deps)?.token;
  return withUnsets({
    connection: SUBSCRIPTION_CONNECTION,
    sets: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {},
  });
}

function keyRoute(connection: ClaudeKeyConnection): ClaudeRoute {
  const variable: CredentialVar = connection.authStyle === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  return withUnsets({
    connection: connection.id,
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    sets: { [variable]: connection.key },
  });
}

/** An account signs in from its own config dir, so no credential variable may reach the child. */
function accountRoute(id: string, deps: ClaudeRouteDeps): ClaudeRoute {
  return withUnsets({ connection: id, sets: {}, configDir: ensureClaudeAccountDir(id, deps.accountDir) });
}

function storedClaudeConnection(id: string, file: string): ClaudeKeyConnection | null {
  return claudeKeyConnections(readConnections(file)).find((entry) => entry.id === id) ?? null;
}

/**
 * The route for a Claude selection's connection. `null` runs on the default connection; a host
 * with no Claude connection at all still gets the subscription route, so the child reports the
 * missing login itself. A named connection that does not exist is an error — never a silent fall
 * back onto another account.
 */
export function resolveClaudeRoute(connection: string | null, deps: ClaudeRouteDeps = {}): ClaudeRoute {
  const file = deps.file ?? CONNECTIONS_FILE;
  const claudeDeps = deps.claude ?? {};
  const id = connection
    ?? createCredentialInventory({ file, claude: claudeDeps, claudeAccountsDir: deps.accountDir?.accountsDir })
      .defaultClaudeConnection()
    ?? SUBSCRIPTION_CONNECTION;
  if (id === SUBSCRIPTION_CONNECTION) return subscriptionRoute(claudeDeps);
  const stored = storedClaudeConnection(id, file);
  if (stored) return keyRoute(stored);
  if (findAccount({ backend: 'claude', id }, file)) return accountRoute(id, deps);
  throw new Error(`Claude connection '${id}' is not configured`);
}
