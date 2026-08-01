// input:  PI model table, refresh requests, session filenames
// output: refreshable provider cache and filename session lookup
// pos:    PI provider and resume-target discovery
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { execFile } from 'child_process';
import { readdirSync } from 'fs';
import * as path from 'path';

import { parsePiListModelsOutput } from '@core/gateway-generator.js';
import { selectPISessionFilename } from '@core/pi-session-filename.js';
import { createLogger } from '@core/log.js';

const log = createLogger('pi-adapter');

export const PI_PROVIDER_CACHE_TTL_MS = 5 * 60_000;
export const PI_PROVIDER_RETRY_MS = 30_000;

type ProviderScan = () => Promise<string[]>;

export interface PIProviderDiscovery {
  getProviders(): string[];
  refresh(): void;
}

export interface PIProviderDiscoveryOptions {
  scan?: ProviderScan;
  now?: () => number;
  cacheTtlMs?: number;
  retryMs?: number;
}

/** Discover authenticated PI providers without inheriting Cortex's private agent directory. */
export function discoverPIProviders(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('pi', ['--list-models'], {
      timeout: 10_000,
      encoding: 'utf-8',
      env: { ...process.env, PI_CODING_AGENT_DIR: '' },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      const models = parsePiListModelsOutput(`${stdout}\n${stderr}`);
      resolve(Array.from(new Set(models.map((model) => model.provider))));
    });
  });
}

class CachedPIProviderDiscovery implements PIProviderDiscovery {
  private providers: string[] = [];
  private nextRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  private refreshQueued = false;

  constructor(
    private readonly scan: ProviderScan,
    private readonly now: () => number,
    private readonly cacheTtlMs: number,
    private readonly retryMs: number,
  ) {}

  getProviders(): string[] {
    const snapshot = [...this.providers];
    if (this.now() >= this.nextRefreshAt && !this.inFlight) this.startRefresh();
    return snapshot;
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
      .then((providers) => this.accept(providers))
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

  private accept(providers: string[]): void {
    this.providers = Array.from(new Set(providers));
    this.nextRefreshAt = this.now() + this.cacheTtlMs;
  }

  private reject(error: unknown): void {
    this.nextRefreshAt = this.now() + this.retryMs;
    const message = error instanceof Error ? error.message : 'unknown';
    log.info(`pi --list-models refresh failed: ${message}`);
  }
}

export function createPIProviderDiscovery(
  options: PIProviderDiscoveryOptions = {},
): PIProviderDiscovery {
  return new CachedPIProviderDiscovery(
    options.scan ?? discoverPIProviders,
    options.now ?? Date.now,
    options.cacheTtlMs ?? PI_PROVIDER_CACHE_TTL_MS,
    options.retryMs ?? PI_PROVIDER_RETRY_MS,
  );
}

export const piProviderDiscovery = createPIProviderDiscovery();

/** Resolve PI's exact id-bearing filename without opening transcript bodies. */
export function findPISessionFilePath(sessionDir: string, sessionId: string): string | null {
  if (!sessionId) return null;
  try {
    const filename = selectPISessionFilename(readdirSync(sessionDir), sessionId);
    return filename ? path.join(sessionDir, filename) : null;
  } catch {
    return null;
  }
}
