import { ANTHROPIC_MODELS } from '@core/anthropic-models.js';
import { readGatewayYaml } from '@core/gateway-generator.js';
import {
  defaultCustomProviderStores,
  listCustomProviders,
  GATEWAY_CONFIG_PATH,
  type CustomProviderView,
} from '@domain/pi-providers/index.js';
import { piProviderDiscovery } from '../../../agent-adapter/pi/discovery.js';
import { THINKING_LEVELS_BY_BACKEND } from '@domain/agents/profile-manager.js';
import type { ModelCatalogRoute, ModelCatalogSnapshot, ModelsCatalogParams, UiServiceDeps } from '../types.js';

/**
 * The catalog is a UNION, never an intersection: a profile must stay writable for an endpoint the
 * host cannot currently enumerate (PI reports only providers with usable auth, and a scan can fail
 * outright). Every source therefore only ADDS — an endpoint known solely from gateway.yaml still
 * appears, with an empty model list, and the editor falls back to free text for it.
 *
 * Deliberately its own query rather than a field of the high-frequency `config.get`: reading PI's
 * models loads the bundled SDK (~100 MB, see core/pi-sdk.ts), a cost only a caller that actually
 * wants the catalog should pay.
 */

/** The Claude endpoint is a constant of the backend, not a discovery result. */
const CLAUDE_ENDPOINT = 'anthropic';

/** Mirrors gateway-generator's rule for a PI provider with no gateway section: mode = endpoint. */
function defaultModes(endpoint: string, backend: 'claude' | 'pi'): string[] {
  return backend === 'claude' ? ['plan'] : [endpoint];
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

class RouteBuilder {
  private readonly routes = new Map<string, ModelCatalogRoute>();

  constructor(private readonly gatewayModes: Record<string, string[]>) {}

  add(
    endpoint: string,
    backend: 'claude' | 'pi',
    source: ModelCatalogRoute['source'],
    models: readonly string[],
    modelThinking: Record<string, string[]> = {},
  ): void {
    const existing = this.routes.get(endpoint);
    if (existing) {
      // A later source only contributes model ids it is the first to know about; the route's own
      // identity (backend, provider, source) is owned by whoever declared it first.
      for (const model of models) if (!existing.models.includes(model)) existing.models.push(model);
      for (const [model, levels] of Object.entries(modelThinking)) {
        if (!(model in existing.modelThinking)) existing.modelThinking[model] = levels;
      }
      return;
    }
    this.routes.set(endpoint, {
      endpoint,
      backend,
      provider: backend === 'pi' ? endpoint : null,
      modes: this.gatewayModes[endpoint] ?? defaultModes(endpoint, backend),
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
  /** The PI pairs, waiting out a cold scan. Defaults to the host discovery singleton. */
  piModels?: () => Promise<Array<{ provider: string; model: string; thinkingLevels?: string[] }>>;
  /** The cached PI pairs with NO refresh kicked — used only to report `piPending`. */
  piPeek?: () => Array<{ provider: string; model: string }>;
  customProviders?: () => CustomProviderView[];
  gatewayModes?: GatewayReader;
}

export async function handleModelsCatalog(
  deps: UiServiceDeps,
  _params: ModelsCatalogParams,
  readers: ModelsCatalogReaders = {},
): Promise<ModelCatalogSnapshot> {
  const piModels = readers.piModels ?? (() => piProviderDiscovery.ensureModels());
  const piPeek = readers.piPeek ?? (() => piProviderDiscovery.peekModels());
  const customProviders =
    readers.customProviders
    ?? (() => listCustomProviders(deps.customProviderStores ?? defaultCustomProviderStores()));
  const gatewayModes = (readers.gatewayModes ?? readGatewayModes)();

  const builder = new RouteBuilder(gatewayModes);
  builder.add(CLAUDE_ENDPOINT, 'claude', 'builtin', ANTHROPIC_MODELS);

  // `ensureModels()` waits out a COLD scan (bounded) and serves a warm cache at once: a picker's
  // whole purpose is the list, so an empty first answer would only become a spinner. A scan that
  // is still failing is not retried here — it left a backoff, and `piPending` reports the gap.
  const discovered = await piModels();
  const byProvider = new Map<string, string[]>();
  const thinkingByProvider = new Map<string, Record<string, string[]>>();
  for (const pair of discovered) {
    const models = byProvider.get(pair.provider) ?? [];
    if (!models.includes(pair.model)) models.push(pair.model);
    byProvider.set(pair.provider, models);
    if (pair.thinkingLevels) {
      const levels = thinkingByProvider.get(pair.provider) ?? {};
      levels[pair.model] = pair.thinkingLevels;
      thinkingByProvider.set(pair.provider, levels);
    }
  }
  for (const [provider, models] of byProvider) {
    builder.add(provider, 'pi', 'pi', models, thinkingByProvider.get(provider) ?? {});
  }

  for (const provider of customProviders()) {
    builder.add(provider.name, 'pi', 'custom', provider.models.map((model) => model.id));
  }

  for (const endpoint of Object.keys(gatewayModes)) {
    builder.add(endpoint, endpoint === CLAUDE_ENDPOINT ? 'claude' : 'pi', 'gateway', []);
  }

  return {
    routes: builder.build(),
    piPending: piPeek().length === 0,
    thinkingLevels: { claude: [...THINKING_LEVELS_BY_BACKEND.claude], pi: [...THINKING_LEVELS_BY_BACKEND.pi] },
  };
}
