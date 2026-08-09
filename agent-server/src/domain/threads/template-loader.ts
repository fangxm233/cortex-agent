// input:  thread-template config, prompts, shells, resilient watch
// output: thread config load, migration, lookup, and hot reload APIs
// pos:    Thread template configuration loader and watcher
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync, mkdirSync, watch, type FSWatcher } from 'fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as path from 'path';
import { CONFIG_DIR, DATA_DIR, PROMPTS_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { createResilientWatchMonitor, type WatchMonitor } from '@core/resilient-watch.js';
import { Icons } from '../../core/icons.js';
import { resolveTemplate } from './template-resolver.js';
import { isShellBinding, expandShell } from './shell-templates.js';
import { validateRegistry, type RawRegistry, type RefResolver } from './template-validate.js';
import type { AgentDefinition, ThreadTemplate, ThreadConfigFile, ShellDefinition } from '@core/types/thread-types.js';

const log = createLogger('thread-manager');
/** Legacy single-file config (pre-Phase-2.5). Auto-migrated to CONFIG_TEMPLATES_DIR on startup. */
const CONFIG_FILE = path.join(CONFIG_DIR, 'thread-templates.json');
/** Directory-based config root (preferred). Exported for the write path. */
export const CONFIG_TEMPLATES_DIR = path.join(CONFIG_DIR, 'thread-templates');
const ENTITY_SUBDIRS = ['agents', 'templates', 'shells'] as const;
export const FILE_REF_PREFIX = 'file:';
const FIELD_DIRS: Record<string, string> = {
  directive: 'directives',
  promptTemplate: 'promptTemplates',
  systemPrompt: 'systemPrompts',
};

let agents: Record<string, AgentDefinition> = {};
let templates: Record<string, ThreadTemplate> = {};

// --- Admin notification (hot-reload → Slack) ---
let _adminNotifier: ((text: string) => void) | null = null;
export function setAdminNotifier(fn: (text: string) => void): void { _adminNotifier = fn; }

// --- File reference resolution ---
// Fields support "file:filename.md" syntax to read content from prompts/<subdir>/filename.md

/** Resolve a "file:<name>" reference for a given field. Returns value unchanged if not a file ref.
 *  Exported so prompt-builder.ts can resolve file refs on per-template agent overrides. */
export function resolveFileRef(field: string, value: string | undefined): string | undefined {
  if (!value || !value.startsWith(FILE_REF_PREFIX)) return value;
  const filename = value.slice(FILE_REF_PREFIX.length);
  const subdir = FIELD_DIRS[field];
  if (!subdir) return value;
  const filePath = path.join(PROMPTS_DIR, subdir, filename);
  try {
    const raw = readFileSync(filePath, 'utf8');
    const tplDir = path.join(PROMPTS_DIR, subdir, 'templates');
    return resolveTemplate(raw, tplDir);
  } catch (e: any) {
    log.error(`Failed to read ${field} file ref "${value}": ${e.message}`);
    return value;
  }
}

function resolveAgentFileRefs(agent: AgentDefinition): void {
  const resolved = resolveFileRef('directive', agent.directive);
  if (resolved !== undefined) agent.directive = resolved;
  const resolvedPT = resolveFileRef('promptTemplate', agent.promptTemplate);
  if (resolvedPT !== undefined) agent.promptTemplate = resolvedPT;
  const resolvedSP = resolveFileRef('systemPrompt', agent.systemPrompt);
  if (resolvedSP !== undefined) agent.systemPrompt = resolvedSP;
  if (agent.stages) {
    for (const stage of Object.values(agent.stages)) {
      const r = resolveFileRef('promptTemplate', stage.promptTemplate);
      if (r !== undefined) stage.promptTemplate = r;
    }
  }
}

/** Resolve a plugin directory path. Absolute paths are returned as-is;
 *  relative paths are resolved against DATA_DIR (plugins live under DATA_DIR/plugins/). */
export function resolvePluginDir(dir: string): string {
  if (path.isAbsolute(dir)) return dir;
  return path.join(DATA_DIR, dir);
}

/** In-place: resolve an agent's file refs and plugin dirs (shared by both load paths). */
function processAgent(agent: AgentDefinition): void {
  resolveAgentFileRefs(agent);
  if (agent.pluginDirs) agent.pluginDirs = agent.pluginDirs.map(resolvePluginDir);
}

/** Expand one template entry to a full ThreadTemplate, or null (logged) if it must be skipped.
 *  A shell binding whose shell is unknown or whose expansion fails is fail-soft skipped. */
function expandTemplateEntry(
  name: string,
  entry: unknown,
  shells: Record<string, ShellDefinition>,
  agentsMap: Record<string, AgentDefinition>,
): ThreadTemplate | null {
  if (isShellBinding(entry)) {
    const shell = shells[entry.shell];
    if (!shell) {
      log.error(`Skipping template "${name}": unknown shell "${entry.shell}"`);
      return null;
    }
    try {
      return expandShell(name, entry, shell, agentsMap);
    } catch (e: any) {
      log.error(`Skipping template "${name}": ${e.message}`);
      return null;
    }
  }
  return entry as ThreadTemplate;
}

// --- Config merging (defaults → user, directory form) ---

/** Recursively list every relative file path under `dir` (empty if dir is missing). */
function listFilesRecursive(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

const WORKER_REVIEW_SHELL = path.join('shells', 'worker-review.json');

function isLegacyWorkerReviewShell(shipped: any, installed: unknown): boolean {
  const legacy = structuredClone(shipped);
  const condition = legacy?.transitions?.[2]?.condition;
  if (condition?.type !== 'output_contains') return false;
  condition.type = 'output_not_contains';
  return isDeepStrictEqual(installed, legacy);
}

function upgradeLegacyWorkerReviewShell(defaultsDir: string, userDir: string): boolean {
  const shippedPath = path.join(defaultsDir, WORKER_REVIEW_SHELL);
  const installedPath = path.join(userDir, WORKER_REVIEW_SHELL);
  if (!existsSync(shippedPath) || !existsSync(installedPath)) return false;
  try {
    const shippedText = readFileSync(shippedPath, 'utf8');
    const shipped = JSON.parse(shippedText);
    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    if (!isLegacyWorkerReviewShell(shipped, installed)) return false;
    writeFileSync(installedPath, shippedText, 'utf8');
    log.info(`Upgraded legacy thread-templates file: ${WORKER_REVIEW_SHELL}`);
    return true;
  } catch (e: any) {
    log.error(`Failed to upgrade legacy thread-templates file ${WORKER_REVIEW_SHELL}: ${e.message}`);
    return false;
  }
}

function copyMissingTemplateFile(defaultsDir: string, userDir: string, rel: string): boolean {
  const dst = path.join(userDir, rel);
  if (existsSync(dst)) return false;
  try {
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(path.join(defaultsDir, rel), 'utf8'), 'utf8');
    log.info(`Added thread-templates file from defaults: ${rel}`);
    return true;
  } catch (e: any) {
    log.error(`Failed to copy default thread-templates file ${rel}: ${e.message}`);
    return false;
  }
}

/** Merge missing shipped templates and upgrade the unchanged legacy worker-review shell. */
export function mergeThreadTemplates(defaultsDir: string, userDir: string): boolean {
  if (!existsSync(defaultsDir)) {
    log.warn(`Cannot read default thread-templates dir from ${defaultsDir}`);
    return false;
  }
  let changed = upgradeLegacyWorkerReviewShell(defaultsDir, userDir);
  for (const rel of listFilesRecursive(defaultsDir)) {
    changed = copyMissingTemplateFile(defaultsDir, userDir, rel) || changed;
  }
  return changed;
}

// --- One-time migration: legacy single file → directory ---

function writeEntityFile(dir: string, name: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * One-time startup migration: if the legacy single file exists and the directory does not,
 * split the single file into per-entity files under CONFIG_TEMPLATES_DIR (one file per agent /
 * template / shell) and rename the old file to `thread-templates.json.migrated-bak` (content
 * preserved, never deleted). Idempotent: no-op once the directory exists or the file is gone.
 *
 * @returns true if a migration was performed.
 */
export function migrateThreadTemplatesToDir(): boolean {
  if (!existsSync(CONFIG_FILE) || existsSync(CONFIG_TEMPLATES_DIR)) return false;
  let data: ThreadConfigFile;
  try {
    data = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e: any) {
    log.warn(`Migration skipped: cannot parse ${CONFIG_FILE}: ${e.message}`);
    return false;
  }
  const agentsDir = path.join(CONFIG_TEMPLATES_DIR, 'agents');
  const templatesDir = path.join(CONFIG_TEMPLATES_DIR, 'templates');
  const shellsDir = path.join(CONFIG_TEMPLATES_DIR, 'shells');
  for (const [name, agent] of Object.entries(data.agents || {})) writeEntityFile(agentsDir, name, agent);
  for (const [name, tpl] of Object.entries(data.templates || {})) writeEntityFile(templatesDir, name, tpl);
  for (const [name, shell] of Object.entries(data.shells || {})) writeEntityFile(shellsDir, name, shell);
  mkdirSync(shellsDir, { recursive: true }); // ensure the (possibly empty) shells dir exists
  renameSync(CONFIG_FILE, `${CONFIG_FILE}.migrated-bak`);
  log.info(
    `Migrated thread-templates.json → thread-templates/ ` +
    `(${Object.keys(data.agents || {}).length} agents, ${Object.keys(data.templates || {}).length} templates); ` +
    `original preserved as thread-templates.json.migrated-bak`,
  );
  return true;
}

// --- Config loading ---

interface LoadedConfig {
  agents: Record<string, AgentDefinition>;
  templates: Record<string, ThreadTemplate>;
  /** Bodies exactly as they sit on disk — captured before processAgent resolves `file:` refs in
   *  place, and including files the loader skipped, so validation reports what the user wrote. */
  raw?: RawRegistry;
}

/** Read every `<name>.json` in a subdir as { name, data }, fail-soft skipping unparseable files. */
function readEntityDir(dir: string): Array<{ name: string; data: any }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; data: any }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    try {
      out.push({ name, data: JSON.parse(readFileSync(path.join(dir, file), 'utf8')) });
    } catch (e: any) {
      log.warn(`Skipping malformed thread-templates file ${path.basename(dir)}/${file}: ${e.message}`);
    }
  }
  return out;
}

