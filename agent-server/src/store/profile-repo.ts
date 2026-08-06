// input:  profiles.json, JsonRepository, resilient file monitor
// output: ProfileRepo and polling-backed hot reload
// pos:    Profile persistence, sync cache, and hot reload
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readFileSync } from 'fs';
import * as path from 'path';
import { JsonRepository } from '@core/json-repository.js';
import { CONFIG_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { createFileWatchMonitor } from '@core/resilient-watch.js';
import { Icons } from '../core/icons.js';
import type { ProfilesFile } from '@domain/agents/profile-manager.js';

const log = createLogger('profile-repo');

export const PROFILES_FILE = path.join(CONFIG_DIR, 'profiles.json');

export class ProfileRepo {
  private readonly _repo: JsonRepository<ProfilesFile>;
  private readonly _filePath: string;
  private _syncCache: ProfilesFile | null = null;

  constructor(filePath: string = PROFILES_FILE) {
    this._filePath = filePath;
    this._repo = new JsonRepository<ProfilesFile>({
      filePath,
      // profiles.json is required; throw immediately if not present.
      // Matches existing loadProfilesFile() behavior which throws on ENOENT.
      defaultValue: () => { throw new Error(`profiles.json not found at ${filePath}`); },
      // Basic cast; full schema validation is performed by profile-manager.ts callers
      // (validateProfilesFile) to avoid a circular runtime import.
      migrate: (raw) => raw as ProfilesFile,
    });
  }

  async read(): Promise<ProfilesFile> {
    const data = await this._repo.read();
    this._syncCache = data;
    return data;
  }

  /**
   * Synchronous read for legacy sync callers (profile-manager.ts public API).
   * First call reads from disk; subsequent calls serve from cache. save()/mutate()
   * update the cache on success so sync readers see fresh data.
   */
  readSync(): ProfilesFile {
    if (this._syncCache) return this._syncCache;
    const raw = readFileSync(this._filePath, 'utf8');
    const parsed = JSON.parse(raw) as ProfilesFile;
    this._syncCache = parsed;
    return parsed;
  }

  async save(data: ProfilesFile): Promise<void> {
    await this._repo.write(data);
    this._syncCache = data;
  }

  async mutate<R>(fn: (cur: ProfilesFile) => { next: ProfilesFile; result: R }): Promise<R> {
    return this._repo.mutate((cur) => {
      const { next, result } = fn(cur);
      this._syncCache = next;
      return { next, result };
    });
  }

  /** Drop the in-memory cache so the next read() fetches from disk. Test hook. */
  invalidate(): void {
    this._repo.invalidate();
    this._syncCache = null;
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this._repo.flush();
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
