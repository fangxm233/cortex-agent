import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import { atomicWriteSync } from '@core/atomic-write.js';
import { discoverEndpoints, writeMergedGatewayYaml, type DiscoveredEndpoint } from '@core/gateway-generator.js';
import { generateModels, mergeModelsJson, readExistingModels, recommendedChoice } from '@core/models-generator.js';
import { CONFIG_DIR } from '@core/paths.js';
import type { ModelRef } from '../agents/engine-selection.js';

const log = createLogger('gateway-sync');
export interface GatewaySyncResult {
  configured: boolean;
  endpoints: number;
  /** Whether this sync supplied a previously missing default. */
  defaultSet: boolean;
  /** Favorites actually present after the sync. */
  favorites: ModelRef[];
  reason?: string;
}
export interface GatewaySyncOptions {
  backends?: string[];
  configDir?: string;
  gatewayConfigDir?: string;
  discover?: (backends?: string[]) => DiscoveredEndpoint[] | Promise<DiscoveredEndpoint[]>;
}

function syncModels(endpoints: DiscoveredEndpoint[], configDir: string): Pick<GatewaySyncResult, 'defaultSet' | 'favorites'> {
  const saved = readExistingModels(configDir);
  const groups = new Set((saved?.favorites ?? []).map(ref => JSON.stringify([ref.backend, ref.provider])));
  const generated = generateModels(endpoints);
  generated.favorites = [];
  for (const endpoint of endpoints) {
    if (!recommendedChoice([endpoint])) continue;
    const ref = generateModels([endpoint]).favorites[0];
    const group = JSON.stringify([ref.backend, ref.provider]);
    if (groups.has(group)) continue;
    generated.favorites.push(ref);
    groups.add(group);
  }
  const merged = mergeModelsJson(generated, configDir);
  atomicWriteSync(path.join(configDir, 'models.json'), JSON.stringify(merged, null, 2) + '\n');
  return { defaultSet: !saved?.default, favorites: merged.favorites };
}

/** Add newly connected backend/provider groups without changing an existing default. Never fails login. */
export async function syncGatewayFromBackends(options: GatewaySyncOptions = {}): Promise<GatewaySyncResult> {
  try {
    const endpoints = await (options.discover ?? discoverEndpoints)(options.backends);
    if (!endpoints.some(endpoint => endpoint.models.length > 0)) {
      return { configured: false, endpoints: 0, defaultSet: false, favorites: [], reason: 'no-endpoints' };
    }
    writeMergedGatewayYaml(endpoints, options.gatewayConfigDir);
    const result = syncModels(endpoints, options.configDir ?? CONFIG_DIR);
    log.info(`Synced ${endpoints.length} endpoint(s) → ${result.favorites.length} favorite model(s)`);
    return { configured: true, endpoints: endpoints.length, ...result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`Gateway sync skipped: ${reason}`);
    return { configured: false, endpoints: 0, defaultSet: false, favorites: [], reason };
  }
}