/** Load config from the directory form (one file per entity; merged across files). */
function loadConfigFromDir(dir: string): LoadedConfig {
  const raw: RawRegistry = { agents: {}, templates: {}, shells: {} };
  const a: Record<string, AgentDefinition> = {};
  for (const { name, data } of readEntityDir(path.join(dir, 'agents'))) {
    raw.agents[name] = structuredClone(data);
    if (!data.name || data.name !== name) {
      log.warn(`Skipping agent file agents/${name}.json: name field "${data.name}" ≠ filename`);
      continue;
    }
    processAgent(data);
    a[name] = data;
  }

  const shells: Record<string, ShellDefinition> = {};
  for (const { name, data } of readEntityDir(path.join(dir, 'shells'))) {
    raw.shells[name] = structuredClone(data);
    shells[name] = data;
  }

  const t: Record<string, ThreadTemplate> = {};
  for (const { name, data } of readEntityDir(path.join(dir, 'templates'))) {
    raw.templates[name] = structuredClone(data);
    if (data.name !== undefined && data.name !== name) {
      log.warn(`Skipping template file templates/${name}.json: name field "${data.name}" ≠ filename`);
      continue;
    }
    const expanded = expandTemplateEntry(name, data, shells, a);
    if (expanded) t[name] = expanded;
  }
  return { agents: a, templates: t, raw };
}

