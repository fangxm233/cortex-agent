import {
  defaultCustomProviderStores,
  listCustomProviders,
  type CustomProviderView,
} from '@domain/pi-providers/index.js';
import type { AuthCustomProvidersParams, UiServiceDeps } from '../types.js';

/**
 * Every entry is derived from PI's own catalog joined with its gateway route, so the list shows the
 * same definitions the terminal `pi` sees. The upstream key stays in the gateway config: the view
 * reports only whether one is stored.
 */
export async function handleCustomProvidersList(
  deps: UiServiceDeps,
  _params: AuthCustomProvidersParams,
): Promise<CustomProviderView[]> {
  return listCustomProviders(deps.customProviderStores ?? defaultCustomProviderStores());
}
