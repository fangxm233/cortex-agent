import { CachedScan } from '@core/cached-scan.js';
import { createLogger } from '@core/log.js';
import { scanUserPiModels, type PiDiscoveredModel } from './model-scan.js';

export type { PiDiscoveredModel } from './model-scan.js';

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
  /** Rescan now and wait (bounded) for the result: for a caller that just changed PI's auth. */
  rescan(timeoutMs?: number): Promise<PiDiscoveredModel[]>;
}

export interface PIProviderDiscoveryOptions {
  scan?: ModelScan;
  now?: () => number;
  cacheTtlMs?: number;
  retryMs?: number;
}

export function createPIProviderDiscovery(
  options: PIProviderDiscoveryOptions = {},
): PIProviderDiscovery {
  // The caching itself — TTL, failure backoff, single-flight refresh, defensive copies — is
  // `core/cached-scan`; what stays here is what is PI-specific: the scan, the provider view, and
  // the (provider, model) identity two scans are deduplicated by.
  const cache = new CachedScan<PiDiscoveredModel>({
    scan: options.scan ?? scanUserPiModels,
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
    rescan: (timeoutMs: number = PI_PROVIDER_ENSURE_TIMEOUT_MS) => cache.settle(timeoutMs),
  };
}

/** What the daemon's scan reads. PI's own home until the host wires the catalog its sessions run
 *  with (`domain/runs/adapters`), so a process that never runs a PI session still gets a list. */
let hostScan: ModelScan = scanUserPiModels;

/** Point the shared scan at the host's PI catalog. The next scan uses it; refresh to apply now. */
export function setPiModelScan(scan: ModelScan): void {
  hostScan = scan;
}

export const piProviderDiscovery = createPIProviderDiscovery({ scan: () => hostScan() });
