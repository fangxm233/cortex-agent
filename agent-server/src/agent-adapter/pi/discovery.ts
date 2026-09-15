import { CachedScan } from '@core/cached-scan.js';
import { scanPiAvailableModels, type PiDiscoveredModel } from '@core/gateway-generator.js';
import { createLogger } from '@core/log.js';

// Filename lookup moved out so a trial adapter can resolve a transcript path without importing
// this module's host-scanning provider singleton (design §13 A7/A8, T12).
export { findPISessionFilePath } from './session-files.js';

const log = createLogger('pi-adapter');

export const PI_PROVIDER_CACHE_TTL_MS = 5 * 60_000;
export const PI_PROVIDER_RETRY_MS = 30_000;
/** How long a caller that actually needs the list (a model picker) waits for a cold scan. Loading
 *  the PI SDK is seconds of module work; beyond this the caller takes the empty answer and asks
 *  again rather than holding a UI request open — `piPending` tells it the list is still short. */
export const PI_PROVIDER_ENSURE_TIMEOUT_MS = 12_000;

type ModelScan = () => Promise<PiDiscoveredModel[]>;

export interface PIProviderDiscovery {
  getProviders(): string[];
  getModels(): PiDiscoveredModel[];
  /**
   * The cached pairs with NO scan kicked.
   *
   * A scan loads the PI SDK (~100 MB, seconds of module loading — see `core/pi-sdk.ts`), which a
   * caller that merely decorates something with PI's models must not provoke: a Claude-only host
   * would pay for a backend it never uses. Such callers peek and accept an empty answer until a
   * path that genuinely needs PI has warmed the cache.
   */
  peekModels(): PiDiscoveredModel[];
  /**
   * The pairs, waiting for a scan only when there is nothing to show — for callers whose whole
   * purpose IS the list (the Web model picker), where an empty first answer would only become a
   * spinner. A warm cache answers at once; a scan that is already failing is not waited on.
   */
  ensureModels(timeoutMs?: number): Promise<PiDiscoveredModel[]>;
  refresh(): void;
}

export interface PIProviderDiscoveryOptions {
  scan?: ModelScan;
  now?: () => number;
  cacheTtlMs?: number;
  retryMs?: number;
}

/** Discover authenticated PI providers from PI's own agent dir, never Cortex's private one. */
export async function discoverPIProviders(
  scanModels: () => Promise<Array<{ provider: string }>> = scanPiAvailableModels,
): Promise<string[]> {
  const models = await scanModels();
  return Array.from(new Set(models.map((model) => model.provider)));
}

export function createPIProviderDiscovery(
  options: PIProviderDiscoveryOptions = {},
): PIProviderDiscovery {
  // The caching itself — TTL, failure backoff, single-flight refresh, defensive copies — is
  // `core/cached-scan`; what stays here is what is PI-specific: the scan, the provider view, and
  // the (provider, model) identity two scans are deduplicated by.
  const cache = new CachedScan<PiDiscoveredModel>({
    scan: options.scan ?? scanPiAvailableModels,
    now: options.now,
    cacheTtlMs: options.cacheTtlMs ?? PI_PROVIDER_CACHE_TTL_MS,
    retryMs: options.retryMs ?? PI_PROVIDER_RETRY_MS,
    key: (model) => `${model.provider}\u0000${model.model}`,
    clone: (model) => ({ ...model }),
    logFailure: (message) => log.info(`PI provider refresh failed: ${message}`),
  });
  const getModels = (): PiDiscoveredModel[] => cache.get();
  return {
    getProviders: () => Array.from(new Set(getModels().map((model) => model.provider))),
    getModels,
    peekModels: () => cache.peek(),
    ensureModels: (timeoutMs: number = PI_PROVIDER_ENSURE_TIMEOUT_MS) => cache.ensure(timeoutMs),
    refresh: () => cache.refresh(),
  };
}

export const piProviderDiscovery = createPIProviderDiscovery();
