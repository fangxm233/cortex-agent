// input:  CONFIG_DIR, settings spec, process env, filesystem
// output: validated snapshots and disk-reconciled settings updates
// pos:    L0 file-backed runtime settings boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { AsyncMutex } from './async-mutex.js';
import { atomicWrite } from './atomic-write.js';
import { createLogger } from './log.js';
import { CONFIG_DIR } from './paths.js';
import {
  SETTINGS_SPEC,
  type SettingKey,
  type SettingSnapshotEntry,
  type SettingSpecEntry,
  type Settings,
  type SettingType,
} from './settings-spec.js';

export {
  SETTINGS_SPEC,
  type SettingKey,
  type SettingSnapshotEntry,
  type Settings,
} from './settings-spec.js';

export type SettingsChangeCallback = (changedKeys: SettingKey[]) => void;

const log = createLogger('settings');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const SETTING_KEYS = Object.keys(SETTINGS_SPEC) as SettingKey[];
const TRUTHY_ENV_KEYS = new Set<SettingKey>(['adminChannel', 'feishuAdminChannel']);
const callbacks = new Set<SettingsChangeCallback>();
const loggedEnvFallbacks = new Set<string>();
const writeMutex = new AsyncMutex();

let initialized = false;
let cachedOverrides: Record<string, unknown> = {};
let cachedSettings: Settings | null = null;
let cachedSettingsSnapshot: SettingSnapshotEntry[] | null = null;
let settingsWatcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let selfWriting = false;

const typeValidators: Record<SettingType, (value: unknown) => boolean> = {
  boolean: (value) => typeof value === 'boolean',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  'number|null': (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
  'string[]': (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  'string|null': (value) => value === null || typeof value === 'string',
};

export function validateSettingsOverrides(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('settings.json must contain a JSON object');
  }
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = SETTINGS_SPEC[key];
    if (!typeValidators[entry.type](value[key])) {
      throw new TypeError(`settings.json key "${key}" must have type ${entry.type}`);
    }
  }
}

function readOverrides(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as unknown;
    validateSettingsOverrides(parsed);
    return parsed;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function logEnvFallback(key: SettingKey, envVar: string): void {
  if (loggedEnvFallbacks.has(envVar)) return;
  loggedEnvFallbacks.add(envVar);
  log.warn(`Deprecated env ${envVar} supplies settings.${key}; move it to settings.json`);
}

function resolveSettingEntry<K extends SettingKey>(
  key: K,
  overrides: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  warnOnEnv: boolean,
): SettingSnapshotEntry<K> {
  const entry = SETTINGS_SPEC[key] as SettingSpecEntry<Settings[K]>;
  if (Object.hasOwn(overrides, key)) {
    return { key, value: overrides[key] as Settings[K], source: 'file' };
  }
  const envVars = typeof entry.envVar === 'string' ? [entry.envVar] : entry.envVar;
  for (const envVar of envVars) {
    const raw = env[envVar];
    if (raw === undefined || (TRUTHY_ENV_KEYS.has(key) && raw.length === 0)) continue;
    if (warnOnEnv) logEnvFallback(key, envVar);
    return { key, value: entry.legacyParse(raw), source: 'env' };
  }
  return { key, value: entry.default, source: 'default' };
}

export function resolveSettingsSnapshot(
  overrides: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): SettingSnapshotEntry[] {
  validateSettingsOverrides(overrides);
  return SETTING_KEYS.map((key) => resolveSettingEntry(key, overrides, env, false));
}

function resolveSettings(overrides: Record<string, unknown>): Settings {
  return Object.fromEntries(
    SETTING_KEYS.map((key) => {
      const entry = resolveSettingEntry(key, overrides, process.env, true);
      return [key, entry.value];
    }),
  ) as unknown as Settings;
}

function sameValue(left: Settings[SettingKey], right: Settings[SettingKey]): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return Object.is(left, right);
}

