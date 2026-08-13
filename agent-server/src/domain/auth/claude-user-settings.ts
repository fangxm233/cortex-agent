// input:  cleanup-period days, Claude config resolution, and injectable fs/env helpers
// output: hermetic Claude user settings sync via guarded read-merge-temp-sync-rename
// pos:    Claude user settings helper for retention coordination follow-up wiring
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SETTINGS_FILE = 'settings.json';
const REAL_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RENAME_RETRIES = 2;

interface FsLike {
  mkdir: typeof fs.mkdir;
  readFile: typeof fs.readFile;
  writeFile: typeof fs.writeFile;
  stat: typeof fs.stat;
  lstat: typeof fs.lstat;
  chmod: typeof fs.chmod;
  rename: typeof fs.rename;
  rm: typeof fs.rm;
  realpath: typeof fs.realpath;
  open: typeof fs.open;
}

interface FileSnapshot {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
}

interface ReadSettingsResult {
  filePath: string;
  targetPath: string;
  mode: number | undefined;
  snapshot: FileSnapshot | null;
  settings: Record<string, unknown> | null;
}

export interface SyncClaudeUserCleanupPeriodDaysOptions {
  claudeConfigDir?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  fs?: FsLike;
}

export interface ClaudeUserSettingsSyncResult {
  filePath: string;
  changed: boolean;
}

class ExternalSettingsChangeError extends Error {
  constructor(filePath: string) {
    super(`Claude settings changed during sync: ${filePath}`);
  }
}

function expandHome(input: string, homeDir: string): string {
  return input === '~' || input.startsWith(`~${path.sep}`)
    ? path.join(homeDir, input.slice(2))
    : input;
}

function resolveConfigDir(options: SyncClaudeUserCleanupPeriodDaysOptions): string {
  const homeDir = (options.homedir ?? os.homedir)();
  const configured = options.claudeConfigDir ?? options.env?.CLAUDE_CONFIG_DIR ?? '~/.claude';
  return path.resolve(expandHome(configured, homeDir));
}

function isWithinPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertSafeTestPath(configDir: string, deps: FsLike): Promise<void> {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const candidates = [path.resolve(configDir)];
  try { candidates.push(await deps.realpath(configDir)); } catch { /* best-effort */ }
  if (candidates.some(candidate => isWithinPath(REAL_CLAUDE_DIR, candidate))) {
    throw new Error(`syncClaudeUserCleanupPeriodDays blocked write to real ~/.claude (${configDir})`);
  }
}

function parseSettings(raw: Buffer, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`Claude settings.json is malformed: ${filePath}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Claude settings.json must contain a JSON object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function sameCleanupPeriod(settings: Record<string, unknown>, days: number): boolean {
  return settings.cleanupPeriodDays === days;
}

function toSnapshot(stats: Awaited<ReturnType<FsLike['stat']>>): FileSnapshot {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  };
}

function sameSnapshot(left: FileSnapshot | null, right: FileSnapshot | null): boolean {
  return !!left
    && !!right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function serializeSettings(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function tempPathFor(targetPath: string): string {
  return `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function statOrNull(filePath: string, deps: FsLike): Promise<Awaited<ReturnType<FsLike['stat']>> | null> {
  try {
    return await deps.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function lstatOrNull(filePath: string, deps: FsLike): Promise<Awaited<ReturnType<FsLike['lstat']>> | null> {
  try {
    return await deps.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function removeIfExists(filePath: string, deps: FsLike): Promise<void> {
  try {
    await deps.rm(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function syncPath(filePath: string, deps: FsLike): Promise<void> {
  const handle = await deps.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentDir(filePath: string, deps: FsLike): Promise<void> {
  const handle = await deps.open(path.dirname(filePath), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureConfigDir(configDir: string, deps: FsLike): Promise<void> {
  const existing = await statOrNull(configDir, deps);
  if (existing) return;
  await deps.mkdir(configDir, { recursive: true, mode: DIR_MODE });
  await deps.chmod(configDir, DIR_MODE);
}

async function resolveTargetPath(filePath: string, deps: FsLike): Promise<string> {
  const entry = await lstatOrNull(filePath, deps);
  if (!entry?.isSymbolicLink()) return filePath;
  return deps.realpath(filePath);
}

async function readSettings(filePath: string, deps: FsLike): Promise<ReadSettingsResult> {
  const targetPath = await resolveTargetPath(filePath, deps);
  const stats = await statOrNull(targetPath, deps);
  if (!stats) {
    return { filePath, targetPath, mode: undefined, snapshot: null, settings: null };
  }
  const raw = await deps.readFile(targetPath) as Buffer;
  return {
    filePath,
    targetPath,
    mode: Number(stats.mode) & 0o777,
    snapshot: toSnapshot(stats),
    settings: parseSettings(raw, filePath),
  };
}

async function assertUnchanged(result: ReadSettingsResult, deps: FsLike): Promise<void> {
  const latest = await statOrNull(result.targetPath, deps);
  if (result.snapshot === null) {
    if (latest === null) return;
    throw new ExternalSettingsChangeError(result.filePath);
  }
  if (!sameSnapshot(result.snapshot, latest ? toSnapshot(latest) : null)) {
    throw new ExternalSettingsChangeError(result.filePath);
  }
}

async function writeTempFile(
  tempPath: string,
  mode: number,
  content: string,
  deps: FsLike,
): Promise<void> {
  await deps.writeFile(tempPath, content, { mode, flag: 'wx' });
  await syncPath(tempPath, deps);
}

async function replaceSettingsFile(
  result: ReadSettingsResult,
  next: Record<string, unknown>,
  deps: FsLike,
): Promise<void> {
  const tempPath = tempPathFor(result.targetPath);
  try {
    await writeTempFile(tempPath, result.mode ?? FILE_MODE, serializeSettings(next), deps);
    await assertUnchanged(result, deps);
    await deps.rename(tempPath, result.targetPath);
    await syncParentDir(result.targetPath, deps);
  } catch (error) {
    await removeIfExists(tempPath, deps);
    throw error;
  }
}

async function syncWithRetry(
  cleanupPeriodDays: number,
  filePath: string,
  deps: FsLike,
): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RENAME_RETRIES; attempt += 1) {
    const current = await readSettings(filePath, deps);
    if (current.settings && sameCleanupPeriod(current.settings, cleanupPeriodDays)) return false;
    try {
      await replaceSettingsFile(current, { ...(current.settings ?? {}), cleanupPeriodDays }, deps);
      return true;
    } catch (error) {
      if (error instanceof ExternalSettingsChangeError && attempt < MAX_RENAME_RETRIES) continue;
      throw error;
    }
  }
  throw new ExternalSettingsChangeError(filePath);
}

export async function syncClaudeUserCleanupPeriodDays(
  cleanupPeriodDays: number,
  options: SyncClaudeUserCleanupPeriodDaysOptions = {},
): Promise<ClaudeUserSettingsSyncResult> {
  const deps = options.fs ?? fs;
  const configDir = resolveConfigDir(options);
  const filePath = path.join(configDir, SETTINGS_FILE);
  await assertSafeTestPath(configDir, deps);
  await ensureConfigDir(configDir, deps);
  return {
    filePath,
    changed: await syncWithRetry(cleanupPeriodDays, filePath, deps),
  };
}
