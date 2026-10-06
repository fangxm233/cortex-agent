import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from '@core/paths.js';
import { MEMORY_SUBDIRS, regenProject } from './index-regen.js';
import { createLogger } from '@core/log.js';

const log = createLogger('memory-watcher');

const DEBOUNCE_MS = 2000;
const RESCAN_DEBOUNCE_MS = 500;

const MEMORY_SUBDIR_NAMES: ReadonlySet<string> = new Set(MEMORY_SUBDIRS);

// fs.watch is not recursive here on purpose: project directories hold arbitrary trees (papers,
// data), so only three levels are watched — the projects root (new projects), each project
// (new memory subdirectories) and each memory subdirectory (atomic file writes).
const watchers = new Map<string, fs.FSWatcher>();
const pendingRegens = new Map<string, NodeJS.Timeout>();
let rescanTimer: NodeJS.Timeout | null = null;
let projectsDir = PROJECTS_DIR;
let regen: (project: string) => unknown = regenProject;
let debounceMs = DEBOUNCE_MS;

function scheduleRegen(projectName: string, reason: string): void {
  // Debounce: multiple rapid writes to the same project → single regen
  const pending = pendingRegens.get(projectName);
  if (pending) clearTimeout(pending);
  pendingRegens.set(projectName, setTimeout(() => {
    pendingRegens.delete(projectName);
    try {
      regen(projectName);
      log.info(`Index regenerated for ${projectName} (${reason})`);
    } catch (err) {
      log.error(`Failed to regen ${projectName}:`, err);
    }
  }, debounceMs));
}

function onFileChange(projectName: string, subdir: string, filename: string | null): void {
  // Only care about .md file changes (ignore index.md — we generate it)
  if (!filename || !filename.endsWith('.md') || filename === 'index.md') return;
  scheduleRegen(projectName, `triggered by ${subdir}/${filename}`);
}

function scheduleRescan(): void {
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    syncWatches(true);
  }, RESCAN_DEBOUNCE_MS);
}

function watchDir(dir: string, listener: (filename: string | null) => void): boolean {
  if (watchers.has(dir)) return false;
  try {
    const watcher = fs.watch(dir, (_eventType, filename) => listener(filename ? String(filename) : null));
    watcher.on('error', (err) => {
      log.warn(`Watcher error for ${dir}: ${err.message}`);
      watcher.close();
      watchers.delete(dir);
      scheduleRescan();
    });
    watchers.set(dir, watcher);
    return true;
  } catch (err) {
    log.error(`Failed to watch ${dir}:`, err);
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Attach watchers to every project and memory subdirectory not watched yet, and drop the ones
 *  whose directory is gone. A memory subdirectory that appears after startup gets one regen, since
 *  its files may have been written before the watcher attached. */
function syncWatches(regenNewDirs: boolean): void {
  for (const [dir, watcher] of watchers) {
    if (dir !== projectsDir && !isDirectory(dir)) {
      watcher.close();
      watchers.delete(dir);
    }
  }
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort();
  } catch {
    log.error('Cannot read projects directory');
    return;
  }
  for (const project of projects) {
    const projectDir = path.join(projectsDir, project);
    watchDir(projectDir, (name) => {
      if (name && MEMORY_SUBDIR_NAMES.has(name)) scheduleRescan();
    });
    for (const subdir of MEMORY_SUBDIRS) {
      const dir = path.join(projectDir, subdir);
      if (!isDirectory(dir)) continue;
      const added = watchDir(dir, (filename) => onFileChange(project, subdir, filename));
      if (added && regenNewDirs) scheduleRegen(project, `new directory ${subdir}/`);
    }
  }
}

export interface MemoryWatcherOptions {
  /** Test seams; production watches PROJECTS_DIR and runs regenProject. */
  projectsDir?: string;
  regen?: (project: string) => unknown;
  debounceMs?: number;
}

export function startMemoryWatcher(options: MemoryWatcherOptions = {}): void {
  projectsDir = options.projectsDir ?? PROJECTS_DIR;
  regen = options.regen ?? regenProject;
  debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  if (!watchDir(projectsDir, () => scheduleRescan())) {
    log.error('Cannot watch projects directory');
    return;
  }
  syncWatches(false);
  const memoryDirs = [...watchers.keys()].filter(dir => MEMORY_SUBDIR_NAMES.has(path.basename(dir))).length;
  log.info(`Watching ${memoryDirs} memory directories; new projects are picked up as they appear`);
}

export function stopMemoryWatcher(): void {
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  for (const timer of pendingRegens.values()) clearTimeout(timer);
  pendingRegens.clear();
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = null;
}
