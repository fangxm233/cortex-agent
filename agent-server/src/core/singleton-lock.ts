// input:  a pidfile path
// output: singleton lock acquisition, release, and liveness checks
// pos:    Shared process pidfile lock primitive
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname } from 'node:path';

/** Probe whether a PID is alive. Signal 0 performs the permission/existence check
 *  without actually delivering a signal; a throw (ESRCH/EPERM-as-dead handled by caller)
 *  means the process is not addressable as a live, signalable target. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// NOTE: a flat interface (not a discriminated union) on purpose — this project compiles
// with `strict: false`, which disables discriminated-union narrowing, so callers could not
// access `holderPid` after an `if (result.acquired)` check. With a flat shape every field is
// always reachable. `holderPid` is only meaningful when `acquired === false`.
export interface AcquireResult {
  acquired: boolean;
  /** Set when acquired === true: whether a stale/corrupt lock was reclaimed. */
  stale?: boolean;
  /** Set when acquired === false: the PID currently holding the lock. */
  holderPid?: number;
}

/**
 * Attempt to take a PID-file singleton lock.
 * - File missing                       → write own pid, { acquired: true, stale: false }
 * - File holds a live, valid pid       → { acquired: false, holderPid }
 * - File holds a dead/corrupt pid      → overwrite with own pid, { acquired: true, stale: true }
 *
 * This function never exits the process or logs — the caller decides how to react to a
 * conflict (typically: log a message and process.exit(1)).
 */
export function tryAcquireSingletonLock(pidFile: string): AcquireResult {
  mkdirSync(dirname(pidFile), { recursive: true });
  if (existsSync(pidFile)) {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const holderPid = Number(raw);
    if (Number.isFinite(holderPid) && holderPid > 0 && isProcessAlive(holderPid)) {
      return { acquired: false, holderPid };
    }
    // Stale (previous owner died without cleanup) or corrupt content — reclaim it.
    writeFileSync(pidFile, String(process.pid), 'utf8');
    return { acquired: true, stale: true };
  }
  writeFileSync(pidFile, String(process.pid), 'utf8');
  return { acquired: true, stale: false };
}

/** Release the lock iff it is still owned by the current process. Best-effort; swallows errors. */
export function releaseSingletonLock(pidFile: string): void {
  try {
    if (!existsSync(pidFile)) return;
    const raw = readFileSync(pidFile, 'utf8').trim();
    if (Number(raw) === process.pid) unlinkSync(pidFile);
  } catch {
    /* best-effort cleanup */
  }
}
