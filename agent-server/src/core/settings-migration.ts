// input:  CONFIG_DIR/.env, SETTINGS_SPEC, updateSettings
// output: migrateEnvToSettings startup migration
// pos:    Moves legacy behavior settings out of .env
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { atomicWrite } from './atomic-write.js';
import { createLogger } from './log.js';
import { CONFIG_DIR } from './paths.js';
import {
  SETTINGS_SPEC,
  updateSettings,
  validateSettingsOverrides,
  type SettingKey,
  type Settings,
} from './settings.js';
import type { SettingSpecEntry } from './settings-spec.js';

const ENV_FILE = path.join(CONFIG_DIR, '.env');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const DEAD_ENV_KEY = 'CORTEX_SERVER_UPDATE_ENABLE';
const MIGRATION_COMMENT = '# Legacy server settings migrated to settings.json; secrets remain in .env.';
const ENV_ASSIGNMENT_PATTERN = /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=[ \t]*?|:[ \t]+?)(?:[ \t]*'(?:\\'|[^'])*'|[ \t]*"(?:\\"|[^"])*"|[ \t]*`(?:\\`|[^`])*`|[^#\r\n]+)?[ \t]*(?:#[^\r\n]*)?(?:\r\n|\n|\r|$)/gm;
const SETTING_KEYS = Object.keys(SETTINGS_SPEC) as SettingKey[];
const SPEC_ENV_KEYS = new Set(SETTING_KEYS.flatMap((key) => {
  const envVar = (SETTINGS_SPEC[key] as SettingSpecEntry<Settings[SettingKey]>).envVar;
  if (envVar === undefined) return [];
  return typeof envVar === 'string' ? [envVar] : [...envVar];
}));
const REMOVED_ENV_KEYS = new Set([...SPEC_ENV_KEYS, DEAD_ENV_KEY]);
const log = createLogger('settings-migration');

interface EnvAssignment {
  key: string;
  start: number;
  end: number;
}

interface MigratedValue {
  found: boolean;
  value?: Settings[SettingKey];
}

interface MigrationPlan {
  migrated: string;
  partial: Partial<Settings>;
  mode: number;
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
  validateSettingsOverrides(value);
  return value;
}

function envAssignments(source: string): EnvAssignment[] {
  const pattern = new RegExp(ENV_ASSIGNMENT_PATTERN.source, ENV_ASSIGNMENT_PATTERN.flags);
  const assignments: EnvAssignment[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    assignments.push({ key: match[1], start: match.index, end: pattern.lastIndex });
  }
  return assignments;
}

function legacyValue(
  key: SettingKey,
  parsedEnv: Record<string, string>,
  presentKeys: Set<string>,
): MigratedValue {
  const entry = SETTINGS_SPEC[key] as SettingSpecEntry<Settings[SettingKey]>;
  if (entry.envVar === undefined || entry.legacyParse === undefined) return { found: false };
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
  assignments: EnvAssignment[],
): Partial<Settings> {
  const parsedEnv = parseDotenv(source) as Record<string, string>;
  const presentKeys = new Set(assignments.map((assignment) => assignment.key));
  const partial: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (Object.hasOwn(existing, key)) continue;
    const migrated = legacyValue(key, parsedEnv, presentKeys);
    if (migrated.found) partial[key] = migrated.value;
  }
  return partial as Partial<Settings>;
}

function removeAssignments(source: string, assignments: EnvAssignment[]): string {
  let retained = '';
  let cursor = 0;
  for (const assignment of assignments) {
    if (!REMOVED_ENV_KEYS.has(assignment.key)) continue;
    retained += source.slice(cursor, assignment.start);
    cursor = assignment.end;
  }
  return retained + source.slice(cursor);
}

function migratedEnv(source: string, assignments: EnvAssignment[]): string {
  const newline = source.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  return `${MIGRATION_COMMENT}${newline}${removeAssignments(source, assignments)}`;
}

function backupPath(): string {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ENV_FILE}.bak-${suffix}`;
}

async function prepareMigration(): Promise<MigrationPlan | null> {
  const source = await readOptional(ENV_FILE);
  if (source === null) return null;
  const assignments = envAssignments(source);
  if (!assignments.some((assignment) => SPEC_ENV_KEYS.has(assignment.key))) return null;
  const existing = await readExistingSettings();
  const partial = collectSettings(source, existing, assignments);
  validateSettingsOverrides({ ...existing, ...partial });
  const mode = (await fs.stat(ENV_FILE)).mode & 0o777;
  return { migrated: migratedEnv(source, assignments), partial, mode };
}

async function applyMigration(plan: MigrationPlan): Promise<void> {
  await fs.copyFile(ENV_FILE, backupPath());
  if (Object.keys(plan.partial).length > 0) await updateSettings(plan.partial);
  await atomicWrite(ENV_FILE, plan.migrated, { mode: plan.mode });
}

/**
 * This intentionally stays outside store/version-migrations: that framework migrates one
 * managed file at a time, while this operation must coordinate settings.json, .env, and its backup.
 */
export async function migrateEnvToSettings(): Promise<void> {
  try {
    const plan = await prepareMigration();
    if (plan) await applyMigration(plan);
  } catch (error) {
    log.error(
      `Legacy settings migration failed; leaving .env active. Fix ${SETTINGS_FILE} or its legacy values, then restart: ${(error as Error).message}`,
    );
  }
}
