import { modelCatalog, type CatalogRoute, type ModelCatalog } from '@domain/models/catalog.js';
import type { ModelCatalogRoute, ModelCatalogSnapshot, UiServiceDeps, QueryParams } from '../types.js';

/**
 * The pickers' view of the ModelCatalog. Deliberately its own query rather than a field of the
 * high-frequency `config.get`: reading PI's models loads the bundled SDK (~100 MB, see
 * core/pi-sdk.ts), a cost only a caller that actually wants the catalog should pay.
 */
function routeView(route: CatalogRoute): ModelCatalogRoute {
  return {
    endpoint: route.backend === 'claude' ? 'anthropic' : route.provider!,
    backend: route.backend,
    provider: route.provider,
    connections: [...route.connections],
    models: [...route.models],
    source: route.source,
    modelThinking: { ...route.modelThinking },
    modelConnections: { ...route.modelConnections },
  };
}

export async function handleModelsCatalog(
  _deps: UiServiceDeps,
  _params: QueryParams<'models.catalog'>,
  catalog: ModelCatalog = modelCatalog,
): Promise<ModelCatalogSnapshot> {
  const snapshot = await catalog.load();
  return { routes: snapshot.routes.map(routeView), piPending: snapshot.piPending, thinkingLevels: snapshot.thinkingLevels };
}
