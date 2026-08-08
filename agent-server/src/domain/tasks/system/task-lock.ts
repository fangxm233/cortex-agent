// input:  TASKS.yaml lock metadata, cross-process mutation lock, and the trial lock scope
// output: atomic project lock acquire/release operations; in-trial they operate on the trial's
//         own lock table (§7.2 P4) instead of the host TASKS.yaml lock metadata
// pos:    Serializes logical lock metadata with all other task-file writers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PROJECTS_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { parseTasksFileWithLock, serializeTasksFileWithLock } from '@core/task-parser.js';
import type { LockState } from '@core/task-parser.js';
import { withTaskFileMutationLock } from './task-lifecycle-edit.js';

const log = createLogger('task-lock');

// ── Trial lock scope (§7.2 P4) ───────────────────────────────────────────────
//
// The trial owns its locks: in-trial, every lock operation must hit the trial's own table and
// must neither see nor write the host TASKS.yaml lock metadata — a host lock held by a real
// user's task may not block a trial, and a trial lock may not block the host. The table is
// created by the P4 port implementation (`domain/benchmark/trial-task-ports.ts`) and installed
// here for the duration of a trial operation, exactly as `withLocalThreadRuntimeScope` installs
// the runtime deps (§7.1 I2). When no table is installed, every function below is byte-identical
// to the shipped daemon behaviour.

/** A lock table the trial owns. Implemented by `domain/benchmark/trial-task-ports.ts`; the TTL
 *  policy (derived from the trial deadline) lives in that implementation, so the shipped
 *  functions never see a fixed 20-minute constant here. */
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

/** Installs the trial's lock table for the duration of `action` — the coordinator wraps every
 *  in-trial mutating turn with this, mirroring `withLocalThreadRuntimeDeps`. */
export function withTrialTaskLockScope<T>(
  table: TrialTaskLockTable,
  action: () => Promise<T>,
): Promise<T> {
  return trialLockScope.run(table, action);
}

function currentTrialLockTable(): TrialTaskLockTable | null {
  return trialLockScope.getStore() ?? null;
}

/** §7.2 P4: the in-trial system-lock spin (`mutator.ts:84-90`) is bounded to zero retries — the
 *  coordinator is single-writer, so a contended in-trial acquire is a coordination violation and
 *  raises instead of feeding `while (!acquireLock(...))`. No failure code is allocated for this
 *  (done_when 6; G5-N4's interim rule omits `code` rather than reusing one for a different
 *  condition); the broker layer maps it to a typed refusal. */
export class TrialLockContendedError extends Error {
  readonly reason = 'trial_lock_contended';

  constructor(readonly project: string, readonly holder: string) {
    super(`trial_lock_contended: ${project} held by ${holder}`);
    this.name = 'TrialLockContendedError';
  }
}

// ── Atomic write ──

function atomicWriteSync(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ── Path helpers ──

function tasksYamlPath(project: string): string {
  return path.join(PROJECTS_DIR, project, 'TASKS.yaml');
}

// ── Exports ──

export function getOwnerIdentity(): string {
  if (process.env.CORTEX_EXECUTION_ID) return process.env.CORTEX_EXECUTION_ID;
  let user: string;
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USER || 'unknown';
  }
  return `manual:${user}:${process.pid}`;
}

export function readLock(project: string): LockState | null {
  const table = currentTrialLockTable();
  if (table) return table.read(project);
  const filePath = tasksYamlPath(project);
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { lock } = parseTasksFileWithLock(content, project);
    return lock;
  } catch (err) {
    log.warn('Failed to read lock for %s: %s', project, err);
    return null;
  }
}

function writeLockUnlocked(project: string, lock: LockState | null): void {
  const filePath = tasksYamlPath(project);
  let tasks;
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseTasksFileWithLock(content, project);
    tasks = parsed.tasks;
  } else {
    tasks = [];
  }
  const yaml = serializeTasksFileWithLock({ tasks, lock });
  atomicWriteSync(filePath, yaml);
}

