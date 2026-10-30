import { ANTHROPIC_MODELS } from '@core/anthropic-models.js';
import {
  anthropicModelDiscovery, anthropicModelIds, anthropicModelThinking,
  type DiscoveredAnthropicModel,
} from '@core/anthropic-model-discovery.js';
import { hasClaudeCredential } from '@core/claude-credentials.js';
import { readGatewayYaml } from '@core/gateway-generator.js';
import {
  ANTHROPIC_ENDPOINT, gatewayEndpointFor, piGatewayMode, PI_ANTHROPIC_MODE, routeModes,
  type GatewayRouteRef,
} from '@core/gateway-routes.js';
import {
  defaultCustomProviderStores,
  listCustomProviders,
  GATEWAY_CONFIG_PATH,
  type CustomProviderView,
} from '@domain/pi-providers/index.js';
import { piProviderDiscovery } from '../../../agent-adapter/pi/discovery.js';
import { THINKING_LEVELS_BY_BACKEND } from '@domain/agents/engine-selection.js';
import type { ModelCatalogRoute, ModelCatalogSnapshot, UiServiceDeps, QueryParams } from '../types.js';

/**
 * The catalog is a UNION, never an intersection: a model must stay selectable for an endpoint the
 * host cannot currently enumerate (PI reports only providers with usable auth, and a scan can fail
 * outright). Every source therefore only ADDS — an endpoint known solely from gateway.yaml still
 * appears, with an empty model list, and the editor falls back to free text for it. The one gate is
 * the Claude backend itself: a host holding no Claude credential gets no Claude route at all.
 *
 * Deliberately its own query rather than a field of the high-frequency `config.get`: reading PI's
 * models loads the bundled SDK (~100 MB, see core/pi-sdk.ts), a cost only a caller that actually
 * wants the catalog should pay.
 */

/** The Claude route is a constant of the backend — only its model list is discovered. */
const CLAUDE_ROUTE: GatewayRouteRef = { backend: 'claude', provider: null };

function piRoute(provider: string): GatewayRouteRef {
  return { backend: 'pi', provider };
}

/** Mirrors gateway-generator for a route gateway.yaml declares no mode for: the mode it would write. */
function defaultModes(ref: GatewayRouteRef): string[] {
  return ref.backend === 'claude' ? ['plan'] : [piGatewayMode(ref.provider!)];
}

type GatewayReader = () => Record<string, string[]>;

/** endpoint → declared mode names, in gateway.yaml order. Unreadable file ⇒ no modes known. */
function readGatewayModes(): Record<string, string[]> {
  const parsed = readGatewayYaml(GATEWAY_CONFIG_PATH);
  if (!parsed) return {};
  return Object.fromEntries(
    Object.entries(parsed.endpoints).map(([endpoint, modes]) => [endpoint, Object.keys(modes)]),
  );
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

/**
 * Routes are keyed by engine identity, not by gateway section: Claude Code and PI's `anthropic`
 * provider share the `anthropic` section yet are separate routes, each offered only its own modes.
 */
class RouteBuilder {
  private readonly routes = new Map<string, ModelCatalogRoute>();

  constructor(private readonly gatewayModes: Record<string, string[]>) {}

  add(
    ref: GatewayRouteRef,
    source: ModelCatalogRoute['source'],
    models: readonly string[],
    modelThinking: Record<string, string[]> = {},
  ): void {
    const key = JSON.stringify([ref.backend, ref.provider]);
    const existing = this.routes.get(key);
    if (existing) return mergeRouteModels(existing, models, modelThinking);
    const endpoint = gatewayEndpointFor(ref)!;
    const declared = routeModes(ref, this.gatewayModes[endpoint] ?? []);
    this.routes.set(key, {
      endpoint,
      backend: ref.backend,
      provider: ref.provider,
      modes: declared.length > 0 ? declared : defaultModes(ref),
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
  /** Whether this host holds any Claude credential. Defaults to the host's stores; injected in
   *  tests so the catalog never depends on this machine's login. */
  claudeAvailable?: () => boolean;
  /** The Anthropic models this account can reach, waiting out a cold fetch. Defaults to the host
   *  discovery singleton; injected in tests so the catalog never depends on a live credential. */
  claudeModels?: () => Promise<DiscoveredAnthropicModel[]>;
  /** The PI pairs, waiting out a cold scan. Defaults to the host discovery singleton. */
  piModels?: () => Promise<Array<{ provider: string; model: string; thinkingLevels?: string[] }>>;
  /** The cached PI pairs with NO refresh kicked — used only to report `piPending`. */
  piPeek?: () => Array<{ provider: string; model: string }>;
  customProviders?: () => CustomProviderView[];
  gatewayModes?: GatewayReader;
}

export async function handleModelsCatalog(
  deps: UiServiceDeps,
  _params: QueryParams<'models.catalog'>,
  readers: ModelsCatalogReaders = {},
): Promise<ModelCatalogSnapshot> {
  const gatewayModes = (readers.gatewayModes ?? readGatewayModes)();
  const claudeAvailable = (readers.claudeAvailable ?? (() => hasClaudeCredential()))();
  const builder = new RouteBuilder(gatewayModes);
  if (claudeAvailable) await addClaudeRoute(builder, readers);
  await addPiRoutes(builder, readers);
  const customProviders =
    readers.customProviders
    ?? (() => listCustomProviders(deps.customProviderStores ?? defaultCustomProviderStores()));
  for (const provider of customProviders()) {
    builder.add(piRoute(provider.name), 'custom', provider.models.map((model) => model.id));
  }
  addGatewayRoutes(builder, gatewayModes, claudeAvailable);
  const piPeek = readers.piPeek ?? (() => piProviderDiscovery.peekModels());
  return {
    routes: builder.build(),
    piPending: piPeek().length === 0,
    thinkingLevels: { claude: [...THINKING_LEVELS_BY_BACKEND.claude], pi: [...THINKING_LEVELS_BY_BACKEND.pi] },
  };
}

/**
 * Only a host holding a Claude credential gets the route, the way PI lists only providers with
 * usable auth. Discovered ids are UNIONED with the shipped table, never replacing it: a logged-in
 * host with no network keeps the list it always had. `source` stays 'builtin' because the route's
 * identity did not change — only how completely its models are known.
 */
async function addClaudeRoute(builder: RouteBuilder, readers: ModelsCatalogReaders): Promise<void> {
  const claudeModels = readers.claudeModels ?? (() => anthropicModelDiscovery.ensure());
  const claude = await claudeModels();
  builder.add(
    CLAUDE_ROUTE, 'builtin',
    anthropicModelIds(claude, ANTHROPIC_MODELS), anthropicModelThinking(claude),
  );
}

/**
 * Routes known only from gateway.yaml. The shared `anthropic` section stands for Claude Code's
 * route (behind its credential gate) and, once PI's own mode is declared there, PI's provider.
 */
function addGatewayRoutes(
  builder: RouteBuilder, gatewayModes: Record<string, string[]>, claudeAvailable: boolean,
): void {
  for (const [endpoint, modes] of Object.entries(gatewayModes)) {
    if (endpoint !== ANTHROPIC_ENDPOINT) {
      builder.add(piRoute(endpoint), 'gateway', []);
      continue;
    }
    if (claudeAvailable) builder.add(CLAUDE_ROUTE, 'gateway', []);
    if (modes.includes(PI_ANTHROPIC_MODE)) builder.add(piRoute(endpoint), 'gateway', []);
  }
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
