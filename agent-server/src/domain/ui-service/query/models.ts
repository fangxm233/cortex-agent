import { ANTHROPIC_MODELS } from '@core/anthropic-models.js';
import {
  anthropicModelDiscovery, anthropicModelIds, anthropicModelThinking,
  type DiscoveredAnthropicModel,
} from '@core/anthropic-model-discovery.js';
import { credentialInventory, type ConnectionView } from '@domain/connections/inventory.js';
import {
  defaultCustomProviderStores,
  listCustomProviders,
  type CustomProviderView,
} from '@domain/pi-providers/index.js';
import { piProviderDiscovery } from '../../../agent-adapter/pi/discovery.js';
import { THINKING_LEVELS_BY_BACKEND } from '@domain/agents/engine-selection.js';
import type { ModelCatalogRoute, ModelCatalogSnapshot, UiServiceDeps, QueryParams } from '../types.js';

/**
 * The catalog is a UNION, never an intersection: a model must stay selectable for an endpoint the
 * host cannot currently enumerate (PI reports only providers with usable auth, and a scan can fail
 * outright). Every source therefore only ADDS — a provider known solely from a base-URL override
 * connection still appears, with an empty model list, and the editor falls back to free text for
 * it. The one gate is the Claude backend itself: a host with no Claude connection gets no Claude
 * route at all.
 *
 * Deliberately its own query rather than a field of the high-frequency `config.get`: reading PI's
 * models loads the bundled SDK (~100 MB, see core/pi-sdk.ts), a cost only a caller that actually
 * wants the catalog should pay.
 */

interface RouteRef {
  backend: 'claude' | 'pi';
  provider: string | null;
}

/** The Claude route is a constant of the backend — only its model list is discovered. */
const CLAUDE_ROUTE: RouteRef = { backend: 'claude', provider: null };

function piRoute(provider: string): RouteRef {
  return { backend: 'pi', provider };
}

/** A later source only contributes model ids it is the first to know about; the route's own
 *  identity (backend, provider, source) is owned by whoever declared it first. */
function mergeRouteModels(
  route: ModelCatalogRoute, models: readonly string[], modelThinking: Record<string, string[]>,
): void {
  for (const model of models) if (!route.models.includes(model)) route.models.push(model);
  const known = route.modelThinking!;
  for (const [model, levels] of Object.entries(modelThinking)) {
    if (!(model in known)) known[model] = levels;
  }
}

/** Routes are keyed by engine identity: Claude Code and PI's `anthropic` provider are separate. */
class RouteBuilder {
  private readonly routes = new Map<string, ModelCatalogRoute>();

  constructor(private readonly claudeConnections: string[]) {}

  add(
    ref: RouteRef,
    source: ModelCatalogRoute['source'],
    models: readonly string[],
    modelThinking: Record<string, string[]> = {},
  ): void {
    const key = JSON.stringify([ref.backend, ref.provider]);
    const existing = this.routes.get(key);
    if (existing) return mergeRouteModels(existing, models, modelThinking);
    this.routes.set(key, {
      endpoint: ref.backend === 'claude' ? 'anthropic' : ref.provider!,
      backend: ref.backend,
      provider: ref.provider,
      connections: ref.backend === 'claude' ? [...this.claudeConnections] : [],
      models: [...models],
      source,
      modelThinking: { ...modelThinking },
    });
  }

  build(): ModelCatalogRoute[] {
    return [...this.routes.values()];
  }
}

export interface ModelsCatalogReaders {
  /** The host's connections. Defaults to the inventory; injected in tests so the catalog never
   *  depends on this machine's login. */
  connections?: () => ConnectionView[];
  /** The Anthropic models this account can reach, waiting out a cold fetch. Defaults to the host
   *  discovery singleton; injected in tests so the catalog never depends on a live credential. */
  claudeModels?: () => Promise<DiscoveredAnthropicModel[]>;
  /** The PI pairs, waiting out a cold scan. Defaults to the host discovery singleton. */
  piModels?: () => Promise<Array<{ provider: string; model: string; thinkingLevels?: string[] }>>;
  /** The cached PI pairs with NO refresh kicked — used only to report `piPending`. */
  piPeek?: () => Array<{ provider: string; model: string }>;
  customProviders?: () => CustomProviderView[];
}

