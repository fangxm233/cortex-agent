import type {
  AuthStatusSnapshot, ConfigSnapshot, ConnectionView, EngineSelection, ModelCatalogSnapshot, ModelRef,
} from '@cortex-agent/ui-contract';

export function modelKey(ref: ModelRef): string {
  return JSON.stringify([ref.backend, ref.provider, ref.model]);
}

export function modelLabel(ref: ModelRef): string {
  return ref.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** Display names of one backend's connections that have one: an account shows its label, Claude's
 *  default login the name it is given, every other connection its id. Account ids are unique only
 *  within a backend, so each backend has its own names. */
export type ConnectionNames = Readonly<Record<string, string>>;
export type BackendConnectionNames = Readonly<Record<ModelRef['backend'], ConnectionNames>>;

function viewName(view: ConnectionView, defaultLogin: string | undefined): string | undefined {
  if (view.kind === 'account') return view.label;
  return view.kind === 'subscription' ? defaultLogin : undefined;
}

export function connectionNames(
  views: readonly ConnectionView[] | null | undefined, defaultLogin?: string, backend?: ModelRef['backend'],
): ConnectionNames {
  return Object.fromEntries((views ?? []).flatMap((view) => {
    const name = !backend || view.backend === backend ? viewName(view, defaultLogin) : undefined;
    return name ? [[view.id, name]] : [];
  }));
}

/** What Claude's default login is called: the email it is signed in as, else `fallback`. */
export function defaultLoginName(status: AuthStatusSnapshot | null | undefined, fallback: string): string {
  const row = status?.accounts.find((account) => account.backend === 'claude' && !account.connection);
  return row?.identity?.email ?? fallback;
}

export function connectionName(names: ConnectionNames, id: string): string {
  return Object.hasOwn(names, id) ? names[id] : id;
}

function routeOf(catalog: ModelCatalogSnapshot | null | undefined, ref: Pick<ModelRef, 'backend' | 'provider'>) {
  return catalog?.routes.find((route) => route.backend === ref.backend && route.provider === ref.provider);
}

/** The connections that can run a model, the default first, by the catalog's own rule.
 *  Claude: the model's own list when the catalog has one, else every Claude connection.
 *  PI: the provider itself — its default login — then the provider's signed-in accounts; a
 *  provider the catalog does not list still runs on its default login. */
export function servingConnections(catalog: ModelCatalogSnapshot | null | undefined, ref: ModelRef): string[] {
  const route = routeOf(catalog, ref);
  if (ref.backend === 'pi') return route?.connections.length ? route.connections : ref.provider ? [ref.provider] : [];
  return route ? route.modelConnections?.[ref.model] ?? route.connections : [];
}

/** The connection a selection that names none runs on: the default connection when it serves the
 *  model, else the first one that does — the server's rule, shown before the run. For PI that is
 *  the provider's default login, named by the provider. */
export function defaultConnectionFor(catalog: ModelCatalogSnapshot | null | undefined, ref: ModelRef): string | null {
  const serving = servingConnections(catalog, ref);
  const fallback = ref.backend === 'pi' ? serving[0] : routeOf(catalog, ref)?.connections[0];
  return fallback && serving.includes(fallback) ? fallback : serving[0] ?? null;
}

/** The connection a pick carries over: the current one while the pick stays on its backend and —
 *  for PI, whose accounts each belong to one provider — on its provider. */
function carriedConnection(ref: ModelRef, current: EngineSelection | null | undefined): string | null {
  if (!current || current.backend !== ref.backend) return null;
  if (ref.backend === 'pi' && current.provider !== ref.provider) return null;
  return current.connection;
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
  const carried = carriedConnection(ref, current);
  const connection = carried && servingConnections(catalog, ref).includes(carried) ? carried : null;
  return { ...ref, thinking: remembered?.thinking ?? null, connection };
}

/** Whether this host can run a selection: a PI provider always has its default login; a Claude
 *  model needs a connection that serves it, which only a loaded catalog can tell. */
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
