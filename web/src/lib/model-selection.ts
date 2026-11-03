import type {
  ConfigSnapshot, ConnectionView, EngineSelection, ModelCatalogSnapshot, ModelRef,
} from '@cortex-agent/ui-contract';

export function modelKey(ref: ModelRef): string {
  return JSON.stringify([ref.backend, ref.provider, ref.model]);
}

export function modelLabel(ref: ModelRef): string {
  return ref.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** Display names of connections that have one: an account shows its label, every other connection
 *  its id. */
export type ConnectionNames = Readonly<Record<string, string>>;

export function connectionNames(views: readonly ConnectionView[] | null | undefined): ConnectionNames {
  return Object.fromEntries((views ?? []).filter((view) => view.kind === 'account').map((view) => [view.id, view.label]));
}

export function connectionName(names: ConnectionNames, id: string): string {
  return Object.hasOwn(names, id) ? names[id] : id;
}

function claudeRoute(catalog: ModelCatalogSnapshot | null | undefined) {
  return catalog?.routes.find((route) => route.backend === 'claude' && route.provider === null);
}

/** The Claude connections that can run a model, by the catalog's own rule: the model's own list when
 *  the catalog has one, else every Claude connection (the default first). Empty for PI. */
export function servingConnections(catalog: ModelCatalogSnapshot | null | undefined, ref: ModelRef): string[] {
  if (ref.backend !== 'claude') return [];
  const route = claudeRoute(catalog);
  return route ? route.modelConnections?.[ref.model] ?? route.connections : [];
}

/** The connection a selection that names none runs on: the default connection when it serves the
 *  model, else the first one that does — the server's rule, shown before the run. */
export function defaultConnectionFor(catalog: ModelCatalogSnapshot | null | undefined, ref: ModelRef): string | null {
  const serving = servingConnections(catalog, ref);
  const fallback = claudeRoute(catalog)?.connections[0];
  return fallback && serving.includes(fallback) ? fallback : serving[0] ?? null;
}

/**
 * The selection a model pick makes: the model's remembered thinking, and the current connection
 * while it serves the new model. Otherwise no connection is named and each run computes it.
 */
export function selectionForModel(
  ref: ModelRef,
  config: Pick<ConfigSnapshot, 'models'> | null | undefined,
  catalog?: ModelCatalogSnapshot | null,
  current?: EngineSelection | null,
): EngineSelection {
  const remembered = config?.models.memory[modelKey(ref)];
  const carried = ref.backend === 'claude' && current?.backend === 'claude' ? current.connection : null;
  const connection = carried && servingConnections(catalog, ref).includes(carried) ? carried : null;
  return { ...ref, thinking: remembered?.thinking ?? null, connection };
}

/** Whether this host can run a selection: PI's provider is its connection; a Claude model needs a
 *  connection that serves it, which only a loaded catalog can tell. */
export function hasRoute(selection: EngineSelection, catalog: ModelCatalogSnapshot | null | undefined): boolean {
  return selection.backend === 'pi' || servingConnections(catalog, selection).length > 0;
}

export function catalogModels(catalog?: ModelCatalogSnapshot | null): ModelRef[] {
  return (catalog?.routes ?? []).flatMap((route) => route.models.map((model) => ({
    backend: route.backend, provider: route.provider, model,
  })));
}

export function matchesModelFilter(model: string, filter: string): boolean {
  return model.toLowerCase().includes(filter.trim().toLowerCase());
}
