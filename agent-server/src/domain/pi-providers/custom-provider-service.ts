import { createLogger } from '@core/log.js';
import {
  CONNECTIONS_FILE, isPiCustomConnection, piProviderConnections, readConnections, removeConnection, upsertConnection,
  type PiCustomConnection, type PiModelDefinition,
} from '@core/connections-file.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import {
  normalizeCustomProvider,
  readEntryModels,
  validateCustomProvider,
  type CustomProviderApi,
  type CustomProviderInput,
  type CustomProviderIssue,
  type CustomProviderModelSpec,
} from './custom-provider-model.js';

const log = createLogger('pi-custom-providers');

export interface CustomProviderStores {
  /** Cortex's connections file, where a custom provider is defined with its key. */
  connectionsPath: string;
  /** Called after a successful change so provider discovery and account status can refresh. */
  onChanged?: () => void;
}

/**
 * A custom provider is a PI connection carrying a complete definition. A change invalidates the
 * provider discovery cache the same way a login does, so a provider defined from any surface reaches
 * the next spawn without waiting out the cache TTL.
 */
export function defaultCustomProviderStores(): CustomProviderStores {
  return {
    connectionsPath: CONNECTIONS_FILE,
    onChanged: () => piProviderDiscovery.refresh(),
  };
}

/** Secret-free view of a stored custom provider. */
export interface CustomProviderView {
  name: string;
  api: CustomProviderApi;
  models: CustomProviderModelSpec[];
  upstreamUrl: string | null;
  hasApiKey: boolean;
  /** Always true: a custom provider is called at its own URL. Kept for clients that render it. */
  routed: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export type CustomProviderFailure = CustomProviderIssue | 'write-failed' | 'not-found';

export type CustomProviderResult =
  | { ok: true; provider: CustomProviderView }
  | { ok: false; errors: CustomProviderFailure[] };

export type CustomProviderRemoval =
  | { ok: true }
  | { ok: false; errors: CustomProviderFailure[] };

function viewOf(connection: PiCustomConnection): CustomProviderView {
  const view: CustomProviderView = {
    name: connection.provider,
    api: connection.api as CustomProviderApi,
    models: readEntryModels({ models: connection.models }),
    upstreamUrl: connection.baseUrl,
    hasApiKey: !!connection.key,
    routed: true,
  };
  if (connection.headers) view.headers = connection.headers;
  if (connection.compat) view.compat = connection.compat;
  return view;
}

function customConnections(stores: CustomProviderStores): PiCustomConnection[] {
  return piProviderConnections(readConnections(stores.connectionsPath))
    .filter((entry): entry is PiCustomConnection => isPiCustomConnection(entry));
}

function findCustom(stores: CustomProviderStores, name: string): PiCustomConnection | null {
  return customConnections(stores).find((entry) => entry.provider === name) ?? null;
}

export function listCustomProviders(stores: CustomProviderStores): CustomProviderView[] {
  return customConnections(stores).map(viewOf);
}

export function getCustomProvider(
  stores: CustomProviderStores,
  name: string,
): CustomProviderView | null {
  const connection = findCustom(stores, name);
  return connection ? viewOf(connection) : null;
}

/** Edited models keep the fields an earlier definition carried for the same id. */
function mergedModels(previous: PiCustomConnection | null, models: CustomProviderModelSpec[]): PiModelDefinition[] {
  const byId = new Map((previous?.models ?? []).map((model) => [model.id, model]));
  return models.map((spec) => ({ ...byId.get(spec.id), ...spec }));
}

function connectionOf(provider: CustomProviderInput, previous: PiCustomConnection | null, key: string | undefined): PiCustomConnection {
  const connection: PiCustomConnection = {
    id: provider.name, backend: 'pi', provider: provider.name, api: provider.api,
    baseUrl: provider.upstreamUrl, models: mergedModels(previous, provider.models),
  };
  if (key) connection.key = key;
  const headers = provider.headers !== undefined ? provider.headers : previous?.headers;
  const compat = provider.compat !== undefined ? provider.compat : previous?.compat;
  if (headers && Object.keys(headers).length > 0) connection.headers = headers;
  if (compat && Object.keys(compat).length > 0) connection.compat = compat;
  return connection;
}

/**
 * Create or update a custom provider.
 *
 * `apiKey` semantics: `undefined` keeps the stored key (so an edit need not retype it), `''` clears
 * it.
 */
export function upsertCustomProvider(
  stores: CustomProviderStores,
  input: CustomProviderInput,
): CustomProviderResult {
  const provider = normalizeCustomProvider(input);
  const issues = validateCustomProvider(provider);
  if (issues.length > 0) return { ok: false, errors: issues };

  const previous = findCustom(stores, provider.name);
  const key = input.apiKey === undefined ? previous?.key : input.apiKey || undefined;
  const connection = connectionOf(provider, previous, key);
  try {
    upsertConnection(connection, stores.connectionsPath);
  } catch (err) {
    log.warn(`Failed to save custom provider '${provider.name}': ${(err as Error).message}`);
    return { ok: false, errors: ['write-failed'] };
  }
  stores.onChanged?.();
  return { ok: true, provider: viewOf(connection) };
}

/** Remove a custom provider. A base-URL override of a built-in provider is not custom and is refused. */
export function removeCustomProvider(
  stores: CustomProviderStores,
  name: string,
): CustomProviderRemoval {
  if (!findCustom(stores, name)) return { ok: false, errors: ['not-found'] };
  try {
    removeConnection({ backend: 'pi', id: name }, stores.connectionsPath);
  } catch (err) {
    log.warn(`Failed to remove custom provider '${name}': ${(err as Error).message}`);
    return { ok: false, errors: ['write-failed'] };
  }
  stores.onChanged?.();
  return { ok: true };
}
