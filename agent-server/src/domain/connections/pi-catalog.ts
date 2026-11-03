// The provider catalog Cortex's PI sessions run with. PI's built-in providers are left alone and
// reach their vendors directly with PI's own credentials; only what a connection changes is
// written: a built-in provider's base URL (with the key that URL takes), and complete definitions
// for providers PI does not know. The user's own PI catalog is carried over beneath them.

import {
  CONNECTIONS_FILE, isPiCustomConnection, piProviderConnections, readConnections, type PiConnection,
} from '@core/connections-file.js';
import { readProvidersBlock } from '../../agent-adapter/pi/custom-catalog.js';
import { USER_PI_MODELS_PATH } from '../../agent-adapter/pi/agent-dir.js';

type Block = Record<string, unknown>;

export interface PiCatalog {
  /** `providers.*` of the models.json the PI agent dir gets. Carries keys: owner-only on disk. */
  providers: Record<string, Block>;
  /** Keys that must win over PI's own credential store for the same provider. A URL override's key
   *  belongs to that URL, while PI's auth.json may hold the vendor's key for the same provider. */
  runtimeKeys: Record<string, string>;
}

export interface PiCatalogDeps {
  file?: string;
  /** The user's PI catalog (`~/.pi/agent/models.json`). Null: carry nothing over. */
  userModelsPath?: string | null;
  /** The provider of the account whose agent dir this catalog is for. No key is written for it —
   *  the account's own credential must be the one that provider sends. */
  accountProvider?: string;
}

/** The placeholder key and route Cortex wrote while every PI call went through a local gateway. */
const GATEWAY_PLACEHOLDER_KEY = 'cortex-gateway';
const LOCAL_GATEWAY_ROUTE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/m\//;

/** A block from the gateway era routes to a gateway that no longer serves PI, so it is dropped. */
export function isGatewayEraBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const { apiKey, baseUrl } = block as Block;
  return apiKey === GATEWAY_PLACEHOLDER_KEY
    || (typeof baseUrl === 'string' && LOCAL_GATEWAY_ROUTE.test(baseUrl));
}

function userBlocks(userModelsPath: string | null): Record<string, Block> {
  if (!userModelsPath) return {};
  const blocks: Record<string, Block> = {};
  for (const [name, block] of Object.entries(readProvidersBlock(userModelsPath))) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    if (!isGatewayEraBlock(block)) blocks[name] = block as Block;
  }
  return blocks;
}

function connectionBlock(connection: PiConnection): Block {
  const block: Block = { baseUrl: connection.baseUrl };
  if (connection.key) block.apiKey = connection.key;
  if (!isPiCustomConnection(connection)) return block;
  block.api = connection.api;
  block.models = connection.models.map((model) => ({ ...model }));
  if (connection.headers) block.headers = { ...connection.headers };
  if (connection.compat) block.compat = { ...connection.compat };
  return block;
}

export function buildPiCatalog(deps: PiCatalogDeps = {}): PiCatalog {
  const providers = userBlocks(deps.userModelsPath === undefined ? USER_PI_MODELS_PATH : deps.userModelsPath);
  const runtimeKeys: Record<string, string> = {};
  for (const connection of piProviderConnections(readConnections(deps.file ?? CONNECTIONS_FILE))) {
    providers[connection.provider] = connectionBlock(connection);
    if (connection.key) runtimeKeys[connection.provider] = connection.key;
  }
  return deps.accountProvider ? withoutKeyFor({ providers, runtimeKeys }, deps.accountProvider) : { providers, runtimeKeys };
}

/** The catalog an account's agent dir gets: the same, minus every key for the account's provider. */
function withoutKeyFor(catalog: PiCatalog, provider: string): PiCatalog {
  const { [provider]: _key, ...runtimeKeys } = catalog.runtimeKeys;
  const block = catalog.providers[provider];
  if (!block || !('apiKey' in block)) return { providers: catalog.providers, runtimeKeys };
  const { apiKey: _apiKey, ...keyless } = block;
  return { providers: { ...catalog.providers, [provider]: keyless }, runtimeKeys };
}
