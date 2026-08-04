// input:  custom provider definitions and the two files that hold them
// output: list, upsert and remove operations spanning catalog and gateway
// pos:    Orchestration of user-defined PI providers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import {
  buildModelsJsonEntry,
  gatewayAuthStyle,
  normalizeCustomProvider,
  readEntryModels,
  validateCustomProvider,
  type CustomProviderApi,
  type CustomProviderInput,
  type CustomProviderIssue,
  type CustomProviderModelSpec,
} from './custom-provider-model.js';
import {
  readCustomProviderEntries,
  removeModelsJsonProvider,
  upsertModelsJsonProvider,
} from './models-json-store.js';
import {
  readGatewayRoute,
  removeGatewayRoute,
  upsertGatewayRoute,
} from './gateway-route-store.js';

const log = createLogger('pi-custom-providers');

export interface CustomProviderStores {
  /** PI's user catalog (`~/.pi/agent/models.json`). */
  modelsPath: string;
  /** The gateway config the running gateway watches (`~/.aistatus/gateway.yaml`). */
  gatewayPath: string;
  /** Gateway base URL every custom provider is routed through. */
  gatewayUrl: string;
  /** Provider ids PI already owns, so a definition cannot shadow a built-in. */
  reservedNames?: string[];
  /** Called after a successful change so provider discovery and account status can refresh. */
  onChanged?: () => void;
}

/** Secret-free view of a stored custom provider. */
export interface CustomProviderView {
  name: string;
  api: CustomProviderApi;
  models: CustomProviderModelSpec[];
  /** Upstream from the gateway route, or null when the route is missing. */
  upstreamUrl: string | null;
  hasApiKey: boolean;
  /** Whether a gateway route backs this definition. False means calls will 404 at the gateway. */
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

function routeKeys(route: Record<string, unknown> | null): string[] {
  const keys = route?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
}

function viewOf(
  name: string,
  entry: Record<string, unknown>,
  route: Record<string, unknown> | null,
): CustomProviderView {
  const view: CustomProviderView = {
    name,
    api: entry.api as CustomProviderApi,
    models: readEntryModels(entry),
    upstreamUrl: typeof route?.base_url === 'string' ? route.base_url : null,
    hasApiKey: routeKeys(route).length > 0,
    routed: route !== null,
  };
  if (entry.headers && typeof entry.headers === 'object') {
    view.headers = entry.headers as Record<string, string>;
  }
  if (entry.compat && typeof entry.compat === 'object') {
    view.compat = entry.compat as Record<string, unknown>;
  }
  return view;
}

export function listCustomProviders(stores: CustomProviderStores): CustomProviderView[] {
  const entries = readCustomProviderEntries(stores.modelsPath);
  return Object.entries(entries).map(([name, entry]) => (
    viewOf(name, entry, readGatewayRoute(stores.gatewayPath, name, name))
  ));
}

export function getCustomProvider(
  stores: CustomProviderStores,
  name: string,
): CustomProviderView | null {
  const entry = readCustomProviderEntries(stores.modelsPath)[name];
  if (!entry) return null;
  return viewOf(name, entry, readGatewayRoute(stores.gatewayPath, name, name));
}

/**
 * Create or update a custom provider. The gateway route is written first — an unreferenced route is
 * inert — and the PI catalog second, because that write is what makes the provider visible to PI.
 * A failed catalog write therefore rolls the route back to its previous state.
 *
 * `apiKey` semantics: `undefined` keeps the stored upstream key (so an edit need not retype it),
 * `''` clears it and lets the gateway pass the caller's own key through.
 */
export function upsertCustomProvider(
  stores: CustomProviderStores,
  input: CustomProviderInput,
): CustomProviderResult {
  const provider = normalizeCustomProvider(input);
  const issues = validateCustomProvider(provider, { reservedNames: stores.reservedNames });
  if (issues.length > 0) return { ok: false, errors: issues };

  const { name } = provider;
  const previousRoute = readGatewayRoute(stores.gatewayPath, name, name);
  const keys = input.apiKey === undefined ? routeKeys(previousRoute) : [input.apiKey].filter(Boolean);

  try {
    upsertGatewayRoute(stores.gatewayPath, {
      endpoint: name,
      mode: name,
      base_url: provider.upstreamUrl,
      auth_style: gatewayAuthStyle(provider.api),
      keys,
      passthrough: keys.length === 0,
    });
  } catch (err) {
    log.warn(`Failed to write the gateway route for '${name}': ${(err as Error).message}`);
    return { ok: false, errors: ['write-failed'] };
  }

  const entry = buildModelsJsonEntry(provider, stores.gatewayUrl);
  try {
    upsertModelsJsonProvider(stores.modelsPath, name, entry);
  } catch (err) {
    log.warn(`Failed to write the PI catalog entry for '${name}': ${(err as Error).message}`);
    restoreRoute(stores, name, previousRoute);
    return { ok: false, errors: ['write-failed'] };
  }

  stores.onChanged?.();
  return { ok: true, provider: viewOf(name, entry, readGatewayRoute(stores.gatewayPath, name, name)) };
}

function restoreRoute(
  stores: CustomProviderStores,
  name: string,
  previousRoute: Record<string, unknown> | null,
): void {
  try {
    if (!previousRoute) {
      removeGatewayRoute(stores.gatewayPath, name, name);
      return;
    }
    upsertGatewayRoute(stores.gatewayPath, {
      endpoint: name,
      mode: name,
      base_url: String(previousRoute.base_url ?? ''),
      auth_style: String(previousRoute.auth_style ?? 'bearer'),
      keys: routeKeys(previousRoute),
      passthrough: previousRoute.passthrough === true,
    });
  } catch (err) {
    log.warn(`Failed to roll the gateway route for '${name}' back: ${(err as Error).message}`);
  }
}

/** Remove a custom provider from both files. Built-in overrides are not custom and are refused. */
export function removeCustomProvider(
  stores: CustomProviderStores,
  name: string,
): CustomProviderRemoval {
  if (!readCustomProviderEntries(stores.modelsPath)[name]) return { ok: false, errors: ['not-found'] };

  try {
    removeModelsJsonProvider(stores.modelsPath, name);
    removeGatewayRoute(stores.gatewayPath, name, name);
  } catch (err) {
    log.warn(`Failed to remove custom provider '${name}': ${(err as Error).message}`);
    return { ok: false, errors: ['write-failed'] };
  }

  stores.onChanged?.();
  return { ok: true };
}