export async function handleModelsCatalog(
  deps: UiServiceDeps,
  _params: QueryParams<'models.catalog'>,
  readers: ModelsCatalogReaders = {},
): Promise<ModelCatalogSnapshot> {
  const connections = (readers.connections ?? (() => credentialInventory.list()))();
  const claude = connections.filter((view) => view.backend === 'claude');
  const builder = new RouteBuilder(claude.map((view) => view.id));
  if (claude.length > 0) await addClaudeRoute(builder, readers, claude);
  await addPiRoutes(builder, readers);
  const customProviders =
    readers.customProviders
    ?? (() => listCustomProviders(deps.customProviderStores ?? defaultCustomProviderStores()));
  for (const provider of customProviders()) {
    builder.add(piRoute(provider.name), 'custom', provider.models.map((model) => model.id));
  }
  for (const view of connections) {
    if (view.backend === 'pi' && view.kind === 'override') builder.add(piRoute(view.provider!), 'connection', []);
  }
  const piPeek = readers.piPeek ?? (() => piProviderDiscovery.peekModels());
  return {
    routes: builder.build(),
    piPending: piPeek().length === 0,
    thinkingLevels: { claude: [...THINKING_LEVELS_BY_BACKEND.claude], pi: [...THINKING_LEVELS_BY_BACKEND.pi] },
  };
}

/**
 * Only a host with a Claude connection gets the route, the way PI lists only providers with usable
 * auth. Discovered ids are UNIONED with the shipped table, never replacing it: a logged-in host
 * with no network keeps the list it always had. A connection that serves its own models (a local
 * model behind an Anthropic-protocol endpoint) adds them. `source` stays 'builtin' because the
 * route's identity did not change — only how completely its models are known.
 */
async function addClaudeRoute(
  builder: RouteBuilder, readers: ModelsCatalogReaders, connections: ConnectionView[],
): Promise<void> {
  const claudeModels = readers.claudeModels ?? (() => anthropicModelDiscovery.ensure());
  const claude = await claudeModels();
  builder.add(
    CLAUDE_ROUTE, 'builtin',
    anthropicModelIds(claude, ANTHROPIC_MODELS), anthropicModelThinking(claude),
  );
  for (const view of connections) if (view.models) builder.add(CLAUDE_ROUTE, 'builtin', view.models);
}

/**
 * `ensureModels()` waits out a COLD scan (bounded) and serves a warm cache at once: a picker's
 * whole purpose is the list, so an empty first answer would only become a spinner. A scan that is
 * still failing is not retried here — it left a backoff, and `piPending` reports the gap.
 */
async function addPiRoutes(builder: RouteBuilder, readers: ModelsCatalogReaders): Promise<void> {
  const piModels = readers.piModels ?? (() => piProviderDiscovery.ensureModels());
  const byProvider = new Map<string, string[]>();
  const thinkingByProvider = new Map<string, Record<string, string[]>>();
  for (const pair of await piModels()) {
    const models = byProvider.get(pair.provider) ?? [];
    if (!models.includes(pair.model)) models.push(pair.model);
    byProvider.set(pair.provider, models);
    if (!pair.thinkingLevels) continue;
    const levels = thinkingByProvider.get(pair.provider) ?? {};
    levels[pair.model] = pair.thinkingLevels;
    thinkingByProvider.set(pair.provider, levels);
  }
  for (const [provider, models] of byProvider) {
    builder.add(piRoute(provider), 'pi', models, thinkingByProvider.get(provider) ?? {});
  }
}