function acquireLockUnlocked(
  project: string,
  opts: { owner: string; force?: boolean; note?: string },
): { acquired: boolean; lock?: LockState; message?: string } {
  const { owner, force = false, note } = opts;
  const ttlMs = 1_200_000; // fixed 20 min — TTL is a safety net, LLM is expected to release
  const now = new Date();
  const nowISO = now.toISOString();

  const current = readLock(project);

  if (current && !force) {
    const expiresAt = new Date(current.expires_at);
    if (expiresAt > now) {
      return {
        acquired: false,
        lock: current,
        message: `Lock held by ${current.owner} (expires ${current.expires_at})`,
      };
    }
  }

  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const newLock: LockState = {
    owner,
    acquired_at: nowISO,
    expires_at: expiresAt,
    ...(note ? { note } : {}),
  };

  writeLockUnlocked(project, newLock);
  log.info('Lock acquired for %s by %s (expires %s)', project, owner, expiresAt);
  return { acquired: true, lock: newLock };
}

function releaseLockUnlocked(
  project: string,
  owner: string,
  opts?: { force?: boolean },
): { released: boolean; message?: string } {
  const current = readLock(project);
  if (!current) {
    return { released: true, message: 'No lock held' };
  }
  if (!opts?.force && current.owner !== owner) {
    return {
      released: false,
      message: `Lock held by different owner: ${current.owner}`,
    };
  }
  writeLockUnlocked(project, null);
  log.info('Lock released for %s by %s', project, owner);
  return { released: true, message: 'Lock released' };
}

export function writeLock(project: string, lock: LockState | null): void {
  const table = currentTrialLockTable();
  if (table) {
    table.write(project, lock);
    return;
  }
  withTaskFileMutationLock(project, () => writeLockUnlocked(project, lock));
}

export function acquireLock(
  project: string, opts: { owner: string; force?: boolean; note?: string },
): { acquired: boolean; lock?: LockState; message?: string } {
  const table = currentTrialLockTable();
  if (table) {
    const result = table.acquire(project, opts.owner);
    if (!result.acquired) {
      // In-trial the lock is the trial's own and the coordinator is single-writer: a contended
      // acquire is a coordination violation and raises rather than returning `acquired: false`
      // into the unbounded spin at `mutator.ts:84-90`. `force`/`note` have no in-trial meaning.
      throw new TrialLockContendedError(project, result.lock?.owner ?? 'unknown');
    }
    return result;
  }
  return withTaskFileMutationLock(project, () => acquireLockUnlocked(project, opts));
}

export function releaseLock(
  project: string, owner: string, opts?: { force?: boolean },
): { released: boolean; message?: string } {
  const table = currentTrialLockTable();
  if (table) return table.release(project, owner, opts);
  return withTaskFileMutationLock(project, () => releaseLockUnlocked(project, owner, opts));
}

export function assertLockHeld(project: string, owner: string): string | null {
  const table = currentTrialLockTable();
  if (table) return table.assertHeld(project, owner);
  const current = readLock(project);
  if (!current) {
    return 'No lock held';
  }
  if (current.owner !== owner) {
    return `Lock held by different owner: ${current.owner}`;
  }
  const expiresAt = new Date(current.expires_at);
  if (expiresAt <= new Date()) {
    return `Lock expired at ${current.expires_at}`;
  }
  return null;
}

export function isProjectLocked(
  project: string,
  now?: string,
): { locked: boolean; owner?: string; expiresAt?: string } {
  const table = currentTrialLockTable();
  if (table) return table.isProjectLocked(project, now);
  const current = readLock(project);
  if (!current) {
    return { locked: false };
  }
  const refTime = now ? new Date(now) : new Date();
  const expiresAt = new Date(current.expires_at);
  if (expiresAt <= refTime) {
    return { locked: false };
  }
  return {
    locked: true,
    owner: current.owner,
    expiresAt: current.expires_at,
  };
}
