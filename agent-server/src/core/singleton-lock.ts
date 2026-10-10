import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, utimesSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { RESTART_TRIGGER_FILE } from './paths.js';

/** USER_HZ, the unit of `/proc/<pid>/stat` starttime on every mainstream Linux build. */
const LINUX_TICKS_PER_SECOND = 100;
/** Start times are read at up to 1 s resolution. A pid file's writer always started before writing
 *  it, so only a start later than the file's mtime by more than this proves the pid was reused. */
const PID_REUSE_SLACK_MS = 2_000;

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

function linuxStartTime(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  const bootSeconds = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
  return (bootSeconds + ticks / LINUX_TICKS_PER_SECOND) * 1000;
}

function windowsStartTime(pid: number): number {
  const script = `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim());
}

/** macOS and other Unix: `ps` prints the stored start time ("Thu Oct  9 23:01:01 2026", local). */
function psStartTime(pid: number): number {
  return new Date(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()).getTime();
}

const START_TIME_READERS: Partial<Record<NodeJS.Platform, (pid: number) => number>> = {
  linux: linuxStartTime,
  win32: windowsStartTime,
};

/** When `pid` started, in epoch ms at up to 1 s resolution; null when the OS will not say. */
export function processStartTime(pid: number): number | null {
  const read = START_TIME_READERS[process.platform] ?? psStartTime;
  try {
    const startedAt = read(pid);
    return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is alive and still the process that wrote `pidFile`. After a crash or reboot the
 * recorded pid often belongs to an unrelated process; the writer started before it wrote the file,
 * so a process that started later only reused the pid. When either time cannot be read, liveness
 * alone decides, as it always did.
 */
export function isPidFileOwner(pidFile: string, pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  const startedAt = processStartTime(pid);
  const writtenAt = statSync(pidFile, { throwIfNoEntry: false })?.mtimeMs;
  if (startedAt === null || writtenAt === undefined) return true;
  return startedAt <= writtenAt + PID_REUSE_SLACK_MS;
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

/** The pid recorded in a pid file when that process is alive and wrote it; otherwise null. */
export function readLivePid(pidFile: string): number | null {
  const pid = readPidFile(pidFile);
  return pid !== null && isPidFileOwner(pidFile, pid) ? pid : null;
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
 * - File missing                         → write own pid, { acquired: true, stale: false }
 * - File holds its live writer's pid     → { acquired: false, holderPid }
 * - File holds a dead/reused/corrupt pid → overwrite with own pid, { acquired: true, stale: true }
 *
 * This function never exits the process or logs — the caller decides how to react to a
 * conflict (typically: log a message and process.exit(1)).
 */
export function tryAcquireSingletonLock(pidFile: string): AcquireResult {
  mkdirSync(dirname(pidFile), { recursive: true });
  const holderPid = readLivePid(pidFile);
  if (holderPid !== null) return { acquired: false, holderPid };
  // Present but stale (previous owner died without cleanup, its pid maybe reused) or corrupt — reclaim it.
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
