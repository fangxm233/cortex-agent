import fs from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_CONFIG_HOME, USER_CLAUDE_CONFIG_DIR } from '@core/paths.js';

const SETTINGS_FILE = 'settings.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** What a fresh Cortex config dir takes over from the terminal's settings, once. */
const SEEDED_KEYS = ['model', 'effortLevel', 'modelSettings', 'autoCompactWindow', 'autoMemoryEnabled', 'env'] as const;

export interface ClaudeUserSettingsOptions {
  /** The settings' own config dir; defaults to Cortex's (CLAUDE_CONFIG_HOME). */
  configDir?: string;
  /** Where the first seed reads from; defaults to the terminal's `~/.claude`. */
  seedFromDir?: string;
}

export interface ClaudeUserSettingsSyncResult {
  filePath: string;
  changed: boolean;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readSettings(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude settings.json is malformed: ${filePath}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Claude settings.json must contain a JSON object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

/** The seed is a convenience: an unreadable terminal file seeds nothing rather than failing. */
async function readSeedSource(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await readSettings(filePath) ?? {};
  } catch {
    return {};
  }
}

function seededKeys(source: Record<string, unknown>): Record<string, unknown> {
  const seeded: Record<string, unknown> = {};
  for (const key of SEEDED_KEYS) {
    if (key in source) seeded[key] = source[key];
  }
  return seeded;
}

function serialize(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Create the config dir's settings.json from the keys the terminal's settings define. Runs only
 * while that file does not exist — the dir itself may already hold a login — so a later change to
 * `~/.claude` never reaches Cortex. Resolves whether it wrote the file.
 */
export async function seedClaudeUserSettings(options: ClaudeUserSettingsOptions = {}): Promise<boolean> {
  const configDir = options.configDir ?? CLAUDE_CONFIG_HOME;
  const filePath = path.join(configDir, SETTINGS_FILE);
  if (await fileExists(filePath)) return false;
  const source = await readSeedSource(path.join(options.seedFromDir ?? USER_CLAUDE_CONFIG_DIR, SETTINGS_FILE));
  await fs.mkdir(configDir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.writeFile(filePath, serialize(seededKeys(source)), { mode: FILE_MODE, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

/**
 * Keep Claude's own transcript cleanup in step with Cortex's session retention: merge
 * `cleanupPeriodDays` into Cortex's Claude settings, leaving every other key as it is. The file
 * belongs to Cortex, so a plain read-merge-rename is enough.
 */
export async function syncClaudeUserCleanupPeriodDays(
  cleanupPeriodDays: number,
  options: ClaudeUserSettingsOptions = {},
): Promise<ClaudeUserSettingsSyncResult> {
  await seedClaudeUserSettings(options);
  const filePath = path.join(options.configDir ?? CLAUDE_CONFIG_HOME, SETTINGS_FILE);
  const current = await readSettings(filePath) ?? {};
  if (current.cleanupPeriodDays === cleanupPeriodDays) return { filePath, changed: false };
  const tempPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tempPath, serialize({ ...current, cleanupPeriodDays }), { mode: FILE_MODE });
  await fs.rename(tempPath, filePath);
  return { filePath, changed: true };
}
