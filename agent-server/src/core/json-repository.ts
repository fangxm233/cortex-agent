import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { atomicWrite } from './atomic-write.js';
import { withFileLock } from './file-lock.js';

const log = createLogger('json-repository');

export interface JsonRepoOptions<T> {
  filePath: string;
  defaultValue: () => T;
  /** Optional migration function. Called on every disk read; use to normalise legacy shapes without zod. */
  migrate?: (raw: unknown) => T;
  /** Serialize without pretty-printing. For multi-MB stores the indentation costs ~40% extra
   *  stringify CPU on every write (synchronous, blocks the event loop) — opt in for those. */
  compact?: boolean;
  /** Other processes write this file too: read() always reads the file, and mutate() holds a
   *  cross-process lock (core/file-lock) and re-reads the file inside it, so no reader sees a stale
   *  copy and no writer's update is lost. */
  sharedFile?: boolean;
}

interface Flushable {
  flush(): Promise<void>;
}

/** Everything the graceful shutdown drains: every JsonRepository, plus the stores that keep
 *  in-flight writes of their own outside one. */
const flushables = new Set<Flushable>();

/** Register a store whose pending writes a JsonRepository flush does not cover. */
export function registerFlushable(store: Flushable): void {
  flushables.add(store);
}

/** Drain every registered store's in-flight writes (SIGTERM, before exit). */
export async function flushAllRepositories(): Promise<void> {
  await Promise.allSettled([...flushables].map((store) => store.flush()));
}

export class JsonRepository<T> {
  private cache: T | null = null;
  private readonly mutex = new AsyncMutex();
  /** Fires the first-call orphan sweep exactly once per instance, on the first I/O op. */
  private sweepPromise: Promise<void> | null = null;

  constructor(private readonly opts: JsonRepoOptions<T>) {
    flushables.add(this);
  }

  /**
   * Delete any `<basename>.tmp.*` siblings of filePath.
   * `atomicWrite` (tmp → rename) can orphan its tmp when the process is SIGTERM'd mid-write
   * (e.g., daemon hot-reload landing during a long write). On next boot this sweeper clears them.
   * Runs lazily on the first read/mutate so repos that are constructed but never used pay nothing.
   */
  private async sweepOrphans(): Promise<void> {
    try {
      const dir = path.dirname(this.opts.filePath);
      const base = path.basename(this.opts.filePath);
      const prefix = `${base}.tmp.`;
      const entries = await fs.readdir(dir);
      await Promise.all(entries
        .filter((e) => e.startsWith(prefix))
        .map((e) => fs.unlink(path.join(dir, e)).catch(() => {}))
      );
    } catch {
      // Best-effort. Missing directory / permission errors must not break startup.
    }
  }

  private ensureSwept(): Promise<void> {
    if (!this.sweepPromise) this.sweepPromise = this.sweepOrphans();
    return this.sweepPromise;
  }

  /**
   * Return the current value.
   * Cache hit: zero I/O. Cache miss: reads file, parses JSON, applies migrate if present, and
   * persists a migration that changed the shape. Missing file returns and caches defaultValue().
   * A sharedFile repo always reads the file: another process may have written it since.
   */
  async read(): Promise<T> {
    if (this.cache !== null && !this.opts.sharedFile) return this.cache;
    // A shared file is swept only under its lock: another process may have a tmp in flight.
    if (!this.opts.sharedFile) await this.ensureSwept();
    const { value, migrated } = await this.load();
    if (!migrated) return (this.cache = value);
    if (this.opts.sharedFile) return this.mutate((cur) => ({ next: cur, result: cur }));
    await this.write(value);
    return value;
  }

  /** Read and parse the file without touching the cache. */
  private async load(): Promise<{ value: T; migrated: boolean }> {
    try {
      return this.parse(await fs.readFile(this.opts.filePath, 'utf8'));
    } catch (err: any) {
      if (err.code === 'ENOENT') return { value: this.opts.defaultValue(), migrated: false };
      if (err instanceof SyntaxError) return { value: await this.recoverCorrupt(err), migrated: false };
      throw err;
    }
  }

  private parse(raw: string): { value: T; migrated: boolean } {
    const parsed = JSON.parse(raw) as unknown;
    if (!this.opts.migrate) return { value: parsed as T, migrated: false };
    // Snapshot first: a migration may rewrite `parsed` in place.
    const before = JSON.stringify(parsed);
    const value = this.opts.migrate(parsed);
    return { value, migrated: before !== JSON.stringify(value) };
  }

  /** Corrupt JSON: preserve the original bytes under a .corrupt.<ts> sibling so they remain
   *  recoverable, warn loudly, then fall back to defaults. Subsequent writes atomically replace
   *  filePath; the .corrupt.* file stays put. */
  private async recoverCorrupt(err: SyntaxError): Promise<T> {
    const backupPath = `${this.opts.filePath}.corrupt.${Date.now()}`;
    try {
      await fs.copyFile(this.opts.filePath, backupPath);
      log.warn(`Corrupt JSON in ${this.opts.filePath} (${err.message}); backed up to ${backupPath}, resetting to defaults.`);
    } catch (copyErr: any) {
      log.warn(`Corrupt JSON in ${this.opts.filePath} (${err.message}); failed to back up (${copyErr?.message ?? copyErr}); resetting to defaults.`);
    }
    return this.opts.defaultValue();
  }

  /**
   * Atomically persist `next` and update the in-memory cache.
   * Does not hold the mutex — callers that need serialization should use mutate().
   */
  async write(next: T): Promise<void> {
    await this.ensureSwept();
    await atomicWrite(this.opts.filePath, this.serialize(next));
    this.cache = next;
  }

  private serialize(value: T): string {
    return this.opts.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  }

  /**
   * Wait until any in-flight `mutate()` has fully completed (tmp written + rename landed).
   * Acquire-release the mutex without doing any work; FIFO ordering guarantees that once this
   * resolves, every operation enqueued before flush() has finished.
   * Intended for graceful SIGTERM handlers to drain writes before `process.exit(0)`.
   */
  async flush(): Promise<void> {
    await this.mutex.run(async () => { /* no-op: presence of the task serialises behind any pending mutate */ });
  }

  /**
   * Mutex-serialized read-modify-write.
   * `fn` receives the current value and must return `{ next, result }`.
   * Returns the `result` value from `fn`.
   * A sharedFile repo also holds the file's cross-process lock for the whole cycle and re-reads the
   * file inside it, so a concurrent writer in another process is neither overwritten nor lost.
   */
  async mutate<R>(fn: (cur: T) => { next: T; result: R }): Promise<R> {
    return this.mutex.run(() => this.underFileLock(async () => {
      await this.ensureSwept();
      const cur = this.cache !== null && !this.opts.sharedFile ? this.cache : (await this.load()).value;
      const { next, result } = fn(cur);
      await this.write(next);
      return result;
    }));
  }

  private underFileLock<R>(op: () => Promise<R>): Promise<R> {
    return this.opts.sharedFile ? withFileLock(this.opts.filePath, op) : op();
  }

  /** Drop the in-memory cache so the next read() fetches from disk. */
  invalidate(): void {
    this.cache = null;
  }
}
