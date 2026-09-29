import { readFileSync } from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { createFileWatchMonitor } from '@core/resilient-watch.js';
import { Icons } from '../core/icons.js';
import type { ProfilesFile } from '@domain/agents/profile-manager.js';

const log = createLogger('profile-repo');
let profileConfigRevision = 0;

export const PROFILES_FILE = path.join(CONFIG_DIR, 'profiles.json');

export function getProfileConfigRevision(): number {
  return profileConfigRevision;
}

export class ProfileRepo {
  private readonly _filePath: string;
  private _syncCache: ProfilesFile | null = null;

  constructor(filePath: string = PROFILES_FILE) {
    this._filePath = filePath;
  }

  /**
   * Synchronous read for profile-manager.ts. First call reads from disk; subsequent
   * calls serve from cache until invalidate() drops it.
   */
  readSync(): ProfilesFile {
    if (this._syncCache) return this._syncCache;
    const raw = readFileSync(this._filePath, 'utf8');
    const parsed = JSON.parse(raw) as ProfilesFile;
    this._syncCache = parsed;
    return parsed;
  }

  /** Drop the in-memory cache so the next readSync() fetches from disk. */
  invalidate(): void {
    this._syncCache = null;
  }
}

export const profileRepo = new ProfileRepo();

// --- Admin notification (hot-reload → Slack) ---
let _adminNotifier: ((text: string) => void) | null = null;
export function setAdminNotifier(fn: (text: string) => void): void { _adminNotifier = fn; }

/**
 * Watch profiles.json for external edits and hot-reload the cache.
 * Mirrors the pattern used by startMachineRegistryWatcher() in dispatch-utils.ts.
 *
 * Returns a stop function — call it to tear down the watcher (e.g. in tests or SIGTERM).
 *
 * @param repo     ProfileRepo instance to invalidate on change (defaults to singleton).
 * @param filePath Path to watch (defaults to PROFILES_FILE).
 * @param onReload Called only after a valid file has replaced the cached profile snapshot.
 */
function reloadProfiles(repo: ProfileRepo, filePath: string, onReload?: () => void): void {
  try {
    const raw = readFileSync(filePath, 'utf8');
    JSON.parse(raw);
    repo.invalidate();
    repo.readSync();
    profileConfigRevision += 1;
    onReload?.();
    log.info('Hot-reload: profiles.json reloaded');
    _adminNotifier?.(`${Icons.refresh} \`profiles.json\` hot-reloaded`);
  } catch (e) {
    log.error(`Hot-reload profiles.json failed: ${(e as Error).message} — keeping previous config`);
    _adminNotifier?.(`${Icons.warning} \`profiles.json\` hot-reload FAILED — keeping previous config`);
  }
}

export function startProfileWatcher(
  repo: ProfileRepo = profileRepo,
  filePath: string = PROFILES_FILE,
  onReload?: () => void,
): () => void {
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      reloadProfiles(repo, filePath, onReload);
    }, 300);
  };
  const monitor = createFileWatchMonitor({
    label: 'profiles.json', filePath, onChange: scheduleReload,
    warn: (message) => log.error(message),
  });
  return () => {
    monitor.close();
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
  };
}
