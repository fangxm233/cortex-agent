// input:  the shipped TaskRepo / task-lock / task-node extraction targets, behind the frozen
//         §7.2 port interfaces (composite-runtime-ports.ts)
// output: the P2/P4/P5 port implementations — TrialTaskRepository with the git side severed,
//         the trial-owned lock table and TrialTaskLocks, and the trial-root artifact projection
// pos:    §7.2 P2/P4/P5. The three ports that decide whether an in-trial task mutation can
//         touch host state: the git remote, the host lock table and the host artifact root.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Import discipline (§7.3 X4/X9/X10): this module may not import `store/task-repo.ts` (live X4/X9
// targets), `core/paths.ts` (X10 direct edge), `domain/tasks/system/task-lock.ts` — its closure
// reaches `store/thread-repo.ts` through the shipped `task-lifecycle-edit → template-loader →
// template-validate → threads/utils` chain (a live X4 reach) — or `composite-runtime-ports.ts`
// itself: its closure reaches `src/platform/`, so importing it even for a type would make this
// module a new platform-reaching seed and raise the pinned X2 count (a rejection). The §7.2 port
// shapes are therefore declared structurally below; `task-lock.ts` re-exports the lock-table type,
// and the port test pins every shape to the frozen declarations by compile-time assignment.

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import * as path from 'path';
import type { Task } from '../../core/task-parser.js';
import type { LockState } from '../../core/task-parser.js';
import {
  ensureTaskArtifact, managerNodeDir, taskArtifactPath, withTaskNodeProjectsRoot,
} from '../../core/task-node.js';
import { PolicyCompilationError } from './resolved-policy.js';
import type { DeterministicClock } from './trial-clock.js';
import type { BenchmarkBrokerCapability } from './capabilities.js';

// --- the §7.2 port shapes, declared structurally (see the discipline note above) -------------

/** The frozen `TrialTaskFilter` of composite-runtime-ports.ts, restated. */
export interface TrialTaskFilter {
  project?: string;
  status?: string;
  parent?: string;
}

