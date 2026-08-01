// input:  TASKS.yaml lock metadata and cross-process mutation lock
// output: atomic project lock acquire/release operations
// pos:    Serializes logical lock metadata with all other task-file writers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PROJECTS_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { parseTasksFileWithLock, serializeTasksFileWithLock } from '@core/task-parser.js';
import type { LockState } from '@core/task-parser.js';
import { withTaskFileMutationLock } from './task-lifecycle-edit.js';

const log = createLogger('task-lock');

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
  withTaskFileMutationLock(project, () => writeLockUnlocked(project, lock));
}

export function acquireLock(
  project: string, opts: { owner: string; force?: boolean; note?: string },
): { acquired: boolean; lock?: LockState; message?: string } {
  return withTaskFileMutationLock(project, () => acquireLockUnlocked(project, opts));
}

export function releaseLock(
  project: string, owner: string, opts?: { force?: boolean },
): { released: boolean; message?: string } {
  return withTaskFileMutationLock(project, () => releaseLockUnlocked(project, owner, opts));
}

export function assertLockHeld(project: string, owner: string): string | null {
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
