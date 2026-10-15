import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from '@core/paths.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { createLogger } from '@core/log.js';
import { createFileWatchMonitor } from '@core/resilient-watch.js';
import { Icons } from '@core/icons.js';
import type { ModelsFile } from '@domain/agents/engine-selection.js';

const log = createLogger('models-repo');
let modelsConfigRevision = 0;
export const MODELS_FILE = path.join(CONFIG_DIR, 'models.json');
// UI mutations and login sync must hold this across read, write, and invalidation.
export const modelsWriteLock = new AsyncMutex();

export function getModelsConfigRevision(): number { return modelsConfigRevision; }

export class ModelsRepo {
  private cache: ModelsFile | null = null;

  constructor(private readonly filePath: string = MODELS_FILE) {}

  readSync(): ModelsFile {
    if (!this.cache) this.cache = JSON.parse(readFileSync(this.filePath, 'utf8')) as ModelsFile;
    return this.cache;
  }

  readIfPresent(): ModelsFile | null {
    try { return this.readSync(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  invalidate(): void { this.cache = null; modelsConfigRevision += 1; }

  /** Parse before replacing the cache: a failed reload keeps the last usable snapshot. */
  reload(): void {
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as ModelsFile;
    this.cache = parsed;
  }
}

export const modelsRepo = new ModelsRepo();
let adminNotifier: ((text: string) => void) | null = null;
export function setAdminNotifier(fn: (text: string) => void): void { adminNotifier = fn; }

function reloadModels(repo: ModelsRepo, onReload?: () => void): void {
  try {
    repo.reload();
    modelsConfigRevision += 1;
    onReload?.();
    log.info('Hot-reload: models.json reloaded');
    adminNotifier?.(`${Icons.refresh} \`models.json\` hot-reloaded`);
  } catch (error) {
    log.error(`Hot-reload models.json failed: ${(error as Error).message} — keeping previous config`);
    adminNotifier?.(`${Icons.warning} \`models.json\` hot-reload FAILED — keeping previous config`);
  }
}

export function startModelsWatcher(
  repo: ModelsRepo = modelsRepo,
  filePath: string = MODELS_FILE,
  onReload?: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; reloadModels(repo, onReload); }, 300);
  };
  const monitor = createFileWatchMonitor({
    label: 'models.json', filePath, onChange, warn: (message) => log.error(message),
  });
  return () => {
    monitor.close();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