/** The frozen `TrialTaskRepository` of composite-runtime-ports.ts (§7.2 P2), restated. */
export interface TrialTaskRepository {
  getById(taskId: string): Task | null;
  list(filter: TrialTaskFilter): Task[];
  getActionable(): Task[];
  refresh(): void;
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

/** The frozen `TrialTaskLock` of composite-runtime-ports.ts (§7.2 P4), restated. */
export interface TrialTaskLock {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

/** The frozen `TrialTaskLocks` of composite-runtime-ports.ts (§7.2 P4), restated. */
export interface TrialTaskLocks {
  acquire(project: string, owner: string): { acquired: boolean; lock?: TrialTaskLock };
  release(project: string, owner: string): { released: boolean };
  assertHeld(project: string, owner: string): string | null;
  isLocked(project: string): { locked: boolean; owner?: string };
}

/** The frozen `TaskArtifactProjection` of composite-runtime-ports.ts (§7.2 P5), restated. */
export interface TaskArtifactProjection {
  nodeDir(project: string, taskId: string): string;
  artifactPath(project: string, taskId: string): string;
  /** Must never truncate an existing artifact: rotation and rehydration depend on it. */
  ensure(project: string, taskId: string): string;
  read(capability: BenchmarkBrokerCapability): string;
  write(capability: BenchmarkBrokerCapability, content: string): void;
}

// --- P2 — TrialTaskRepository ---------------------------------------------------------------

/** The shipped `TaskRepo` surface the trial repository needs, declared structurally: the store
 *  singleton is an X4/X9 target and cannot be imported (§7.3), and the git side is deliberately
 *  absent — the port severs it by construction and must not even be able to reach it. */
export interface TrialTaskRepositoryDelegate {
  getById(taskId: string): Task | null;
  getAll(project?: string): Task[];
  getActionable(): Task[];
  refresh(): void;
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

/** §7.2 P2 — the trial task repository. The git side is severed BY CONSTRUCTION: `commitAndPush`
 *  exists only because the shipped `TaskMutator` calls it at all sixteen of its sites
 *  (`mutator.ts:133-346`), and in-trial it is a no-op — no `git add`, no `git commit` and no
 *  detached `git push origin main` process is ever created for a trial-scoped mutation, regardless
 *  of how the delegate is configured. The delegate's own git path is not even part of the
 *  delegate's type, so a reviewer cannot re-route the port to it by editing one line here. */
export function createTrialTaskRepository(
  delegate: TrialTaskRepositoryDelegate,
): TrialTaskRepository & { commitAndPush(message: string): void } {
  return {
    getById: (taskId) => delegate.getById(taskId),
    list: (filter) => {
      const tasks = delegate.getAll(filter.project);
      return tasks.filter(task =>
        (filter.status === undefined || task.status === filter.status)
        && (filter.parent === undefined || task.parent === filter.parent));
    },
    getActionable: () => delegate.getActionable(),
    refresh: () => delegate.refresh(),
    runExclusive: (fn) => delegate.runExclusive(fn),
    flush: () => delegate.flush(),
    // §7.2 P2: in-trial the git side is a no-op. The mutation still persists through the
    // delegate — only the subprocess creation is severed.
    commitAndPush: () => { /* no-op: in-trial mutations never touch git */ },
  };
}

// --- P4 — TrialTaskLocks and the trial-owned lock table --------------------------------------

/** §7.2 P4 — the trial's own lock table contract. Declared here and type-re-exported by
 *  `domain/tasks/system/task-lock.ts`, whose closure cannot be imported by benchmark modules; the
 *  port test pins the shape by compile-time assignment. The table is in-memory (the broker's
 *  authoritative task state is in-memory), keyed by project, and time-sourced from the trial
 *  clock: the TTL is the remaining trial time at acquire, never the shipped fixed 20 minutes. A
 *  TTL-expired lock reads as free, mirroring `task-lock.ts:87-96,169-174`. */
export interface TrialTaskLockTable {
  read(project: string): LockState | null;
  write(project: string, lock: LockState | null): void;
  acquire(
    project: string, owner: string,
  ): { acquired: boolean; lock?: LockState; message?: string };
  release(
    project: string, owner: string, opts?: { force?: boolean },
  ): { released: boolean; message?: string };
  assertHeld(project: string, owner: string): string | null;
  isProjectLocked(
    project: string, now?: string,
  ): { locked: boolean; owner?: string; expiresAt?: string };
}

const trialLockScope = new AsyncLocalStorage<TrialTaskLockTable>();

/** Production P4 scope runner, exported through `composite-runtime-ports.ts` so the coordinator
 *  installs the same table that the shipped task-lock functions consume. */
export function withTrialTaskLockScope<T>(table: TrialTaskLockTable, action: () => T): T {
  return trialLockScope.run(table, action);
}

/** Used only by the shipped task-lock extraction target to resolve the active trial table. */
export function getTrialTaskLockTable(): TrialTaskLockTable | null {
  return trialLockScope.getStore() ?? null;
}

/** §7.2 P4 — the trial's own lock table. In-memory, keyed by project, time-sourced from the
 *  trial clock. */
export function createTrialTaskLockTable(clock: DeterministicClock): TrialTaskLockTable {
  const locks = new Map<string, LockState>();
  return {
    read(project) {
      return locks.get(project) ?? null;
    },
    write(project, lock) {
      if (lock === null) locks.delete(project);
      else locks.set(project, lock);
    },
    acquire(project, owner) {
      const current = locks.get(project);
      const now = clock.nowDate();
      if (current && new Date(current.expires_at) > now) {
        return {
          acquired: false,
          lock: current,
          message: `Lock held by ${current.owner} (expires ${current.expires_at})`,
        };
      }
      const acquiredAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + Math.max(0, clock.remainingMs())).toISOString();
      const lock = { owner, acquired_at: acquiredAt, expires_at: expiresAt };
      locks.set(project, lock);
      return { acquired: true, lock };
    },
    release(project, owner, opts) {
      const current = locks.get(project);
      if (!current) return { released: true, message: 'No lock held' };
      if (!opts?.force && current.owner !== owner) {
        return { released: false, message: `Lock held by different owner: ${current.owner}` };
      }
      locks.delete(project);
      return { released: true, message: 'Lock released' };
    },
    assertHeld(project, owner) {
      const current = locks.get(project);
      if (!current) return 'No lock held';
      if (current.owner !== owner) {
        return `Lock held by different owner: ${current.owner}`;
      }
      if (new Date(current.expires_at) <= clock.nowDate()) {
        return `Lock expired at ${current.expires_at}`;
      }
      return null;
    },
    isProjectLocked(project, now) {
      const current = locks.get(project);
      if (!current) return { locked: false };
      const refTime = now ? new Date(now) : clock.nowDate();
      if (new Date(current.expires_at) <= refTime) return { locked: false };
      return { locked: true, owner: current.owner, expiresAt: current.expires_at };
    },
  };
}

/** §7.2 P4 — the port the coordinator holds. It operates on the SAME table the
 *  `withTrialTaskLockScope` scope installs, so the port and the shipped lock functions
 *  (`mutator.ts`'s own calls) always agree on one trial-local lock state. */
export function createTrialTaskLocks(table: TrialTaskLockTable): TrialTaskLocks {
  return {
    acquire(project, owner) {
      const result = table.acquire(project, owner);
      return result.acquired
        ? {
            acquired: true,
            lock: result.lock
              ? { owner: result.lock.owner, acquiredAt: result.lock.acquired_at, expiresAt: result.lock.expires_at }
              : undefined,
          }
        : { acquired: false };
    },
    release(project, owner) {
      return { released: table.release(project, owner).released };
    },
    assertHeld(project, owner) {
      return table.assertHeld(project, owner);
    },
    isLocked(project) {
      const result = table.isProjectLocked(project);
      return { locked: result.locked, ...(result.owner ? { owner: result.owner } : {}) };
    },
  };
}

// --- P5 — TaskArtifactProjection --------------------------------------------------------------

export interface TrialArtifactProjectionOptions {
  /** The trial root §7.2 P5 repoints `PROJECTS_DIR` at — every artifact resolves under it. */
  readonly root: string;
  /** The trial's project; `read`/`write` resolve `manager/<taskId>/artifact.md` under it. */
  readonly project: string;
  /** §8.3 fixes `artifact.write`'s target to `manager/<cap.task_id>/artifact.md`; the actor's
   *  task id is resolved from the trial's actor binding (G5-W4.3), which the broker supplies.
   *  Absent a binding, read/write fail closed with `runtime_port_unbound` rather than guess. */
  readonly resolveTaskId?: (capability: BenchmarkBrokerCapability) => string;
}

/** Production P5 scope for unchanged helper callers such as `proposal-seal.ts`. */
export function withTrialTaskArtifactScope<T>(root: string, action: () => T): T {
  return withTaskNodeProjectsRoot(path.resolve(root), action);
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function outOfTrialPath(target: string, root: string): never {
  throw new PolicyCompilationError('out_of_trial_path', target, { root });
}

function confinedArtifactPath(root: string, realRoot: string, target: string): string {
  const resolved = path.resolve(target);
  if (!isWithin(root, resolved)) return outOfTrialPath(target, root);
  let existing = resolved;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const realExisting = realpathSync(existing);
  const realTarget = path.resolve(realExisting, path.relative(existing, resolved));
  if (!isWithin(realRoot, realTarget)) return outOfTrialPath(target, realRoot);
  return resolved;
}

function taskIdFor(
  resolveTaskId: TrialArtifactProjectionOptions['resolveTaskId'],
  capability: BenchmarkBrokerCapability,
): string {
  if (resolveTaskId) return resolveTaskId(capability);
  throw new PolicyCompilationError('runtime_port_unbound', 'taskArtifacts:resolveTaskId', {
    port: 'P5',
  });
}

/** §7.2 P5 — root re-pointing plus §8.4 R5 lexical and realpath containment before I/O. */
export function createTaskArtifactProjection(
  options: TrialArtifactProjectionOptions,
): TaskArtifactProjection {
  const root = path.resolve(options.root);
  const realRoot = realpathSync(root);
  const { project, resolveTaskId } = options;
  const targetFor = (p: string, taskId: string): string =>
    confinedArtifactPath(root, realRoot, taskArtifactPath(p, taskId, root));

  return {
    nodeDir: (p, taskId) => managerNodeDir(p, taskId, root),
    artifactPath: (p, taskId) => taskArtifactPath(p, taskId, root),
    ensure(p, taskId) {
      const target = targetFor(p, taskId);
      ensureTaskArtifact(p, taskId, root);
      return target;
    },
    read(capability) {
      return readFileSync(targetFor(project, taskIdFor(resolveTaskId, capability)), 'utf8');
    },
    write(capability, content) {
      const taskId = taskIdFor(resolveTaskId, capability);
      const target = targetFor(project, taskId);
      ensureTaskArtifact(project, taskId, root);
      writeFileSync(target, content);
    },
  };
}