/** Filesystem probes for the validator's `file:` ref and pluginDirs existence checks. */
export function loaderRefResolver(): RefResolver {
  return {
    promptsDir: PROMPTS_DIR,
    pluginBaseDir: DATA_DIR,
    join: path.join,
    exists: existsSync,
    isAbsolute: path.isAbsolute,
  };
}

/**
 * Report what is wrong with the config as loaded. Diagnostic only — the loader's own fail-soft skip
 * logic still decides what actually loads, so a validator that disagrees with a file that works
 * today can never take it away. The write path is where errors are enforced.
 */
function logValidation(raw: RawRegistry): void {
  let errors = 0;
  let warnings = 0;
  for (const [key, result] of validateRegistry(raw, loaderRefResolver())) {
    for (const issue of result.errors) {
      log.error(`thread-template ${key} — ${issue.path}: ${issue.message}`);
      errors++;
    }
    for (const issue of result.warnings) {
      log.warn(`thread-template ${key} — ${issue.path}: ${issue.message}`);
      warnings++;
    }
  }
  if (errors > 0 || warnings > 0) {
    log.warn(`Thread-template validation: ${errors} error(s), ${warnings} warning(s)`);
  }
}

/** Load config from the legacy single file. Shell bindings here have no shell defs to resolve
 *  against (shells only exist in the directory form) and are fail-soft skipped. */
