// input:  threads.json persistence file
// output: { threadStore } — Thread state in-memory cache + coalesced atomic persistence
// pos:    Thread persistence layer: CRUD + queries; cleanup archives old terminal threads to JSONL
// >>> If I am updated, update my header comment and CORTEX.md <<<

import * as path from 'path';
import * as crypto from 'crypto';
import { readFileSync, rmSync } from 'fs';
import { appendFile, mkdir } from 'fs/promises';
import { JsonRepository } from '@core/json-repository.js';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { STORE_DIR } from '@core/paths.js';
import { scanAllTasks } from '@core/task-parser.js';

const log = createLogger('thread-store');
import type { ThreadRecord, ThreadId, ThreadStatus } from '@core/types/thread-types.js';

const THREADS_FILE = path.join(STORE_DIR, 'threads.json');
const THREADS_ARCHIVE_FILE = path.join(STORE_DIR, 'archive', 'threads-archive.jsonl');

class ThreadRepo {
  /** In-memory source of truth for all thread records. All sync reads come from here. */
  private map = new Map<string, ThreadRecord>();
  private repo = new JsonRepository<Record<string, ThreadRecord>>({
    filePath: THREADS_FILE,
    defaultValue: () => ({}),
    compact: true, // multi-MB store: pretty-printing costs ~40% extra sync stringify per write
  });
  /** Serializes all persist operations (set, delete, mutate, lifecycle). */
  private mutex = new AsyncMutex();
  /** Promise chain for `set()`/`delete()`-initiated persists, guarded by this.mutex. */
  private _pendingPersist: Promise<void> = Promise.resolve();
  /** True while a persist is queued but not yet snapshotting — lets queuePersist coalesce. */
  private _persistQueued = false;

  // --- Lifecycle ---

  /** Load threads from disk into memory. Populates the Map from threads.json. */
  load(): void {
    try {
      const data = JSON.parse(readFileSync(THREADS_FILE, 'utf8'));
      this.map.clear();
      for (const [id, record] of Object.entries(data)) {
        this.map.set(id, record as ThreadRecord);
      }
      log.info(`Loaded ${this.map.size} threads`);
    } catch {
      this.map.clear();
    }
  }

  // --- ID generation ---

  generateId(): ThreadId {
    const rand = crypto.randomBytes(4).toString('hex');
    return `thr_${rand}`;
  }

  // --- CRUD ---

  get(id: ThreadId): ThreadRecord | null {
    return this.map.get(id) || null;
  }

  /**
   * Insert or replace a thread record. Updates `updatedAt` and queues a persist.
   * Map update is synchronous; disk write is queued through the mutex.
   * Returns the persist promise for callers that need to await it.
   */
  set(record: ThreadRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    this.map.set(record.id, record);
    return this.queuePersist();
  }

  /** Remove a thread and queue a persist. */
  delete(id: ThreadId): Promise<void> {
    this.map.delete(id);
    return this.queuePersist();
  }

  /**
   * Mutate a single thread's record in-place, updating `updatedAt` and persisting.
   * Awaits any pending `set()`/`delete()` persists, then acquires the mutex for
   * a serialized read-modify-write.
   */
  async mutate(id: ThreadId, fn: (t: ThreadRecord) => void): Promise<void> {
    await this._pendingPersist;
    await this.mutex.run(async () => {
      const thread = this.map.get(id);
      if (!thread) return;
      fn(thread);
      thread.updatedAt = new Date().toISOString();
      this.map.set(id, thread);
      await this.persist();
    });
  }

  /** Await all pending `set()`/`delete()` disk writes AND any in-flight `mutate()`.
   *  For graceful SIGTERM drain and test cleanup.
   *  Two awaits because set/delete queue through _pendingPersist while mutate/cleanup/
   *  markRunningAsFailedOnStartup acquire this.mutex directly after awaiting the chain. */
  async flush(): Promise<void> {
    await this._pendingPersist;
    await this.mutex.run(async () => { /* acquire-release: waits for any in-flight mutate */ });
  }

  // --- Queries ---

