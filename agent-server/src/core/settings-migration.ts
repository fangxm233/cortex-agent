// input:  CONFIG_DIR/.env, SETTINGS_SPEC, updateSettings
// output: migrateEnvToSettings startup migration
// pos:    Moves legacy behavior settings out of .env
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { atomicWrite } from './atomic-write.js';
import { CONFIG_DIR } from './paths.js';
import {
  SETTINGS_SPEC,
  updateSettings,
  type SettingKey,
  type Settings,
} from './settings.js';

const ENV_FILE = path.join(CONFIG_DIR, '.env');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const DEAD_ENV_KEY = 'CORTEX_SERVER_UPDATE_ENABLE';
const MIGRATION_COMMENT = '# Legacy server settings migrated to settings.json; secrets remain in .env.';
const ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const SETTING_KEYS = Object.keys(SETTINGS_SPEC) as SettingKey[];
const SPEC_ENV_KEYS = new Set(SETTING_KEYS.flatMap((key) => {
  const envVar = SETTINGS_SPEC[key].envVar;
  return typeof envVar === 'string' ? [envVar] : [...envVar];
}));
const REMOVED_ENV_KEYS = new Set([...SPEC_ENV_KEYS, DEAD_ENV_KEY]);

interface MigratedValue {
  found: boolean;
  value?: Settings[SettingKey];
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readExistingSettings(): Promise<Record<string, unknown>> {
  const raw = await readOptional(SETTINGS_FILE);
  if (raw === null) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('settings.json must contain a JSON object');
  }
  return value as Record<string, unknown>;
}

function assignmentKey(line: string): string | null {
  return ASSIGNMENT_PATTERN.exec(line)?.[1] ?? null;
}

function splitLines(source: string): string[] {
  return source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

function presentAssignmentKeys(source: string): Set<string> {
  const keys = splitLines(source).map(assignmentKey).filter((key): key is string => key !== null);
  return new Set(keys);
}

function legacyValue(
  key: SettingKey,
  parsedEnv: Record<string, string>,
  presentKeys: Set<string>,
): MigratedValue {
  const entry = SETTINGS_SPEC[key];
  const envVars = typeof entry.envVar === 'string' ? [entry.envVar] : [...entry.envVar];
  let fallback: Settings[SettingKey] | undefined;
  for (const envVar of envVars) {
    if (!presentKeys.has(envVar)) continue;
    fallback = entry.legacyParse(parsedEnv[envVar] ?? '');
    if (fallback !== null || envVars.length === 1) return { found: true, value: fallback };
  }
  return fallback === undefined ? { found: false } : { found: true, value: fallback };
}

function collectSettings(
  source: string,
  existing: Record<string, unknown>,
  presentKeys: Set<string>,
): Partial<Settings> {
  const parsedEnv = parseDotenv(source) as Record<string, string>;
  const partial: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (Object.hasOwn(existing, key)) continue;
    const migrated = legacyValue(key, parsedEnv, presentKeys);
    if (migrated.found) partial[key] = migrated.value;
  }
  return partial as Partial<Settings>;
}

function migratedEnv(source: string): string {
  const newline = source.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  const retained = splitLines(source)
    .filter((line) => !REMOVED_ENV_KEYS.has(assignmentKey(line) ?? ''))
    .join('');
  return `${MIGRATION_COMMENT}${newline}${retained}`;
}

function backupPath(): string {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ENV_FILE}.bak-${suffix}`;
}

/**
 * This intentionally stays outside store/version-migrations: that framework migrates one
 * managed file at a time, while this operation must coordinate settings.json, .env, and its backup.
 */
export async function migrateEnvToSettings(): Promise<void> {
  const source = await readOptional(ENV_FILE);
  if (source === null) return;
  const presentKeys = presentAssignmentKeys(source);
  if (![...presentKeys].some((key) => SPEC_ENV_KEYS.has(key))) return;
  const existing = await readExistingSettings();
  const partial = collectSettings(source, existing, presentKeys);
  await fs.copyFile(ENV_FILE, backupPath());
  if (Object.keys(partial).length > 0) await updateSettings(partial);
  await atomicWrite(ENV_FILE, migratedEnv(source));
}