function loadConfigFromFile(file: string): LoadedConfig {
  const data: ThreadConfigFile = JSON.parse(readFileSync(file, 'utf8'));
  const a = data.agents || {};
  for (const agent of Object.values(a)) processAgent(agent);
  const shells = data.shells || {};
  const t: Record<string, ThreadTemplate> = {};
  for (const [name, entry] of Object.entries(data.templates || {})) {
    const expanded = expandTemplateEntry(name, entry, shells, a);
    if (expanded) t[name] = expanded;
  }
  return { agents: a, templates: t };
}

export function loadConfig(): { agents: Record<string, AgentDefinition>; templates: Record<string, ThreadTemplate> } {
  try {
    const loaded = existsSync(CONFIG_TEMPLATES_DIR)
      ? loadConfigFromDir(CONFIG_TEMPLATES_DIR)
      : loadConfigFromFile(CONFIG_FILE);
    agents = loaded.agents;
    templates = loaded.templates;
    log.info(`Loaded ${Object.keys(agents).length} agents, ${Object.keys(templates).length} templates`);
    if (loaded.raw) logValidation(loaded.raw);
  } catch (e: any) {
    log.error(`Failed to load config: ${e.message}`);
    agents = {};
    templates = {};
  }
  return { agents, templates };
}

// --- Config hot-reload ---
// Watches the config dir (or legacy single file) for external changes and reloads on modification.
// Directory form watches each flat entity subdir for adds, edits, and removes. Legacy single-file
// form watches CONFIG_DIR so atomic replacement does not invalidate the watcher.

let _configWatchMonitor: WatchMonitor | null = null;
let _reloadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleConfigReload(label: string): void {
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(() => {
    _reloadTimer = null;
    log.info(`Detected change in ${label}, reloading...`);
    _adminNotifier?.(`${Icons.refresh} \`${label}\` hot-reloaded`);
    loadConfig();
  }, 300);
}

