import { SUBSCRIPTION_CONNECTION } from '@core/connections-file.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { credentialInventory, type CredentialInventory } from './inventory.js';

export {
  createCredentialInventory, credentialInventory, legacyClaudeOAuthToken,
  type ConnectionKind, type ConnectionView, type CredentialInventory, type InventoryDeps, type SelectionRef,
} from './inventory.js';
export { resolveClaudeRoute, type ClaudeRoute, type ClaudeRouteDeps } from './claude-route.js';
export { buildPiCatalog, isGatewayEraBlock, type PiCatalog, type PiCatalogDeps } from './pi-catalog.js';
export { SUBSCRIPTION_CONNECTION } from '@core/connections-file.js';

type RouteRef = Pick<EngineSelection, 'backend' | 'provider' | 'connection'>;

/**
 * The name a selection's traffic is filed under — rate limits, the ledger, executions. Claude: the
 * connection it runs on (the default one when it names none). PI: its provider, which is its
 * connection.
 */
export function routeName(selection: RouteRef, inventory: CredentialInventory = credentialInventory): string {
  if (selection.backend === 'pi') return selection.provider || 'pi';
  return selection.connection ?? inventory.defaultClaudeConnection() ?? SUBSCRIPTION_CONNECTION;
}
