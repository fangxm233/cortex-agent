// input:  CONFIG_DIR, process env, filesystem
// output: settings spec and read/watch/write API
// pos:    L0 file-backed runtime settings boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { AsyncMutex } from './async-mutex.js';
import { atomicWrite } from './atomic-write.js';
import { createLogger } from './log.js';
import { CONFIG_DIR } from './paths.js';

export interface Settings {
  turnNotify: boolean;
  turnNotifyThresholdS: number;
  notifyCompaction: boolean;
  showToolCalls: boolean;
  statusNewqButton: boolean;
  autoResume: boolean;
  streamDeltas: boolean;
  bgContinuation: boolean;
  eventLog: boolean;
  disableUserContext: boolean;
  serverUpdateDisable: boolean;
  hooksLegacy: boolean;
  managerRotateSteps: number;
  waitingSweepMs: number;
  injectWaitMaxS: number;
  threadMaxDepth: number;
  taskArtifactTemplates: string[];
  taskDispatchMaxConcurrent: number | null;
  uiCorsOrigins: string[];
  adminChannel: string | null;
  feishuAdminChannel: string | null;
}

export type SettingKey = keyof Settings;
export type SettingsChangeCallback = (changedKeys: SettingKey[]) => void;

type SettingType = 'boolean' | 'number' | 'number|null' | 'string[]' | 'string|null';
type EnvVar = string | readonly string[];

interface SettingSpecEntry<T> {
  envVar: EnvVar;
  type: SettingType;
  default: T;
  legacyParse: (raw: string) => T;
}

type SettingsSpec = { [K in SettingKey]: SettingSpecEntry<Settings[K]> };

export const SETTINGS_SPEC = {
  turnNotify: {
    envVar: 'CORTEX_TURN_NOTIFY',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase()),
  },
  turnNotifyThresholdS: {
    envVar: 'CORTEX_TURN_NOTIFY_THRESHOLD_S',
    type: 'number',
    default: 60,
    legacyParse: (raw: string) => {
      const value = Number(raw.trim());
      return Number.isFinite(value) && value > 0 ? value : 60;
    },
  },
  notifyCompaction: {
    envVar: 'CORTEX_NOTIFY_COMPACTION',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  showToolCalls: {
    envVar: 'CORTEX_SHOW_TOOL_CALLS',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase()),
  },
  statusNewqButton: {
    envVar: 'CORTEX_STATUS_NEWQ_BUTTON',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase()),
  },
  autoResume: {
    envVar: 'CORTEX_AUTO_RESUME',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => raw !== '0' && raw !== 'false',
  },
  streamDeltas: {
    envVar: 'CORTEX_STREAM_DELTAS',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => raw !== '0',
  },
  bgContinuation: {
    envVar: 'CORTEX_BG_CONTINUATION',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase()),
  },
  eventLog: {
    envVar: 'CORTEX_EVENT_LOG',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => raw !== 'off',
  },
  disableUserContext: {
    envVar: 'CORTEX_DISABLE_USER_CONTEXT',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  serverUpdateDisable: {
    envVar: 'CORTEX_SERVER_UPDATE_DISABLE',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  hooksLegacy: {
    envVar: 'CORTEX_HOOKS_LEGACY',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  managerRotateSteps: {
    envVar: 'CORTEX_MANAGER_ROTATE_STEPS',
    type: 'number',
    default: 10,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw || '', 10);
      return Number.isFinite(value) && value > 0 ? value : 10;
    },
  },
  waitingSweepMs: {
    envVar: 'CORTEX_WAITING_SWEEP_MS',
    type: 'number',
    default: 60_000,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw || '', 10);
      return Number.isFinite(value) ? value : 60_000;
    },
  },
  injectWaitMaxS: {
    envVar: 'CORTEX_INJECT_WAIT_MAX_S',
    type: 'number',
    default: 600,
    legacyParse: (raw: string) => Number(raw),
  },
  threadMaxDepth: {
    envVar: 'CORTEX_THREAD_MAX_DEPTH',
    type: 'number',
    default: 5,
    legacyParse: (raw: string) => Number.parseInt(raw || '5', 10) || 5,
  },
  taskArtifactTemplates: {
    envVar: 'CORTEX_TASK_ARTIFACT_TEMPLATES',
    type: 'string[]',
    default: ['manager'],
    legacyParse: (raw: string) => raw.split(',').map((value) => value.trim()).filter(Boolean),
  },
  taskDispatchMaxConcurrent: {
    envVar: 'TASK_DISPATCH_MAX_CONCURRENT',
    type: 'number|null',
    default: null,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw, 10);
      return raw.trim() && Number.isFinite(value) && value > 0 ? value : null;
    },
  },
  uiCorsOrigins: {
    envVar: 'CORTEX_UI_CORS_ORIGINS',
    type: 'string[]',
    default: [],
    legacyParse: (raw: string) => raw.split(',').map((value) => value.trim()).filter(Boolean),
  },
  adminChannel: {
    envVar: ['SLACK_ADMIN_CHANNEL', 'CORTEX_ADMIN_CHANNEL'],
    type: 'string|null',
    default: null,
    legacyParse: (raw: string) => raw || null,
  },
  feishuAdminChannel: {
    envVar: 'FEISHU_ADMIN_CHANNEL',
    type: 'string|null',
    default: null,
    legacyParse: (raw: string) => raw || null,
  },
} satisfies SettingsSpec;

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