function changedKeys(previous: Settings, next: Settings): SettingKey[] {
  return SETTING_KEYS.filter((key) => !sameValue(previous[key], next[key]));
}

function emitChanges(previous: Settings, next: Settings): void {
  const changed = changedKeys(previous, next);
  if (changed.length === 0) return;
  for (const callback of callbacks) {
    try {
      callback(changed);
    } catch (error) {
      log.error('Settings change callback failed:', error);
    }
  }
}

function settingsFromSnapshot(snapshot: SettingSnapshotEntry[]): Settings {
  return Object.fromEntries(snapshot.map((entry) => [entry.key, entry.value])) as unknown as Settings;
}

function snapshotWithValues(
  overrides: Record<string, unknown>,
  settings: Settings,
): SettingSnapshotEntry[] {
  return resolveSettingsSnapshot(overrides).map((entry) => ({
    key: entry.key,
    value: settings[entry.key],
    source: entry.source,
  }));
}

function acceptSnapshot(
  overrides: Record<string, unknown>,
  next: Settings,
  snapshot = snapshotWithValues(overrides, next),
): void {
  const previous = cachedSettings;
  cachedOverrides = overrides;
  cachedSettings = next;
  cachedSettingsSnapshot = snapshot;
  if (previous) emitChanges(previous, next);
}

function sameOverrides(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadSettings();
  }, 300);
}

function reloadSettings(): void {
  if (selfWriting) return scheduleReload();
  try {
    const overrides = readOverrides();
    if (sameOverrides(cachedOverrides, overrides)) return;
    acceptSnapshot(overrides, resolveSettings(overrides));
    log.info('Hot-reload: settings.json reloaded');
  } catch (error) {
    log.error(`Hot-reload settings.json failed: ${(error as Error).message} — keeping previous settings`);
  }
}

function handleWatchEvent(filename: string | Buffer | null): void {
  if (filename !== null && filename.toString() !== 'settings.json') return;
  scheduleReload();
}

function startWatcher(): void {
  try {
    settingsWatcher = watch(CONFIG_DIR, (_eventType, filename) => handleWatchEvent(filename));
    settingsWatcher.on('error', (error) => log.error('settings.json watcher failed:', error));
    settingsWatcher.unref();
  } catch (error) {
    log.error('Failed to watch settings.json:', error);
  }
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  startWatcher();
  try {
    const overrides = readOverrides();
    acceptSnapshot(overrides, resolveSettings(overrides));
  } catch (error) {
    log.error(`Load settings.json failed: ${(error as Error).message} — using env/default settings`);
    acceptSnapshot({}, resolveSettings({}));
  }
}

export function getSettings(): Settings {
  initialize();
  return cachedSettings!;
}

export function getSettingsSnapshot(): SettingSnapshotEntry[] {
  initialize();
  return cachedSettingsSnapshot!;
}

export function onSettingsChange(callback: SettingsChangeCallback): () => void {
  initialize();
  callbacks.add(callback);
  return () => callbacks.delete(callback);
}

function readOverridesForUpdate(): Record<string, unknown> {
  try {
    return readOverrides();
  } catch (error) {
    log.error(`Update settings.json read failed: ${(error as Error).message} — using previous settings`);
    return cachedOverrides;
  }
}

export async function updateSettings(partial: Partial<Settings>): Promise<void> {
  initialize();
  const env = { ...process.env };
  await writeMutex.run(async () => {
    const nextOverrides = { ...readOverridesForUpdate(), ...partial };
    const nextSnapshot = resolveSettingsSnapshot(nextOverrides, env);
    const nextSettings = settingsFromSnapshot(nextSnapshot);
    selfWriting = true;
    try {
      await atomicWrite(SETTINGS_FILE, `${JSON.stringify(nextOverrides, null, 2)}\n`);
      acceptSnapshot(nextOverrides, nextSettings, nextSnapshot);
    } finally {
      selfWriting = false;
    }
  });
}
