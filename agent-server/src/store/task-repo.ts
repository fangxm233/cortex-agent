// input:  TASKS.yaml files per project, core/task-parser
// output: { taskStore, withGitLock } — TaskRepo singleton + git lock helper
// pos:    Serialized coordination center for TASKS.yaml changes. Based on core/AsyncMutex + atomicWrite (Pattern B)
//         S4: mutation shim methods removed, now lives in domain/tasks/mutator.ts

import * as path from 'path';
import { spawn } from 'child_process';
import { runFile } from '@core/exec-async.js';
import { PROJECTS_DIR, DATA_DIR } from '@core/utils.js';
import {
  scanAllTasks,
  scanAvailableTasks,
  getTaskStatsFromTasks,
} from '@core/task-parser.js';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';

const log = createLogger('task-store');

// --- Git mutex (shared across TaskRepo) ---

const gitMutex = new AsyncMutex();

export function withGitLock<T>(fn: () => T | Promise<T>): Promise<T> {
  return gitMutex.run(fn);
}

// --- TaskRepo (Pattern B-lite: sync read + sync atomic write; no _pendingPersist chain) ---
// NOTE: This repo differs from ExecutionRepo (Pattern B proper):
//   - writes are SYNC (atomicWriteSync via task-lifecycle-edit → writeTasksFile), not
//     fire-and-forget queuePersist(). The mutex alone serialises; there's no persist chain.
//   - source of truth is TASKS.yaml on disk, not a private Map. `this.tasks` is a cache
//     refreshed by `load()` after every successful mutation.
// This is intentional — TASKS.yaml is git-committed so we can't safely decouple in-memory
// state from disk state. But callers that rely on Pattern B proper (fire-and-forget
// persist + terminal stickiness) will not find those semantics here.

export interface TaskRepoOptions {
  /** Skip git-add/commit/push after mutations — for tests. Defaults to false. */
  skipGit?: boolean;
}

export class TaskRepo {
  private tasks: any[] = [];
  private taskMutex = new AsyncMutex();
  private initialized = false;
  private readonly skipGit: boolean;

  constructor(opts: TaskRepoOptions = {}) {
    this.skipGit = opts.skipGit ?? false;
  }

  /** Load all tasks from TASKS.yaml files into memory */
  load(): void {
    try {
      this.tasks = scanAllTasks();
      this.initialized = true;
      log.info(`Loaded ${this.tasks.length} tasks from ${new Set(this.tasks.map(t => t.project)).size} projects`);
    } catch (e) {
      log.error(`Failed to load tasks: ${e.message}`);
      this.tasks = [];
    }
  }

  /** Reload tasks from files (e.g. after external edit or git pull) */
  refresh(): void {
    this.load();
  }

  // --- Read operations (from memory, no lock needed) ---

  /**
   * WARNING: this refreshes from disk on every call — `load()` walks every TASKS.yaml.
   * task-dispatcher invokes this on every dispatch tick, so this is a
   * hot path. If you observe dispatcher latency regression, this is the first
   * suspect — consider caching or splitting into a `getActionableCached()` fast-path.
   */
  getActionable(): any[] {
    // Always refresh from disk so this.tasks stays in sync with what we return
    this.load();
    return scanAvailableTasks();
  }

  getAll(project?: string): any[] {
    if (!this.initialized) this.load();
    return project ? this.tasks.filter(t => t.project === project) : [...this.tasks];
  }

  getById(taskId: string): any | null {
    if (!this.initialized) this.load();
    return this.tasks.find(t => t.id === taskId) || null;
  }

  getStats(): any {
    if (!this.initialized) this.load();
    return getTaskStatsFromTasks(this.tasks);
  }

  getGpuBusyMachines(): Map<string, number> {
    if (!this.initialized) this.load();
    const counts = new Map<string, number>();
    for (const t of this.tasks) {
      if (t.gpu && t.claimed_by && t.status !== 'done') {
        const machine = t.gpu.toLowerCase();
        const gpuCount = t.gpu_count || 1;
        counts.set(machine, (counts.get(machine) || 0) + gpuCount);
      }
    }
    return counts;
  }

  // --- External exclusive access (for callers like task-archiver) ---

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.taskMutex.run(fn);
  }

  // --- Graceful shutdown ---

  /**
   * Wait for any in-flight `runExclusive` / mutation to drain.
   * Acquire-release the mutex; FIFO ordering guarantees all preceding
   * operations have completed when this resolves.
   * Mutations await `commitAndPush` inside the mutex, so git sync is always done by the time
   * the mutex releases.
   * Known limitation: asyncPush errors may be lost during SIGTERM drain —
   * matching current task-store.ts behavior.
   */
  async flush(): Promise<void> {
    await this.taskMutex.run(async () => { /* acquire-release: drains pending mutations */ });
  }

  // --- Git sync ---

  /** Commit TASKS.yaml changes and push to origin/main.
   *  Async: git runs on the shared event loop, so the three commands are awaited instead of
   *  blocking every session/socket in the process (they used to run via execSync). */
  async commitAndPush(message: string): Promise<void> {
    if (this.skipGit) return;
    try {
      const rel = path.relative(DATA_DIR, PROJECTS_DIR);
      const glob = `${rel}/*/TASKS.yaml`;
      const added = await runFile('git', ['add', glob], { cwd: DATA_DIR, timeoutMs: 10000 });
      if (!added.ok) {
        log.error(`Git add failed: ${(added.stderr || added.stdout || added.error || '').trim()}`);
        return;
      }

      const status = await runFile('git', ['status', '--porcelain', '--', glob], {
        cwd: DATA_DIR, timeoutMs: 5000,
      });
      if (!status.ok) {
        log.error(`Git status failed: ${(status.stderr || status.error || '').trim()}`);
        return;
      }

      if (status.stdout.trim()) {
        const committed = await runFile('git', ['commit', '-m', message], { cwd: DATA_DIR, timeoutMs: 10000 });
        if (!committed.ok) {
          log.error(`Git commit failed: ${(committed.stderr || committed.stdout || '').trim()}`);
          return;
        }
        log.info(`Committed: ${message}`);
        this.asyncPush();
      }
    } catch (e: any) {
      log.error(`Git sync failed: ${e.message}`);
    }
  }

  private asyncPush(): void {
    const child = spawn('git', ['push', 'origin', 'main'], {
      cwd: DATA_DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code !== 0) {
        log.error(`Async push failed (exit ${code}): ${stderr.trim()}`);
      }
    });
    child.unref();
  }
}

// --- Singleton ---

export const taskStore = new TaskRepo();