function validateOverrides(value: unknown): asserts value is Record<string, unknown> {
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
    validateOverrides(parsed);
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

function resolveLegacy<K extends SettingKey>(key: K): Settings[K] {
  const entry = SETTINGS_SPEC[key] as SettingSpecEntry<Settings[K]>;
  const envVars = typeof entry.envVar === 'string' ? [entry.envVar] : entry.envVar;
  for (const envVar of envVars) {
    const raw = process.env[envVar];
    if (raw === undefined) continue;
    if (TRUTHY_ENV_KEYS.has(key) && raw.length === 0) continue;
    logEnvFallback(key, envVar);
    return entry.legacyParse(raw);
  }
  return entry.default;
}

function resolveSetting<K extends SettingKey>(key: K, overrides: Record<string, unknown>): Settings[K] {
  if (Object.hasOwn(overrides, key)) return overrides[key] as Settings[K];
  return resolveLegacy(key);
}

function resolveSettings(overrides: Record<string, unknown>): Settings {
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, resolveSetting(key, overrides)]),
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

function acceptSnapshot(overrides: Record<string, unknown>, next: Settings): void {
  const previous = cachedSettings;
  cachedOverrides = overrides;
  cachedSettings = next;
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
  if (filename?.toString() !== 'settings.json') return;
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
  try {
    cachedOverrides = readOverrides();
    cachedSettings = resolveSettings(cachedOverrides);
  } catch (error) {
    log.error(`Load settings.json failed: ${(error as Error).message} — using env/default settings`);
    cachedOverrides = {};
    cachedSettings = resolveSettings(cachedOverrides);
  }
  startWatcher();
}

export function getSettings(): Settings {
  initialize();
  return cachedSettings!;
}

export function onSettingsChange(callback: SettingsChangeCallback): () => void {
  initialize();
  callbacks.add(callback);
  return () => callbacks.delete(callback);
}

export async function updateSettings(partial: Partial<Settings>): Promise<void> {
  initialize();
  await writeMutex.run(async () => {
    const nextOverrides = { ...cachedOverrides, ...partial };
    validateOverrides(nextOverrides);
    const nextSettings = resolveSettings(nextOverrides);
    selfWriting = true;
    try {
      await atomicWrite(SETTINGS_FILE, `${JSON.stringify(nextOverrides, null, 2)}\n`);
      acceptSnapshot(nextOverrides, nextSettings);
    } finally {
      selfWriting = false;
    }
  });
}
