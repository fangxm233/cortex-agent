// input:  PI SDK model scan, refresh requests, session filenames
// output: refreshable provider/model-pair cache and filename session lookup
// pos:    PI provider, model-pair, and resume-target discovery
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { scanPiAvailableModels, type PiDiscoveredModel } from '@core/gateway-generator.js';
import { createLogger } from '@core/log.js';

// Filename lookup moved out so a trial adapter can resolve a transcript path without importing
// this module's host-scanning provider singleton (design §13 A7/A8, T12).
export { findPISessionFilePath } from './session-files.js';

const log = createLogger('pi-adapter');

export const PI_PROVIDER_CACHE_TTL_MS = 5 * 60_000;
export const PI_PROVIDER_RETRY_MS = 30_000;

type ModelScan = () => Promise<PiDiscoveredModel[]>;

export interface PIProviderDiscovery {
  getProviders(): string[];
  getModels(): PiDiscoveredModel[];
  /** The cached pairs with no refresh side effect — see {@link CachedPIProviderDiscovery.peekModels}. */
  peekModels(): PiDiscoveredModel[];
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

class CachedPIProviderDiscovery implements PIProviderDiscovery {
  private models: PiDiscoveredModel[] = [];
  private nextRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  private refreshQueued = false;

  constructor(
    private readonly scan: ModelScan,
    private readonly now: () => number,
    private readonly cacheTtlMs: number,
    private readonly retryMs: number,
  ) {}

  getProviders(): string[] {
    return Array.from(new Set(this.getModels().map((model) => model.provider)));
  }

  getModels(): PiDiscoveredModel[] {
    const snapshot = this.peekModels();
    if (this.now() >= this.nextRefreshAt && !this.inFlight) this.startRefresh();
    return snapshot;
  }

  /**
   * The snapshot alone, with no refresh kicked.
   *
   * A scan loads the PI SDK (~100 MB, seconds of module loading — see `core/pi-sdk.ts`), which a
   * caller that merely decorates something with PI's models must not provoke: a Claude-only host
   * would pay for a backend it never uses. Such callers peek and accept an empty answer until a
   * path that genuinely needs PI has warmed the cache.
   */
  peekModels(): PiDiscoveredModel[] {
    return this.models.map((model) => ({ ...model }));
  }

  refresh(): void {
    if (!this.inFlight) {
      this.startRefresh();
      return;
    }
    this.refreshQueued = true;
  }

  private startRefresh(): void {
    const refresh = Promise.resolve()
      .then(this.scan)
      .then((models) => this.accept(models))
      .catch((error: unknown) => this.reject(error))
      .finally(() => this.finishRefresh(refresh));
    this.inFlight = refresh;
  }

  private finishRefresh(refresh: Promise<void>): void {
    if (this.inFlight !== refresh) return;
    this.inFlight = null;
    if (!this.refreshQueued) return;
    this.refreshQueued = false;
    this.startRefresh();
  }

  private accept(models: PiDiscoveredModel[]): void {
    const seen = new Set<string>();
    const deduped: PiDiscoveredModel[] = [];
    for (const model of models) {
      const key = `${model.provider}\u0000${model.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...model });
    }
    this.models = deduped;
    this.nextRefreshAt = this.now() + this.cacheTtlMs;
  }

  private reject(error: unknown): void {
    this.nextRefreshAt = this.now() + this.retryMs;
    const message = error instanceof Error ? error.message : 'unknown';
    log.info(`PI provider refresh failed: ${message}`);
  }
}

export function createPIProviderDiscovery(
  options: PIProviderDiscoveryOptions = {},
): PIProviderDiscovery {
  return new CachedPIProviderDiscovery(
    options.scan ?? scanPiAvailableModels,
    options.now ?? Date.now,
    options.cacheTtlMs ?? PI_PROVIDER_CACHE_TTL_MS,
    options.retryMs ?? PI_PROVIDER_RETRY_MS,
  );
}

export const piProviderDiscovery = createPIProviderDiscovery();
