import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from 'fs';
import { dirname } from 'node:path';
import { RESTART_TRIGGER_FILE } from './paths.js';

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

/** The pid recorded in a pid file; null when the file is missing, unreadable or not a positive
 *  integer. */
export function readPidFile(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The pid recorded in a pid file when that process is alive; otherwise null. */
export function readLivePid(pidFile: string): number | null {
  const pid = readPidFile(pidFile);
  return pid !== null && isProcessAlive(pid) ? pid : null;
}

/** Create or refresh the daemon's restart trigger (the daemon watches it and respawns app.js). */
export function touchRestartTrigger(trigger: string = RESTART_TRIGGER_FILE): void {
  mkdirSync(dirname(trigger), { recursive: true });
  if (!existsSync(trigger)) {
    writeFileSync(trigger, '');
    return;
  }
  const now = new Date();
  utimesSync(trigger, now, now);
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
  const holderPid = readLivePid(pidFile);
  if (holderPid !== null) return { acquired: false, holderPid };
  // Present but stale (previous owner died without cleanup) or corrupt — reclaim it.
  const stale = existsSync(pidFile);
  writeFileSync(pidFile, String(process.pid), 'utf8');
  return { acquired: true, stale };
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
