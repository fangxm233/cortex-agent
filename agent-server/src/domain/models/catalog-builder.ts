import type { Backend } from '@core/types/agent-types.js';
import type { PiDiscoveredModel } from '../../agent-adapter/pi/discovery.js';
import type { ConnectionView } from '../connections/inventory.js';

/** Where a route was first seen: the Anthropic catalog, PI's scan, a user-defined provider, or a
 *  base-URL override connection alone. */
export type CatalogSource = 'builtin' | 'pi' | 'custom' | 'connection';

export interface CatalogRoute {
  backend: Backend;
  /** PI's provider; null for Claude. */
  provider: string | null;
  /** Every connection a selection may name, the default first. Claude: its connections. PI: the
   *  provider itself, standing for its default login, then the provider's signed-in accounts. */
  connections: string[];
  /** Selectable model ids. Empty: a known route whose models are unknown — free text, not an error. */
  models: string[];
  source: CatalogSource;
  /** Thinking levels per model, for the models whose source could tell. */
  modelThinking: Record<string, string[]>;
  /** Claude: the connections serving a model, for each listed model not served by all of them. */
  modelConnections: Record<string, string[]>;
}

/**
 * The catalog is a UNION, never an intersection: a model must stay selectable for a route the host
 * cannot currently enumerate (PI reports only providers with usable auth, and a scan can fail
 * outright). Every source only adds; the route's identity belongs to whoever declared it first.
 * The one gate is the Claude backend itself: a host with no Claude connection gets no Claude route.
 */
export class CatalogBuilder {
  private readonly routes = new Map<string, CatalogRoute>();
  private readonly claude: ConnectionView[];
  private readonly pi: ConnectionView[];
  private readonly piAccounts: ConnectionView[];

  constructor(connections: ConnectionView[]) {
    this.claude = connections.filter((view) => view.backend === 'claude');
    this.pi = connections.filter((view) => view.backend === 'pi' && view.kind !== 'account');
    this.piAccounts = connections.filter((view) => view.backend === 'pi' && view.kind === 'account');
  }

  /** The Anthropic catalog, then the models connections list themselves. */
  addClaude(anthropicIds: string[], thinking: Record<string, string[]>): void {
    if (this.claude.length === 0) return;
    const listed = this.claude.flatMap((view) => view.models ?? []);
    const route = this.add({ backend: 'claude', provider: null }, 'builtin', [...anthropicIds, ...listed], thinking);
    route.modelConnections = claudeModelConnections(this.claude, route.models, new Set(anthropicIds));
  }

  addPiScan(models: PiDiscoveredModel[]): void {
    for (const [provider, entries] of groupByProvider(models)) {
      const thinking = Object.fromEntries(entries.filter((entry) => entry.thinkingLevels)
        .map((entry) => [entry.model, entry.thinkingLevels!]));
      this.add({ backend: 'pi', provider }, 'pi', entries.map((entry) => entry.model), thinking);
    }
  }

  /** Custom providers keep their own model lists even while a scan is cold or failing; an override
   *  alone still names its provider, with whatever models the scan found. */
  addPiConnections(): void {
    for (const view of this.pi) {
      const route = this.add({ backend: 'pi', provider: view.provider }, 'connection', view.models ?? []);
      if (view.kind === 'custom') route.source = 'custom';
    }
  }

  build(): CatalogRoute[] {
    return [...this.routes.values()];
  }

  private add(
    ref: { backend: Backend; provider: string | null },
    source: CatalogSource,
    models: readonly string[],
    thinking: Record<string, string[]> = {},
  ): CatalogRoute {
    const key = JSON.stringify([ref.backend, ref.provider]);
    const route = this.routes.get(key) ?? this.newRoute(ref, source);
    this.routes.set(key, route);
    for (const model of models) if (!route.models.includes(model)) route.models.push(model);
    for (const [model, levels] of Object.entries(thinking)) route.modelThinking[model] ??= [...levels];
    return route;
  }

  private newRoute(ref: { backend: Backend; provider: string | null }, source: CatalogSource): CatalogRoute {
    const connections = ref.backend === 'claude'
      ? this.claude.map((view) => view.id)
      : [ref.provider!, ...this.piAccounts.filter((view) => view.provider === ref.provider).map((view) => view.id)];
    return { ...ref, connections, models: [], source, modelThinking: {}, modelConnections: {} };
  }
}

function groupByProvider(models: PiDiscoveredModel[]): Map<string, PiDiscoveredModel[]> {
  const groups = new Map<string, PiDiscoveredModel[]>();
  for (const entry of models) {
    const group = groups.get(entry.provider) ?? [];
    if (!group.some((existing) => existing.model === entry.model)) group.push(entry);
    groups.set(entry.provider, group);
  }
  return groups;
}

/**
 * Which Claude connections serve a model. A connection with its own model list serves exactly that
 * list. One without a list serves the Anthropic catalog, and any model no connection lists — a
 * model only a local endpoint lists (say, an open-weights model behind an Anthropic-protocol
 * server) never lands on the subscription by default.
 */
function connectionServes(view: ConnectionView, model: string, others: ConnectionView[], anthropic: Set<string>): boolean {
  if (view.models) return view.models.includes(model);
  return anthropic.has(model) || !others.some((other) => other.models?.includes(model));
}

function claudeModelConnections(
  connections: ConnectionView[], models: string[], anthropic: Set<string>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const model of models) {
    const serving = connections.filter((view) => connectionServes(view, model, connections, anthropic));
    if (serving.length > 0 && serving.length < connections.length) result[model] = serving.map((view) => view.id);
  }
  return result;
}
