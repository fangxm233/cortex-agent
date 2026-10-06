import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@core/log.js';

const log = createLogger('plugin-runtime');

/** Untouched this long and not used by the spawn at hand: no session has resolved it for a week. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** One sweep per backend directory per hour is plenty; spawns are far more frequent. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Only names this runtime creates (`safeNativeComposite` prefixes): projections and their temp
 *  dirs are `plugin_*`, snapshot descriptors are `skill_*`. Anything else is left alone. */
const OWNED_NAME = /^(plugin|skill)_/;

const lastSweep = new Map<string, number>();

/** Mark a reused projection or snapshot as live, so a sweep in this or another process keeps it. */
export function markInUse(directory: string): void {
  try {
    const now = new Date();
    fs.utimesSync(directory, now, now);
  } catch {
    // A failed touch only makes the directory eligible for a sweep, which rebuilds it on demand.
  }
}

function ownedChildren(parent: string): string[] {
  try {
    return fs.readdirSync(parent).filter((name) => OWNED_NAME.test(name)).map((name) => path.join(parent, name));
  } catch {
    return [];
  }
}

function isStale(directory: string, now: number): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && now - stat.mtimeMs >= STALE_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * Remove projections and skill snapshots under `backendDir` that the current spawn does not use and
 * that nothing has touched for {@link STALE_AFTER_MS}. Every one is content-addressed, so a removed
 * directory a later spawn still wants is rebuilt at the same path. Returns what was removed.
 */
export function sweepStaleRuntimeDirs(
  backendDir: string,
  inUse: ReadonlySet<string>,
  now = Date.now(),
): string[] {
  if (now - (lastSweep.get(backendDir) ?? 0) < SWEEP_INTERVAL_MS) return [];
  lastSweep.set(backendDir, now);
  const removed: string[] = [];
  for (const directory of [...ownedChildren(backendDir), ...ownedChildren(path.join(backendDir, 'skill-snapshots'))]) {
    if (inUse.has(directory) || !isStale(directory, now)) continue;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      removed.push(directory);
    } catch (error) {
      log.warn(`Could not remove stale plugin runtime dir ${directory}: ${(error as Error).message}`);
    }
  }
  if (removed.length > 0) log.info(`Removed ${removed.length} stale plugin runtime dir(s) under ${backendDir}`);
  return removed;
}

/** Test hook: forget the per-directory sweep throttle. */
export function _resetSweepThrottle(): void {
  lastSweep.clear();
}
