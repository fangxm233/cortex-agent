import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import { createSnapshotWatchMonitor, type WatchMonitor } from '@core/resilient-watch.js';
import type { AgentDefinition } from '@core/types/environment-types.js';
import { ENVIRONMENTS_DIR } from './paths.js';
import { environmentPluginDirs } from '@domain/plugins/builtin.js';
import { fsRefResolver, resolveFileRef } from './file-refs.js';
import { validateEnvironment } from './schema.js';

const log = createLogger('environments');

/** Definitions with retired engine fields removed (no `file:` refs resolved), keyed by file name. */
let definitions: Record<string, AgentDefinition> = {};
let loaded = false;
let revision = 0;

export function getEnvironmentRevision(): number {
  return revision;
}

function readDefinitions(dir: string): Record<string, AgentDefinition> {
  if (!existsSync(dir)) return {};
  const out: Record<string, AgentDefinition> = {};
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    let body: unknown;
    try {
      body = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch (e: any) {
      log.warn(`Skipping malformed environment ${file}: ${e.message}`);
      continue;
    }
    // Diagnostic only: what loads is decided by the two hard checks below, so a validator that
    // disagrees with a file that works today never takes it away. Saves enforce the errors.
    const { errors, warnings } = validateEnvironment(name, body, fsRefResolver());
    for (const issue of errors) log.error(`environment ${name} — ${issue.path}: ${issue.message}`);
    for (const issue of warnings) log.warn(`environment ${name} — ${issue.path}: ${issue.message}`);
    const def = body as AgentDefinition;
    if (!def || typeof def !== 'object' || def.name !== name) {
      log.warn(`Skipping environment ${file}: name field "${(def as any)?.name}" ≠ filename`);
      continue;
    }
    delete (def as AgentDefinition & { profile?: unknown }).profile;
    out[name] = def;
  }
  return out;
}

/** (Re)read every environment under `dir`. A failure keeps nothing rather than a stale half. */
export function loadEnvironments(dir: string = ENVIRONMENTS_DIR): Record<string, AgentDefinition> {
  try {
    definitions = readDefinitions(dir);
  } catch (e: any) {
    log.error(`Failed to load environments from ${dir}: ${e.message}`);
    definitions = {};
  }
  loaded = true;
  revision += 1;
  log.info(`Loaded ${Object.keys(definitions).length} environments`);
  return definitions;
}

function ensureLoaded(): void {
  if (!loaded) loadEnvironments();
}

/**
 * The named environment, ready to run: `file:` prompt refs read, and `pluginDirs` made absolute
 * with every built-in plugin it does not opt out of added. Resolved on every call rather than at
 * load, so an edited prompt file takes effect on the next turn without a watcher on the prompts tree.
 */
export function getEnvironment(name: string): AgentDefinition | null {
  ensureLoaded();
  const def = definitions[name];
  if (!def) return null;
  const out = structuredClone(def);
  out.directive = resolveFileRef('directive', out.directive);
  out.systemPrompt = resolveFileRef('systemPrompt', out.systemPrompt);
  out.promptTemplate = resolveFileRef('promptTemplate', out.promptTemplate);
  const pluginDirs = environmentPluginDirs(out);
  if (pluginDirs) out.pluginDirs = pluginDirs;
  return out;
}

/** Every loaded environment as declared on disk, sorted by name. */
export function listEnvironments(): AgentDefinition[] {
  ensureLoaded();
  return Object.keys(definitions).sort().map((name) => definitions[name]);
}

// --- Defaults merge (copy-if-missing) ---

/** Copy every shipped environment the install does not have yet. Never overwrites: an existing
 *  file is the user's. Returns whether anything was added. */
export function mergeDefaultEnvironments(defaultsDir: string, userDir: string): boolean {
  if (!existsSync(defaultsDir)) {
    log.warn(`Cannot read default environments from ${defaultsDir}`);
    return false;
  }
  let changed = false;
  for (const file of readdirSync(defaultsDir)) {
    if (!file.endsWith('.json')) continue;
    const dst = path.join(userDir, file);
    if (existsSync(dst)) continue;
    try {
      mkdirSync(userDir, { recursive: true });
      writeFileSync(dst, readFileSync(path.join(defaultsDir, file), 'utf8'), 'utf8');
      log.info(`Added environment from defaults: ${file}`);
      changed = true;
    } catch (e: any) {
      log.error(`Failed to copy default environment ${file}: ${e.message}`);
    }
  }
  return changed;
}

// --- Hot reload ---

let watchMonitor: WatchMonitor | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(dir: string): string {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => {
        const stat = statSync(path.join(dir, file));
        return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
      })
      .join('|');
  } catch {
    return 'missing';
  }
}

function scheduleReload(dir: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    log.info('Detected change in environments, reloading...');
    loadEnvironments(dir);
  }, 300);
}

export function startEnvironmentWatcher(dir: string = ENVIRONMENTS_DIR): void {
  watchMonitor?.close();
  watchMonitor = createSnapshotWatchMonitor({
    label: 'environments',
    snapshot: () => snapshot(dir),
    onChange: () => scheduleReload(dir),
    startWatching: (onChange) => [watch(dir, () => onChange())],
    warn: (message) => log.error(message),
  });
}

export function stopEnvironmentWatcher(): void {
  watchMonitor?.close();
  watchMonitor = null;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = null;
}
