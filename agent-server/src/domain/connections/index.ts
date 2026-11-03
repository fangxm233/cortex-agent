import { SUBSCRIPTION_CONNECTION } from '@core/connections-file.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { claudeRunConnection, type SelectionContext } from '../agents/resolve-selection.js';

export {
  createCredentialInventory, credentialInventory,
  type ConnectionKind, type ConnectionView, type CredentialInventory, type InventoryDeps, type SelectionRef,
} from './inventory.js';
export { resolveClaudeRoute, type ClaudeRoute, type ClaudeRouteDeps } from './claude-route.js';
export {
  accountId, confirmAccount, createPendingAccount, findAccount, pendingAccounts, removeAccountEntry,
  type AccountCreate, type AccountInput, type AccountIssue, type AccountRef, type AccountRegistryDeps,
} from './accounts.js';
export {
  claudeAccountDir, ensureClaudeAccountDir, removeClaudeAccountDir, type ClaudeAccountDirDeps,
} from './claude-account-dir.js';
export {
  ensurePiAccountDir, piAccountAuthPath, piAccountAuthType, piAccountOfDir, removePiAccountDir,
  resolvePiAccountRoute, type PiAccountDirDeps,
} from './pi-account-dir.js';
export { buildPiCatalog, isGatewayEraBlock, type PiCatalog, type PiCatalogDeps } from './pi-catalog.js';
export { SUBSCRIPTION_CONNECTION } from '@core/connections-file.js';

type RouteRef = Pick<EngineSelection, 'backend' | 'provider' | 'connection'> & { model?: string };

/**
 * The name a selection's traffic is filed under — rate limits, the ledger, executions. Claude: the
 * connection it runs on — the one it names, else the one a run computes for its model (the default
 * when that serves it, else the first that does). PI: the account it names, else its provider (the
 * provider's default login).
 */
export function routeName(
  selection: RouteRef,
  context: Pick<SelectionContext, 'inventory' | 'catalog'> = {},
): string {
  if (selection.backend === 'pi') return selection.connection || selection.provider || 'pi';
  return selection.connection ?? claudeRunConnection(selection, context) ?? SUBSCRIPTION_CONNECTION;
}

/** The name a spawn's traffic is filed under: the connection its Claude route was resolved for, so
 *  the ledger names the account that actually served it. PI files under its route name. */
export function spawnRouteName(selection: RouteRef, route: { connection: string } | undefined): string {
  return selection.backend === 'claude' && route ? route.connection : routeName(selection);
}