  findByChannel(channel: string): ThreadRecord[] {
    const results: ThreadRecord[] = [];
    for (const record of this.map.values()) {
      if (record.channel === channel) results.push(record);
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  findByProject(projectId: string): ThreadRecord[] {
    const results: ThreadRecord[] = [];
    for (const record of this.map.values()) {
      if (record.projectId === projectId) results.push(record);
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  findByPlatformThread(channel: string, platformThreadId: string): ThreadRecord | null {
    for (const record of this.map.values()) {
      if (record.channel === channel && record.platformThreadId === platformThreadId) {
        return record;
      }
    }
    return null;
  }

  findActive(channel: string): ThreadRecord | null {
    for (const record of this.map.values()) {
      if (record.channel === channel && (record.status === 'running' || record.status === 'waiting')) {
        return record;
      }
    }
    return null;
  }

  getAll(): ThreadRecord[] {
    return Array.from(this.map.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- Lifecycle helpers ---

  /** Does this waiting record still await any live (open/pending, unblocked) child TASK?
   *  Reads TASKS.yaml via the zero-dependency core parser (store → core is layer-legal). */
  private hasLiveTaskChildren(record: ThreadRecord): boolean {
    const ids = record.metadata?.waitingOnTasks;
    const project = record.metadata?.taskProject;
    if (!ids?.length || !project) return false;
    try {
      const waiting = new Set(ids);
      return scanAllTasks(project).some((t) => waiting.has(t.id) && t.status !== 'done' && !t.blocked_by);
    } catch {
      return false;
    }
  }

  async markRunningAsFailedOnStartup(): Promise<number> {
    await this._pendingPersist;
    return this.mutex.run(async () => {
      let count = 0;
      for (const record of this.map.values()) {
        // Suspended parents (waiting on child threads, DR-0014) survive restarts —
        // recoverWaitingThreads() re-delivers child results after startup. childThreadIds
        // also qualifies: a parent that delivered its last child result but crashed before
        // re-entry has empty wait sets yet must still be recovered, not failed. Only
        // in-flight running threads and legacy waiting (no owned wait state) are interrupted.
        const hasTaskWaitState = !!record.metadata?.taskId
          && Array.isArray(record.metadata.waitingOnTasks);
        const isSuspendedParent = record.status === 'waiting'
          && !!(record.metadata?.waitingOn?.length || record.metadata?.childThreadIds?.length
            || hasTaskWaitState);
        if (isSuspendedParent) continue;
        // Rate-limit-paused threads survive restarts: the throttle re-arms its resume timer (or
        // fires immediately if the window already passed) and resume-dispatcher re-enters them.
        if (record.status === 'rate_limited') continue;
        if (record.status === 'running' || record.status === 'waiting') {
          record.status = 'failed';
          record.error = 'Interrupted by server restart';
          record.endedAt = new Date().toISOString();
          record.updatedAt = new Date().toISOString();
          count++;
        }
      }
      if (count > 0) {
        await this.persist();
        log.info(`Marked ${count} interrupted threads as failed`);
      }
      return count;
    });
  }

  /** Archive terminal threads older than maxAge (default 7 days) to the JSONL archive and
   *  remove their workspace directories. Records are moved, never discarded. Auto-records
   *  (no workspace) use a shorter 24h TTL since they only need to survive !thread add chaining. */
  async cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    await this._pendingPersist;
    return this.mutex.run(async () => {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
      const autoRecordCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let count = 0;
      let staleWaiting = 0;
      for (const record of this.map.values()) {
        // Leak safety net (DR-0014): a parent stuck in waiting beyond maxAge has lost its
        // children (records purged / callbacks dropped). This is ORPHAN detection, not an
        // age limit: a manager waiting on a multi-day child TASK (e.g. a long training run,
        // DR-0014 §8) is legitimately silent — spare it while any awaited task is still
        // open/pending in TASKS.yaml. Fail true orphans; the next cleanup cycle
        // garbage-collects them through the normal terminal path below.
        if (record.status === 'waiting' && record.updatedAt < cutoff) {
          if (this.hasLiveTaskChildren(record)) continue;
          record.status = 'failed';
          record.error = 'stale waiting parent — children never completed';
          record.endedAt = new Date().toISOString();
          record.updatedAt = new Date().toISOString();
          staleWaiting++;
        }
        // Limbo safety net: a rate-limit-paused thread that never got resumed (auto-resume
        // disabled, or the window-reset resume was dropped) is failed once past maxAge so it
        // does not linger forever.
        if (record.status === 'rate_limited' && record.updatedAt < cutoff) {
          record.status = 'failed';
          record.error = 'rate-limit-paused thread never resumed';
          record.endedAt = new Date().toISOString();
          record.updatedAt = new Date().toISOString();
          staleWaiting++;
        }
      }
      if (staleWaiting > 0) log.info(`Failed ${staleWaiting} stale waiting threads (leak safety net)`);
      count = await this.archiveExpiredTerminal(cutoff, autoRecordCutoff);
      if (count > 0 || staleWaiting > 0) {
        await this.persist();
        if (count > 0) log.info(`Archived ${count} old threads to ${THREADS_ARCHIVE_FILE} (workspaces removed)`);
      }
      return count;
    });
  }

  /** Terminal records past their cutoff. Auto-records (no workspace) use the shorter TTL. */
  private selectExpiredTerminal(cutoff: string, autoRecordCutoff: string): ThreadRecord[] {
    const expired: ThreadRecord[] = [];
    for (const record of this.map.values()) {
      const isTerminal = record.status === 'completed' || record.status === 'failed'
        || record.status === 'cancelled' || record.status === 'aborted';
      const effectiveCutoff = record.workspacePath ? cutoff : autoRecordCutoff;
      if (isTerminal && record.updatedAt < effectiveCutoff) expired.push(record);
    }
    return expired;
  }

  /** Archive expired terminal records to append-only JSONL, then drop them from the store and
   *  delete their workspace dirs. Append-then-delete: a crash can duplicate archive lines but
   *  never loses a record. If the append fails, records stay in the store (no data loss). */
  private async archiveExpiredTerminal(cutoff: string, autoRecordCutoff: string): Promise<number> {
    const expired = this.selectExpiredTerminal(cutoff, autoRecordCutoff);
    if (expired.length === 0) return 0;
    try {
      await mkdir(path.dirname(THREADS_ARCHIVE_FILE), { recursive: true });
      await appendFile(THREADS_ARCHIVE_FILE, expired.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch (err) {
      log.error(`Thread archive append failed — keeping ${expired.length} record(s): ${(err as Error).message}`);
      return 0;
    }
    for (const record of expired) {
      if (record.workspacePath) {
        try { rmSync(record.workspacePath, { recursive: true, force: true }); } catch {}
      }
      this.map.delete(record.id);
    }
    return expired.length;
  }

  /** Queue a persist through the mutex, chaining off any prior persist. Returns the promise.
   *  Errors are caught at the chain level so a single I/O failure does not poison all subsequent
   *  writes (returning a rejected chain would short-circuit every follow-up `.then`).
   *  Coalescing: map mutations are synchronous and persist() snapshots the whole map, so any
   *  mutation made before a queued persist STARTS is covered by it. The flag resets right before
   *  the snapshot; later mutations queue a fresh persist. Collapses sync bursts to one write. */
  queuePersist(): Promise<void> {
    if (this._persistQueued) return this._pendingPersist;
    this._persistQueued = true;
    this._pendingPersist = this._pendingPersist
      .catch(() => {})
      .then(() => this.mutex.run(() => {
        this._persistQueued = false;
        return this.persist();
      }))
      .catch((err) => { log.error('persist failed:', err); });
    return this._pendingPersist;
  }

  /** Atomically persist the entire Map to disk. Uses `repo.write()` (no read-modify-write needed). */
  private async persist(): Promise<void> {
    const obj: Record<string, ThreadRecord> = {};
    for (const [id, record] of this.map) {
      obj[id] = record;
    }
    await this.repo.write(obj);
  }
}

export const threadStore = new ThreadRepo();
