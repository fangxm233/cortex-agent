import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from '@core/utils.js';
import { regenProject } from './index-regen.js';
import { createLogger } from '@core/log.js';

const log = createLogger('memory-watcher');

const MEMORY_SUBDIRS = ['experiments', 'knowledge', 'patterns'];
const DEBOUNCE_MS = 2000;

const watchers: fs.FSWatcher[] = [];
const pendingRegens = new Map<string, NodeJS.Timeout>();

function onFileChange(projectName: string, subdir: string, filename: string | null): void {
  // Only care about .md file changes (ignore index.md — we generate it)
  if (!filename || !filename.endsWith('.md') || filename === 'index.md') return;

  // Debounce: multiple rapid writes to the same project → single regen
  if (pendingRegens.has(projectName)) {
    clearTimeout(pendingRegens.get(projectName)!);
  }

  pendingRegens.set(projectName, setTimeout(() => {
    pendingRegens.delete(projectName);
    try {
      regenProject(projectName);
      log.info(`Index regenerated for ${projectName} (triggered by ${subdir}/${filename})`);
    } catch (err) {
      log.error(`Failed to regen ${projectName}:`, err);
    }
  }, DEBOUNCE_MS));
}

export function startMemoryWatcher(): void {
  // Discover all project directories with memory subdirs
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR).filter(d =>
      fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()
    );
  } catch {
    log.error('Cannot read projects directory');
    return;
  }

  let watchCount = 0;

  for (const project of projectDirs) {
    for (const subdir of MEMORY_SUBDIRS) {
      const dir = path.join(PROJECTS_DIR, project, subdir);
      if (!fs.existsSync(dir)) continue;

      try {
        const watcher = fs.watch(dir, (eventType, filename) => {
          // On Linux, 'rename' fires for create/delete; 'change' for modify
          onFileChange(project, subdir, filename);
        });

        watcher.on('error', (err) => {
          log.error(`Watcher error for ${project}/${subdir}:`, err.message);
        });

        watchers.push(watcher);
        watchCount++;
      } catch (err) {
        log.error(`Failed to watch ${project}/${subdir}:`, err);
      }
    }
  }

  log.info(`Watching ${watchCount} directories across ${projectDirs.length} projects`);
}

export function stopMemoryWatcher(): void {
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers.length = 0;

  for (const timer of pendingRegens.values()) {
    clearTimeout(timer);
  }
  pendingRegens.clear();

  log.info('Stopped');
}
