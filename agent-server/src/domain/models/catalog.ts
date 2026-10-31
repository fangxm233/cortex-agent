// ModelCatalog: the one answer to "which models can this host run, on which route, with which
// thinking levels". Pickers, onboarding, login seeding, selection validation, `!model` parsing and
// subagent model lists all read it. Three sources feed it: the Anthropic Models API (asked with the
// subscription or the official-API key connection, unioned with the shipped table), the model
// lists connections carry themselves, and PI's scan of the catalog its sessions run with.

import { ANTHROPIC_MODELS } from '@core/anthropic-models.js';
import {
  anthropicModelDiscovery, anthropicModelIds, anthropicModelThinking, type DiscoveredAnthropicModel,
} from '@core/anthropic-model-discovery.js';
import type { Backend } from '@core/types/agent-types.js';
import { piProviderDiscovery, type PiDiscoveredModel } from '../../agent-adapter/pi/discovery.js';
import { THINKING_LEVELS_BY_BACKEND, type ModelRef } from '../agents/engine-selection.js';
import { credentialInventory, type ConnectionView } from '../connections/inventory.js';
import { CatalogBuilder, type CatalogRoute } from './catalog-builder.js';

export type { CatalogRoute, CatalogSource } from './catalog-builder.js';

export interface CatalogSnapshot {
  routes: CatalogRoute[];
  /** True while PI's first scan has not answered: the PI list may still grow. */
  piPending: boolean;
  /** The backend-wide ladders a model without its own capability data accepts. */
  thinkingLevels: Record<Backend, string[]>;
}

/** Where the catalog reads from. Every source is injectable so a test never depends on this
 *  host's login, network or PI install. */
export interface ModelCatalogSources {
  connections: () => ConnectionView[];
  /** Anthropic Models API: `get` answers from cache, `ensure` waits out a cold fetch. */
  claudeModels: { get(): DiscoveredAnthropicModel[]; ensure(): Promise<DiscoveredAnthropicModel[]> };
  /** PI scan: `peek` never starts a scan, `ensure` waits out a cold one, `rescan` waits out a new
   *  one (falling back to `ensure` when a source cannot rescan). */
  piModels: {
    peek(): PiDiscoveredModel[];
    ensure(): Promise<PiDiscoveredModel[]>;
    rescan?(): Promise<PiDiscoveredModel[]>;
  };
}

export interface ModelCatalog {
  /** Waits (bounded) for cold sources: for callers whose purpose is the list. */
  load(): Promise<CatalogSnapshot>;
  /** Like `load`, but PI is rescanned first: for a caller that just changed what PI can reach (a
   *  login), where a warm list would still miss the new provider. */
  reload(): Promise<CatalogSnapshot>;
  /** Warm caches only, never a wait or a PI scan: for validation and command parsing. */
  peek(): CatalogSnapshot;
}

function defaultSources(): ModelCatalogSources {
  return {
    connections: () => credentialInventory.list(),
    claudeModels: { get: () => anthropicModelDiscovery.get(), ensure: () => anthropicModelDiscovery.ensure() },
    piModels: {
      peek: () => piProviderDiscovery.peekModels(),
      ensure: () => piProviderDiscovery.ensureModels(),
      rescan: () => piProviderDiscovery.rescan(),
    },
  };
}

function backendLadders(): Record<Backend, string[]> {
  return { claude: [...THINKING_LEVELS_BY_BACKEND.claude], pi: [...THINKING_LEVELS_BY_BACKEND.pi] };
}

function buildSnapshot(
  connections: ConnectionView[], claude: DiscoveredAnthropicModel[], pi: PiDiscoveredModel[],
): CatalogSnapshot {
  const builder = new CatalogBuilder(connections);
  const claudeIds = anthropicModelIds(claude, ANTHROPIC_MODELS);
  builder.addClaude(claudeIds, anthropicModelThinking(claude));
  builder.addPiScan(pi);
  builder.addPiConnections();
  return { routes: builder.build(), piPending: pi.length === 0, thinkingLevels: backendLadders() };
}

export function createModelCatalog(sources: Partial<ModelCatalogSources> = {}): ModelCatalog {
  const resolved = { ...defaultSources(), ...sources };
  const hasClaude = (connections: ConnectionView[]): boolean => connections.some((view) => view.backend === 'claude');
  const loadWith = async (pi: () => Promise<PiDiscoveredModel[]>): Promise<CatalogSnapshot> => {
    const connections = resolved.connections();
    const [claude, piModels] = await Promise.all([
      hasClaude(connections) ? resolved.claudeModels.ensure() : Promise.resolve([]),
      pi(),
    ]);
    return buildSnapshot(connections, claude, piModels);
  };
  return {
    load: () => loadWith(() => resolved.piModels.ensure()),
    reload: () => loadWith(() => (resolved.piModels.rescan ? resolved.piModels.rescan() : resolved.piModels.ensure())),
    peek() {
      const connections = resolved.connections();
      const claude = hasClaude(connections) ? resolved.claudeModels.get() : [];
      return buildSnapshot(connections, claude, resolved.piModels.peek());
    },
  };
}

/** The daemon's catalog over its own inventory and discovery caches. */
export const modelCatalog: ModelCatalog = createModelCatalog();

// ── Reading a snapshot ──────────────────────────────────────────────────────────────────────

type RouteRef = Pick<ModelRef, 'backend' | 'provider'>;

export function routeFor(snapshot: CatalogSnapshot, ref: RouteRef): CatalogRoute | undefined {
  return snapshot.routes.find((route) => route.backend === ref.backend && route.provider === ref.provider);
}

/** The thinking levels one model accepts: its own capability data when a source reported it, else
 *  the backend's whole ladder. Selection validation and the pickers both read this. */
export function thinkingLevelsFor(snapshot: CatalogSnapshot, ref: ModelRef): readonly string[] {
  return routeFor(snapshot, ref)?.modelThinking[ref.model] ?? snapshot.thinkingLevels[ref.backend];
}

/** The Claude connections that serve `model`, in inventory order (the default first). A model no
 *  connection can be shown to serve may run on any of them. */
export function servingConnections(snapshot: CatalogSnapshot, model: string): string[] {
  const route = routeFor(snapshot, { backend: 'claude', provider: null });
  return route ? route.modelConnections[model] ?? route.connections : [];
}

/** Every catalog identity that carries this model id, Claude first. */
export function findModelRefs(snapshot: CatalogSnapshot, model: string): ModelRef[] {
  return snapshot.routes
    .filter((route) => route.models.includes(model))
    .map((route) => ({ backend: route.backend, provider: route.provider, model }));
}
