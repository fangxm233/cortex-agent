// input:  CONFIG_DIR, settings spec, env, and per-window provider policy patches
// output: validated settings, exact policy writes, disk updates, hot reload, and test reset
// pos:    File-backed runtime settings boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AsyncMutex } from './async-mutex.js';
import { atomicWrite } from './atomic-write.js';
import { createLogger } from './log.js';
import { CONFIG_DIR } from './paths.js';
import { createFileWatchMonitor, type WatchMonitor } from './resilient-watch.js';
import {
  SETTINGS_SPEC,
  type ProviderRateLimitPolicyOverride,
  type ProviderRateLimitWindowPolicyOverride,
  type ProviderRateLimits,
  type SettingKey,
  type SettingSnapshotEntry,
  type SettingSpecEntry,
  type Settings,
  type SettingType,
} from './settings-spec.js';

export {
  SETTINGS_SPEC,
  type ProviderRateLimitPolicyOverride,
  type ProviderRateLimitWindowPolicyOverride,
  type ProviderRateLimits,
  type SettingKey,
  type SettingSnapshotEntry,
  type Settings,
} from './settings-spec.js';

export type SettingsChangeCallback = (changedKeys: SettingKey[]) => void;
export interface ProviderRateLimitPolicyPatch {
  provider: string;
  enabled: boolean;
  threshold: number | null;
  windowType?: string;
  windowLabel?: string | null;
}

const log = createLogger('settings');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const SETTING_KEYS = Object.keys(SETTINGS_SPEC) as SettingKey[];
const TRUTHY_ENV_KEYS = new Set<SettingKey>(['adminChannel', 'feishuAdminChannel']);
const callbacks = new Set<SettingsChangeCallback>();
const loggedEnvFallbacks = new Set<string>();
const writeMutex = new AsyncMutex();
const FORBIDDEN_PROVIDER_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PROVIDER_KEY_LENGTH = 120;

let initialized = false;
let cachedOverrides: Record<string, unknown> = {};
let cachedSettings: Settings | null = null;
let cachedSettingsSnapshot: SettingSnapshotEntry[] | null = null;
let settingsMonitor: WatchMonitor | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let selfWriting = false;