function pathStamp(filePath: string): string {
  try {
    const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    return `${filePath}:${digest}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function threadConfigSnapshot(): string {
  if (!existsSync(CONFIG_TEMPLATES_DIR)) return pathStamp(CONFIG_FILE);
  const parts: string[] = [];
  for (const sub of ENTITY_SUBDIRS) {
    const dir = path.join(CONFIG_TEMPLATES_DIR, sub);
    try {
      const files = readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
      parts.push(`${sub}:${files.map((file) => pathStamp(path.join(dir, file))).join(',')}`);
    } catch {
      parts.push(`${sub}:missing`);
    }
  }
  return parts.join('|');
}

function startConfigFsWatchers(onChange: (label: string) => void): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  try {
    if (existsSync(CONFIG_TEMPLATES_DIR)) {
      for (const sub of ENTITY_SUBDIRS) {
        const dir = path.join(CONFIG_TEMPLATES_DIR, sub);
        if (existsSync(dir)) watchers.push(watch(dir, () => onChange(`thread-templates/${sub}`)));
      }
    } else {
      const filename = path.basename(CONFIG_FILE);
      watchers.push(watch(CONFIG_DIR, (_event, changed) => {
        if (changed === null || changed.toString() === filename) onChange('thread-templates.json');
      }));
    }
    if (watchers.length === 0) throw new Error('no thread-template paths exist');
    return watchers;
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
}

function setupConfigWatch(): void {
  _configWatchMonitor?.close();
  let observedSnapshot = threadConfigSnapshot();
  const handleChange = (label: string) => {
    const nextSnapshot = threadConfigSnapshot();
    if (nextSnapshot === observedSnapshot) return;
    observedSnapshot = nextSnapshot;
    scheduleConfigReload(label);
  };
  const poll = () => {
    const nextSnapshot = threadConfigSnapshot();
    if (nextSnapshot === observedSnapshot) return;
    observedSnapshot = nextSnapshot;
    scheduleConfigReload('thread-templates');
  };
  _configWatchMonitor = createResilientWatchMonitor({
    label: 'thread-templates config', poll,
    startWatching: () => startConfigFsWatchers(handleChange),
    warn: (message) => log.error(message),
  });
  poll();
}

// --- Prompts directory hot-reload ---

let _promptsWatchers: FSWatcher[] = [];
let _promptsReloadTimer: ReturnType<typeof setTimeout> | null = null;

function startPromptsWatcher(): void {
  stopPromptsWatcher();
  for (const subdir of Object.values(FIELD_DIRS)) {
    for (const rel of [subdir, `${subdir}/templates`]) {
      const dir = path.join(PROMPTS_DIR, rel);
      try {
        if (!existsSync(dir)) continue;
        const w = watch(dir, (_eventType, filename) => {
          if (_promptsReloadTimer) clearTimeout(_promptsReloadTimer);
          _promptsReloadTimer = setTimeout(() => {
            _promptsReloadTimer = null;
            log.info(`Detected change in prompts/${rel}/${filename || '?'}, reloading config...`);
            _adminNotifier?.(`${Icons.refresh} prompts/\`${rel}/${filename || '?'}\` changed — thread-templates reloaded`);
            loadConfig();
          }, 300);
        });
        _promptsWatchers.push(w);
      } catch (e: any) {
        log.error(`Failed to watch prompts/${rel}: ${e.message}`);
      }
    }
  }
}

function stopPromptsWatcher(): void {
  for (const w of _promptsWatchers) w.close();
  _promptsWatchers = [];
  if (_promptsReloadTimer) {
    clearTimeout(_promptsReloadTimer);
    _promptsReloadTimer = null;
  }
}

export function startConfigWatcher(): void {
  setupConfigWatch();
  startPromptsWatcher();
}

export function stopConfigWatcher(): void {
  _configWatchMonitor?.close();
  _configWatchMonitor = null;
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = null;
  stopPromptsWatcher();
}

// --- Agent and template lookup ---

export function getAgent(name: string): AgentDefinition | null {
  return agents[name] || null;
}

export function listAgents(): AgentDefinition[] {
  return Object.values(agents);
}

export function getTemplate(name: string): ThreadTemplate | null {
  return templates[name] || null;
}

export function listTemplates(): ThreadTemplate[] {
  return Object.values(templates);
}

export function listTemplateNames(): string[] {
  return Object.keys(templates);
}
