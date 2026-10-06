import fs from 'node:fs/promises';
import path from 'node:path';

// Cross-process exclusive lock around one file's read-modify-write cycle. The lock is a directory
// `<file>.mutation-lock` holding owner.json; it is published by renaming a fully written candidate
// directory into place, so the lock never exists without its owner record. A lock is reclaimed when
// its owner is dead (or its pid now belongs to another process), when it has no owner record past a
// short grace, or when it has been held past STALE_HOLD_MS. Waiting is async polling: nothing here
// blocks the event loop.

const RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
/** A critical section is a read, a transform and an atomic write — milliseconds. A lock held this
 *  long belongs to a hung or suspended owner. Kept below the wait timeout so a waiter reclaims a
 *  stuck lock instead of failing. */
const STALE_HOLD_MS = 20_000;
const OWNERLESS_LOCK_GRACE_MS = 1_000;

export interface FileLockOptions {
  signal?: AbortSignal;
  /** How long to wait for the lock before throwing FileLockTimeoutError. Default 30 s. */
  timeoutMs?: number;
}

interface LockOwner {
  pid: number;
  token: string;
  processStart: string | null;
  acquiredAt: number | null;
}

export function fileLockPath(filePath: string): string {
  return `${filePath}.mutation-lock`;
}

export class FileLockTimeoutError extends Error {
  constructor(readonly filePath: string, readonly timeoutMs: number, readonly holderPid: number | null) {
    const holder = holderPid === null ? '' : ` held by pid ${holderPid}`;
    super(`Timed out after ${timeoutMs} ms waiting for the lock on ${filePath} (${fileLockPath(filePath)}${holder}).`);
    this.name = 'FileLockTimeoutError';
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    if (typeof owner.pid !== 'number' || typeof owner.token !== 'string') return null;
    return {
      pid: owner.pid,
      token: owner.token,
      processStart: typeof owner.processStart === 'string' ? owner.processStart : null,
      acquiredAt: typeof owner.acquiredAt === 'number' ? owner.acquiredAt : null,
    };
  } catch {
    return null;
  }
}

async function ownerIsGone(owner: LockOwner): Promise<boolean> {
  if (!processIsAlive(owner.pid)) return true;
  const currentStart = await processStartIdentity(owner.pid);
  return owner.processStart !== null && currentStart !== null && owner.processStart !== currentStart;
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  let ageMs: number;
  try { ageMs = Date.now() - (await fs.stat(lockPath)).mtimeMs; } catch { return false; }
  const owner = await readLockOwner(lockPath);
  if (!owner) return ageMs > OWNERLESS_LOCK_GRACE_MS;
  if (owner.acquiredAt !== null && Date.now() - owner.acquiredAt > STALE_HOLD_MS) return true;
  return ownerIsGone(owner);
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  if ((await readLockOwner(lockPath))?.token !== token) return;
  const releasedPath = `${lockPath}.released.${encodeURIComponent(token)}`;
  try {
    await fs.rename(lockPath, releasedPath);
    if ((await readLockOwner(releasedPath))?.token === token) {
      await fs.rm(releasedPath, { recursive: true, force: true });
    }
  } catch {}
}

async function removeStaleLock(lockPath: string): Promise<void> {
  if (!(await lockIsStale(lockPath))) return;
  try {
    const initial = await fs.stat(lockPath);
    await fs.writeFile(path.join(lockPath, '.reclaimed'), '');
    const current = await fs.stat(lockPath);
    if (current.dev !== initial.dev || current.ino !== initial.ino) return;
    if ((await readLockOwner(lockPath)) && !(await lockIsStale(lockPath))) return;
    const identity = `${current.dev}.${current.ino}.${String(current.ctimeMs).replace('.', '-')}`;
    const tombstone = `${lockPath}.reclaimed.${identity}`;
    await fs.rename(lockPath, tombstone);
    await fs.rm(tombstone, { recursive: true, force: true });
  } catch {}
}

async function tryAcquireLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const candidate = `${lockPath}.candidate.${encodeURIComponent(token)}`;
  try {
    await fs.mkdir(candidate);
    const owner: LockOwner = {
      pid: process.pid, token, processStart: await processStartIdentity(process.pid), acquiredAt: Date.now(),
    };
    await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    await fs.rename(candidate, lockPath);
    return () => releaseOwnedLock(lockPath, token);
  } catch (error: any) {
    await fs.rm(candidate, { recursive: true, force: true });
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return null;
    throw error;
  }
}

async function acquireFileLock(filePath: string, options: FileLockOptions): Promise<() => Promise<void>> {
  options.signal?.throwIfAborted();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = fileLockPath(filePath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const release = await tryAcquireLock(lockPath);
    if (release) return release;
    if (await lockIsStale(lockPath)) await removeStaleLock(lockPath);
    else await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
  throw new FileLockTimeoutError(filePath, timeoutMs, (await readLockOwner(lockPath))?.pid ?? null);
}

/** Run `fn` while holding the cross-process lock on `filePath`; the lock is released when `fn`
 *  settles. Not re-entrant: `fn` must not take the same lock again. */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
