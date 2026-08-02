// input:  JsonRepoOptions<T> (filePath, defaultValue, migrate?, compact?)
// output: JsonRepository<T> — read / write / mutate / invalidate
// pos:    unified file-backed JSON store with in-memory cache and AsyncMutex serialization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { atomicWrite } from './atomic-write.js';

const log = createLogger('json-repository');

export interface JsonRepoOptions<T> {
  filePath: string;
  defaultValue: () => T;
  /** Optional migration function. Called on every disk read; use to normalise legacy shapes without zod. */
  migrate?: (raw: unknown) => T;
  /** Serialize without pretty-printing. For multi-MB stores the indentation costs ~40% extra
   *  stringify CPU on every write (synchronous, blocks the event loop) — opt in for those. */
  compact?: boolean;
}

export class JsonRepository<T> {
  private cache: T | null = null;
  private readonly mutex = new AsyncMutex();
  /** Fires the first-call orphan sweep exactly once per instance, on the first I/O op. */
  private sweepPromise: Promise<void> | null = null;

  constructor(private readonly opts: JsonRepoOptions<T>) {}

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
   * Cache hit: zero I/O. Cache miss: reads file, parses JSON, applies migrate if present.
   * Missing file returns and caches defaultValue().
   */
  async read(): Promise<T> {
    if (this.cache !== null) return this.cache;
    await this.ensureSwept();
    try {
      const raw = await fs.readFile(this.opts.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (this.opts.migrate) {
        const migrated = this.opts.migrate(parsed);
        // Persist migrated data back to disk so the new shape survives
        // across restarts even when no mutate() follows.
        if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
          await atomicWrite(this.opts.filePath, this.serialize(migrated));
        }
        this.cache = migrated;
      } else {
        this.cache = parsed as T;
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.cache = this.opts.defaultValue();
      } else if (err instanceof SyntaxError) {
        // Corrupt JSON — preserve the original bytes under a .corrupt.<ts> sibling
        // so they remain recoverable, warn loudly, then fall back to defaults.
        // Subsequent writes will atomically replace filePath; the .corrupt.* file stays put.
        const backupPath = `${this.opts.filePath}.corrupt.${Date.now()}`;
        try {
          await fs.copyFile(this.opts.filePath, backupPath);
          log.warn(`Corrupt JSON in ${this.opts.filePath} (${err.message}); backed up to ${backupPath}, resetting to defaults.`);
        } catch (copyErr: any) {
          log.warn(`Corrupt JSON in ${this.opts.filePath} (${err.message}); failed to back up (${copyErr?.message ?? copyErr}); resetting to defaults.`);
        }
        this.cache = this.opts.defaultValue();
      } else {
        throw err;
      }
    }
    return this.cache!;
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
   */
  async mutate<R>(fn: (cur: T) => { next: T; result: R }): Promise<R> {
    return this.mutex.run(async () => {
      const cur = await this.read();
      const { next, result } = fn(cur);
      await this.write(next);
      return result;
    });
  }

  /** Drop the in-memory cache so the next read() fetches from disk. */
  invalidate(): void {
    this.cache = null;
  }
}
