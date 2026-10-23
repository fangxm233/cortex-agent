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
/** Claude MCP configs and remote-proxy configs are content-addressed `<sha256>.json` files; an
 *  interrupted write leaves its `.tmp.*` sibling behind. */
const OWNED_MCP_FILE = /^[0-9a-f]{64}\.json(?:\.tmp\..+)?$/;
const CLAUDE_MCP_DIRS = ['claude-mcp', 'claude-mcp-proxies'] as const;

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

function ownedChildren(parent: string, owned: RegExp): string[] {
  try {
    return fs.readdirSync(parent).filter((name) => owned.test(name)).map((name) => path.join(parent, name));
  } catch {
    return [];
  }
}

function isStale(entry: string, now: number, isKind: (stat: fs.Stats) => boolean): boolean {
  try {
    const stat = fs.lstatSync(entry);
    return isKind(stat) && now - stat.mtimeMs >= STALE_AFTER_MS;
  } catch {
    return false;
  }
}

/** True when `key` was swept within the last interval; otherwise records this sweep. */
function throttled(key: string, now: number): boolean {
  if (now - (lastSweep.get(key) ?? 0) < SWEEP_INTERVAL_MS) return true;
  lastSweep.set(key, now);
  return false;
}

function removeStale(
  entries: readonly string[],
  inUse: ReadonlySet<string>,
  now: number,
  isKind: (stat: fs.Stats) => boolean,
): string[] {
  const removed: string[] = [];
  for (const entry of entries) {
    if (inUse.has(entry) || !isStale(entry, now, isKind)) continue;
    try {
      fs.rmSync(entry, { recursive: true, force: true });
      removed.push(entry);
    } catch (error) {
      log.warn(`Could not remove stale plugin runtime entry ${entry}: ${(error as Error).message}`);
    }
  }
  return removed;
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
  if (throttled(backendDir, now)) return [];
  const entries = [
    ...ownedChildren(backendDir, OWNED_NAME),
    ...ownedChildren(path.join(backendDir, 'skill-snapshots'), OWNED_NAME),
  ];
  const removed = removeStale(entries, inUse, now, (stat) => stat.isDirectory());
  if (removed.length > 0) log.info(`Removed ${removed.length} stale plugin runtime dir(s) under ${backendDir}`);
  return removed;
}

/**
 * Remove Claude MCP and remote-proxy configs under `runtimeDir` that nothing has touched for
 * {@link STALE_AFTER_MS}. Every Claude spawn and every pooled-session reuse check rewrites or touches
 * the files it resolves, and an idle Claude process exits within the hour, so a file this old is
 * used by no running process. A later spawn that wants it writes it again at the same path.
 */
export function sweepStaleClaudeMcpFiles(runtimeDir: string, now = Date.now()): string[] {
  if (throttled(path.join(runtimeDir, CLAUDE_MCP_DIRS[0]), now)) return [];
  const entries = CLAUDE_MCP_DIRS.flatMap((dir) => ownedChildren(path.join(runtimeDir, dir), OWNED_MCP_FILE));
  const removed = removeStale(entries, new Set(), now, (stat) => stat.isFile());
  if (removed.length > 0) log.info(`Removed ${removed.length} stale Claude MCP config(s) under ${runtimeDir}`);
  return removed;
}

/** Test hook: forget the per-directory sweep throttle. */
export function _resetSweepThrottle(): void {
  lastSweep.clear();
}