const typeValidators: Record<SettingType, (value: unknown) => boolean> = {
  boolean: (value) => typeof value === 'boolean',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  'number|null': (value) => value === null || (typeof value === 'number' && Number.isFinite(value)),
  'string[]': (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  'string|null': (value) => value === null || typeof value === 'string',
  'provider-rate-limits': isPlainObject,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateProviderKey(provider: string): string | null {
  const trimmed = provider.trim();
  if (trimmed.length === 0) return 'provider keys must not be empty';
  if (trimmed !== provider) return 'provider keys must not have leading or trailing whitespace';
  if (trimmed.length > MAX_PROVIDER_KEY_LENGTH) {
    return `provider keys must be at most ${MAX_PROVIDER_KEY_LENGTH} characters`;
  }
  if (FORBIDDEN_PROVIDER_KEYS.has(trimmed)) return `provider key "${trimmed}" is reserved`;
  return null;
}

function validateThreshold(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'threshold must be a finite number';
  if (value <= 0) return 'threshold must be greater than 0';
  if (value > 1) return 'threshold must be at most 1';
  return null;
}

function validateWindowText(value: unknown, field: string): string | null {
  if (typeof value !== 'string') return `${field} must be a string`;
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${field} must not be empty`;
  if (trimmed !== value) return `${field} must not have leading or trailing whitespace`;
  return null;
}

function validatePolicyThreshold(value: Record<string, unknown>, path: string): string | null {
  if (!Object.hasOwn(value, 'threshold')) return null;
  if (typeof value.enabled !== 'boolean') return `${path}.enabled must be a boolean`;
  const thresholdError = validateThreshold(value.threshold);
  return thresholdError ? `${path}.${thresholdError}` : null;
}

function validateWindowPolicyOverride(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be a plain object`;
  for (const key of Object.keys(value)) {
    if (key === 'type' || key === 'label' || key === 'enabled' || key === 'threshold') continue;
    return `${path} has unknown field "${key}"`;
  }
  const typeError = validateWindowText(value.type, 'type');
  if (typeError) return `${path}.${typeError}`;
  if (Object.hasOwn(value, 'label')) {
    const labelError = validateWindowText(value.label, 'label');
    if (labelError) return `${path}.${labelError}`;
  }
  if (typeof value.enabled !== 'boolean') return `${path}.enabled must be a boolean`;
  return validatePolicyThreshold(value, path);
}

function windowIdentity(type: string, label?: string): string {
  return `${type}\u0000${label ?? ''}`;
}

function validateWindowPolicies(value: unknown, provider: string): string | null {
  if (!Array.isArray(value)) return `providerRateLimits.${provider}.windows must be an array`;
  const seen = new Set<string>();
  for (const [index, window] of value.entries()) {
    const path = `providerRateLimits.${provider}.windows.${index}`;
    const windowError = validateWindowPolicyOverride(window, path);
    if (windowError) return windowError;
    const key = windowIdentity((window as ProviderRateLimitWindowPolicyOverride).type, (window as ProviderRateLimitWindowPolicyOverride).label);
    if (seen.has(key)) return `${path} duplicates an existing window identity`;
    seen.add(key);
  }
  return null;
}

function validateProviderPolicyOverride(value: unknown, provider: string): string | null {
  if (!isPlainObject(value)) return `providerRateLimits.${provider} must be a plain object`;
  for (const key of Object.keys(value)) {
    if (key === 'enabled' || key === 'threshold' || key === 'windows') continue;
    return `providerRateLimits.${provider} has unknown field "${key}"`;
  }
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') {
    return `providerRateLimits.${provider}.enabled must be a boolean`;
  }
  const thresholdError = validatePolicyThreshold(value, `providerRateLimits.${provider}`);
  if (thresholdError) return thresholdError;
  if (Object.hasOwn(value, 'windows')) return validateWindowPolicies(value.windows, provider);
  if (typeof value.enabled === 'boolean') return null;
  return `providerRateLimits.${provider} must declare enabled or windows`;
}

function validateProviderRateLimits(value: unknown): string | null {
  if (!isPlainObject(value)) return 'must be a plain object';
  for (const [provider, policy] of Object.entries(value)) {
    const providerError = validateProviderKey(provider);
    if (providerError) return providerError;
    const policyError = validateProviderPolicyOverride(policy, provider);
    if (policyError) return policyError;
  }
  return null;
}

function normalizeWindowText(value: unknown, field: string): string {
  const error = validateWindowText(value, field);
  if (error) throw new TypeError(error);
  return (value as string).trim();
}

function normalizeWindowLabel(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return normalizeWindowText(value, 'label');
}

function normalizeProviderRateLimitPatch(patch: ProviderRateLimitPolicyPatch): ProviderRateLimitPolicyPatch {
  const provider = patch.provider.trim();
  const providerError = validateProviderKey(provider);
  if (providerError) throw new TypeError(providerError);
  if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (patch.threshold !== null) {
    const thresholdError = validateThreshold(patch.threshold);
    if (thresholdError) throw new TypeError(thresholdError);
  }
  const windowType = patch.windowType === undefined ? undefined : normalizeWindowText(patch.windowType, 'type');
  const windowLabel = normalizeWindowLabel(patch.windowLabel);
  if (windowLabel && !windowType) throw new TypeError('windowLabel requires windowType');
  return { provider, enabled: patch.enabled, threshold: patch.threshold, ...(windowType ? { windowType } : {}), ...(windowLabel ? { windowLabel } : {}) };
}

function cloneWindowPolicy(window: ProviderRateLimitWindowPolicyOverride): ProviderRateLimitWindowPolicyOverride {
  return {
    type: window.type,
    ...(window.label ? { label: window.label } : {}),
    enabled: window.enabled,
    ...(Object.hasOwn(window, 'threshold') ? { threshold: window.threshold } : {}),
  };
}

function cloneProviderPolicy(policy: ProviderRateLimitPolicyOverride): ProviderRateLimitPolicyOverride {
  return {
    ...(typeof policy.enabled === 'boolean' ? { enabled: policy.enabled } : {}),
    ...(Object.hasOwn(policy, 'threshold') ? { threshold: policy.threshold } : {}),
    ...(policy.windows ? { windows: policy.windows.map(cloneWindowPolicy) } : {}),
  };
}

function cloneProviderRateLimits(value: unknown): ProviderRateLimits {
  const validationError = validateProviderRateLimits(value);
  if (validationError) throw new TypeError(validationError);
  return Object.fromEntries(
    Object.entries(value as Record<string, ProviderRateLimitPolicyOverride>)
      .map(([provider, policy]) => [provider, cloneProviderPolicy(policy)]),
  );
}

function providerRateLimitOverrides(overrides: Record<string, unknown>): ProviderRateLimits {
  if (!Object.hasOwn(overrides, 'providerRateLimits')) return {};
  return cloneProviderRateLimits(overrides.providerRateLimits);
}

export function validateSettingsOverrides(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('settings.json must contain a JSON object');
  }
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = SETTINGS_SPEC[key] as SettingSpecEntry<Settings[SettingKey]>;
    if (!typeValidators[entry.type](value[key])) {
      throw new TypeError(`settings.json key "${key}" must have type ${entry.type}`);
    }
    if (entry.type === 'provider-rate-limits') {
      const providerError = validateProviderRateLimits(value[key]);
      if (providerError) throw new TypeError(`settings.json key "${key}" ${providerError}`);
      continue;
    }
    const validationError = entry.validate?.(value[key] as never);
    if (validationError) throw new TypeError(`settings.json key "${key}" ${validationError}`);
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

export function assertSettingsFileValid(): void {
  readOverrides();
}

function logEnvFallback(key: SettingKey, envVar: string): void {
  if (loggedEnvFallbacks.has(envVar)) return;
  loggedEnvFallbacks.add(envVar);
  log.warn(`Deprecated env ${envVar} supplies settings.${key}; move it to settings.json`);
}

function resolvedOverrideValue<K extends SettingKey>(
  key: K,
  overrides: Record<string, unknown>,
): Settings[K] {
  if (key !== 'providerRateLimits') return overrides[key] as Settings[K];
  return cloneProviderRateLimits(overrides[key]) as Settings[K];
}

function resolveSettingEntry<K extends SettingKey>(
  key: K,
  overrides: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  warnOnEnv: boolean,
): SettingSnapshotEntry<K> {
  const entry = SETTINGS_SPEC[key] as SettingSpecEntry<Settings[K]>;
  if (Object.hasOwn(overrides, key)) {
    return { key, value: resolvedOverrideValue(key, overrides), source: 'file' };
  }
  const envVars = entry.envVar === undefined
    ? []
    : typeof entry.envVar === 'string' ? [entry.envVar] : entry.envVar;
  for (const envVar of envVars) {
    const raw = env[envVar];
    if (raw === undefined || (TRUTHY_ENV_KEYS.has(key) && raw.length === 0)) continue;
    if (warnOnEnv) logEnvFallback(key, envVar);
    return { key, value: entry.legacyParse!(raw), source: 'env' };
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

function sameDataValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameDataValue(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && sameDataValue(left[key], right[key]));
  }
  return Object.is(left, right);
}

function sameValue(left: Settings[SettingKey], right: Settings[SettingKey]): boolean {
  return sameDataValue(left, right);
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
  return sameDataValue(left, right);
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

function startWatcher(): void {
  settingsMonitor = createFileWatchMonitor({
    label: 'settings.json',
    filePath: SETTINGS_FILE,
    onChange: scheduleReload,
    warn: (message) => log.error(message),
    unref: true,
  });
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

export function resetSettingsForTests(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = null;
  settingsMonitor?.close();
  settingsMonitor = null;
  initialized = false;
  cachedOverrides = {};
  cachedSettings = null;
  cachedSettingsSnapshot = null;
  selfWriting = false;
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

function matchesWindow(
  window: ProviderRateLimitWindowPolicyOverride,
  patch: ProviderRateLimitPolicyPatch,
): boolean {
  return window.type === patch.windowType && window.label === patch.windowLabel;
}

function nextWindowPolicy(patch: ProviderRateLimitPolicyPatch): ProviderRateLimitWindowPolicyOverride {
  return {
    type: patch.windowType!,
    ...(patch.windowLabel ? { label: patch.windowLabel } : {}),
    enabled: patch.enabled,
    ...(patch.threshold !== null ? { threshold: patch.threshold } : {}),
  };
}

function cleanProviderPolicy(policy: ProviderRateLimitPolicyOverride): ProviderRateLimitPolicyOverride | null {
  const cleaned = cloneProviderPolicy(policy);
  if (!cleaned.windows?.length) delete cleaned.windows;
  if (cleaned.enabled === undefined && cleaned.threshold === undefined && !cleaned.windows) return null;
  return cleaned;
}

function hasLegacyProviderOverride(policy: ProviderRateLimitPolicyOverride): boolean {
  return policy.enabled === false || policy.threshold !== undefined;
}

function applyProviderRateLimitPatch(
  current: ProviderRateLimitPolicyOverride | undefined,
  patch: ProviderRateLimitPolicyPatch,
): ProviderRateLimitPolicyOverride | null {
  const next = cloneProviderPolicy(current ?? {});
  if (!patch.windowType) {
    delete next.enabled;
    delete next.threshold;
    if (!patch.enabled || patch.threshold !== null) next.enabled = patch.enabled;
    if (patch.threshold !== null) next.threshold = patch.threshold;
    return cleanProviderPolicy(next);
  }
  const windows = next.windows?.filter((window) => !matchesWindow(window, patch)) ?? [];
  const mustMaskLegacy = patch.enabled && patch.threshold === null && hasLegacyProviderOverride(next);
  if (!patch.enabled || patch.threshold !== null || mustMaskLegacy) windows.push(nextWindowPolicy(patch));
  next.windows = windows;
  return cleanProviderPolicy(next);
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

export async function setProviderRateLimitPolicy(
  patch: ProviderRateLimitPolicyPatch,
): Promise<ProviderRateLimitPolicyPatch> {
  initialize();
  const env = { ...process.env };
  const normalized = normalizeProviderRateLimitPatch(patch);
  return writeMutex.run(async () => {
    const nextOverrides = { ...readOverridesForUpdate() };
    const providerRateLimits = providerRateLimitOverrides(nextOverrides);
    const nextPolicy = applyProviderRateLimitPatch(providerRateLimits[normalized.provider], normalized);
    if (nextPolicy) providerRateLimits[normalized.provider] = nextPolicy;
    else delete providerRateLimits[normalized.provider];
    nextOverrides.providerRateLimits = providerRateLimits;
    const nextSnapshot = resolveSettingsSnapshot(nextOverrides, env);
    const nextSettings = settingsFromSnapshot(nextSnapshot);
    selfWriting = true;
    try {
      await atomicWrite(SETTINGS_FILE, `${JSON.stringify(nextOverrides, null, 2)}\n`);
      acceptSnapshot(nextOverrides, nextSettings, nextSnapshot);
    } finally {
      selfWriting = false;
    }
    return normalized;
  });
}
