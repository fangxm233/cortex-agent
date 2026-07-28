// input:  fs, device identity, CortexMDEntry[], session id
// output: CortexMDInjector class + shared cache singleton
// pos:    Deduplicates local and remote CORTEX.md injection state
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'fs';
import * as path from 'path';
import { WORKSPACE_DIR } from '@core/utils.js';

export interface CortexMDEntry {
  path: string;
  content: string;
  mtimeMs: number;
  deviceId?: string;
}

export interface CortexMDBlock {
  type: 'text';
  text: string;
}

const DEFAULT_CACHE_DIR = path.join(WORKSPACE_DIR, 'cortexmd-cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 250;
const LOCK_STALE_MS = 5000;
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function resolveCacheFile(cacheDir: string, sessionId: string | undefined): string | null {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  return path.join(cacheDir, `${sessionId}.json`);
}

function maintainCacheDir(cacheDir: string): void {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(cacheDir)) {
      const filePath = path.join(cacheDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && now - stat.mtimeMs > CACHE_TTL_MS) {
          fs.rmSync(filePath, { force: true });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function readCache(cacheFile: string): Map<string, number> {
  const cache = new Map<string, number>();
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return cache;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'number') cache.set(key, value);
    }
  } catch { /* missing/corrupt — start fresh */ }
  return cache;
}

function writeCache(cacheFile: string, cache: Map<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tempFile = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(Object.fromEntries(cache)), 'utf8');
    fs.renameSync(tempFile, cacheFile);
  } catch { /* degrade gracefully */ }
}

function removeStaleLock(lockFile: string): void {
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) fs.rmSync(lockFile, { force: true });
  } catch { /* ignore */ }
}

function acquireLock(lockFile: string): number | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  do {
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      return fs.openSync(lockFile, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      removeStaleLock(lockFile);
      Atomics.wait(LOCK_SLEEP, 0, 0, 5);
    }
  } while (Date.now() <= deadline);
  return null;
}

function releaseLock(lockFile: string, descriptor: number): void {
  try { fs.closeSync(descriptor); } catch { /* ignore */ }
  try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
}

function cacheKey(device: string, entry: CortexMDEntry): string {
  const physicalDevice = entry.deviceId?.trim() || device;
  return `${physicalDevice.toLowerCase()}:${entry.path}`;
}

export interface CortexMDInjectorOptions {
  sessionId?: string;
  cacheDir?: string;
  cacheFile?: string | null;
}

interface CacheResult<T> {
  value: T;
  changed: boolean;
}

export class CortexMDInjector {
  private readonly memoryCache = new Map<string, number>();
  private readonly cacheFile: string | null;

  constructor(options: CortexMDInjectorOptions = {}) {
    const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.cacheFile = options.cacheFile !== undefined
      ? options.cacheFile
      : resolveCacheFile(cacheDir, options.sessionId ?? process.env.CORTEX_SESSION_ID);
    maintainCacheDir(cacheDir);
  }

  private transact<T>(operation: (cache: Map<string, number>) => CacheResult<T>): T {
    if (!this.cacheFile) return operation(this.memoryCache).value;
    const lockFile = `${this.cacheFile}.lock`;
    const descriptor = acquireLock(lockFile);
    const cache = readCache(this.cacheFile);
    const result = operation(cache);
    if (descriptor === null) return result.value;
    try {
      if (result.changed) writeCache(this.cacheFile, cache);
      return result.value;
    } finally {
      releaseLock(lockFile, descriptor);
    }
  }

  buildBlocks(device: string, entries: CortexMDEntry[], markOnlyPaths?: Set<string>): CortexMDBlock[] {
    if (!entries || entries.length === 0) return [];
    return this.transact((cache) => {
      const blocks: CortexMDBlock[] = [];
      let changed = false;
      for (const entry of entries) {
        const key = cacheKey(device, entry);
        if (cache.get(key) === entry.mtimeMs) continue;
        cache.set(key, entry.mtimeMs);
        changed = true;
        if (markOnlyPaths?.has(entry.path)) continue;
        blocks.push({ type: 'text', text: this.formatBlock(device, entry) });
      }
      return { value: blocks, changed };
    });
  }

  private formatBlock(device: string, entry: CortexMDEntry): string {
    return `<system-reminder>\n` +
      `Auto-loaded CORTEX.md from ${device}:${entry.path} ` +
      `(ancestor of accessed path on remote device). ` +
      `These instructions apply to files under this directory on that device.\n\n` +
      entry.content +
      `\n</system-reminder>`;
  }
}

let defaultCortexInjector: CortexMDInjector | null = null;

export function getDefaultCortexInjector(): CortexMDInjector {
  if (!defaultCortexInjector) defaultCortexInjector = new CortexMDInjector();
  return defaultCortexInjector;
}
