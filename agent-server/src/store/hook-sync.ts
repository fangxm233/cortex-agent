// input:  shipped hook scripts/entries, data paths, atomicWrite
// output: managed hook sync and fail-soft diagnostics
// pos:    Startup CalVer synchronization for shipped hook assets
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@core/atomic-write.js';
import { CONFIG_DIR, DEFAULTS_DIR, HOOKS_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { validateHookEntry } from './hook-registry.js';
import { compareCalVer } from './version-migrations.js';

const log = createLogger('hook-sync');
const VERSION_MARKER_RE = /@cortex-hook-version\s+(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)/;
const CALVER_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/;

export interface HookSyncDirs {
  srcDir?: string;
  dstDir?: string;
}

export interface HookSyncOptions extends HookSyncDirs {
  entrySrcDir?: string;
  entryDstDir?: string;
}

/** Parse the @cortex-hook-version stamp from hook source, or null if absent/malformed. */
export function parseHookVersion(src: string): string | null {
  const match = src.match(VERSION_MARKER_RE);
  return match ? match[1] : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listFiles(directory: string, suffix: string): Promise<string[] | null> {
  try {
    const files = await fs.readdir(directory);
    return files.filter((file) => file.endsWith(suffix)).sort();
  } catch (error) {
    log.error(`failed to read hook asset directory ${directory}: ${errorMessage(error)}`);
    return null;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    log.error(`failed to read hook asset ${filePath}: ${errorMessage(error)}`);
    return null;
  }
}

async function writeManaged(filePath: string, content: string, label: string): Promise<boolean> {
  try {
    await atomicWrite(filePath, content);
    log.info(`synced ${label}`);
    return true;
  } catch (error) {
    log.error(`failed to sync ${label}: ${(error as Error).message}`);
    return false;
  }
}

async function shouldSyncScript(dstPath: string, srcVersion: string): Promise<boolean> {
  if (!existsSync(dstPath)) return true;
  const dstContent = await readText(dstPath);
  const dstVersion = dstContent === null ? null : parseHookVersion(dstContent);
  return !dstVersion || compareCalVer(dstVersion, srcVersion) < 0;
}

async function syncScriptFile(srcDir: string, dstDir: string, file: string): Promise<boolean> {
  const srcContent = await readText(path.join(srcDir, file));
  if (srcContent === null) return false;
  const srcVersion = parseHookVersion(srcContent);
  if (!srcVersion) return false;
  const dstPath = path.join(dstDir, file);
  if (!await shouldSyncScript(dstPath, srcVersion)) return false;
  return writeManaged(dstPath, srcContent, `hook ${file} → ${srcVersion}`);
}

export async function syncManagedHookScripts(opts: HookSyncDirs = {}): Promise<string[]> {
  const srcDir = opts.srcDir ?? path.join(DEFAULTS_DIR, 'hooks');
  const dstDir = opts.dstDir ?? HOOKS_DIR;
  const files = await listFiles(srcDir, '.mjs');
  if (!files || files.length === 0) return [];
  await fs.mkdir(dstDir, { recursive: true });
  const updated: string[] = [];
  for (const file of files) {
    if (await syncScriptFile(srcDir, dstDir, file)) updated.push(file);
  }
  if (updated.length === 0) log.info('managed hooks up to date');
  return updated;
}

function parseCalVer(version: string): [number, number, number, number] | null {
  const match = version.match(CALVER_RE);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

function compareHookCalVer(a: string, b: string): number {
  const left = parseCalVer(a);
  const right = parseCalVer(b);
  if (!left || !right) throw new Error('invalid hook CalVer');
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function managedSourceVersion(content: string): string | null {
  const entry = validateHookEntry(JSON.parse(content));
  return typeof entry.version === 'string' && parseCalVer(entry.version) ? entry.version : null;
}

function deployedVersion(content: string): string | null {
  const value = JSON.parse(content);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).version;
  return typeof version === 'string' && parseCalVer(version) ? version : null;
}

type EntrySyncOutcome = 'updated' | 'unchanged' | 'failed';

async function shouldSyncEntry(dstPath: string, srcVersion: string): Promise<boolean | null> {
  if (!existsSync(dstPath)) return true;
  const dstContent = await readText(dstPath);
  if (dstContent === null) return null;
  try {
    const dstVersion = deployedVersion(dstContent);
    return dstVersion !== null && compareHookCalVer(dstVersion, srcVersion) < 0;
  } catch {
    return null;
  }
}

async function syncEntryFile(srcDir: string, dstDir: string, file: string): Promise<EntrySyncOutcome> {
  const srcPath = path.join(srcDir, file);
  const srcContent = await readText(srcPath);
  if (srcContent === null) return 'failed';
  let srcVersion: string | null;
  try {
    srcVersion = managedSourceVersion(srcContent);
  } catch (error) {
    log.error(`invalid managed hook entry ${srcPath}: ${errorMessage(error)}`);
    return 'failed';
  }
  if (!srcVersion) return 'unchanged';
  const dstPath = path.join(dstDir, file);
  const shouldSync = await shouldSyncEntry(dstPath, srcVersion);
  if (shouldSync === null) return 'failed';
  if (!shouldSync) return 'unchanged';
  return await writeManaged(dstPath, srcContent, `hook entry ${file} → ${srcVersion}`)
    ? 'updated'
    : 'failed';
}

export async function syncManagedHookEntries(opts: HookSyncDirs = {}): Promise<string[]> {
  const srcDir = opts.srcDir ?? path.join(DEFAULTS_DIR, 'config', 'hooks');
  const dstDir = opts.dstDir ?? path.join(CONFIG_DIR, 'hooks');
  const files = await listFiles(srcDir, '.json');
  if (!files || files.length === 0) return [];
  await fs.mkdir(dstDir, { recursive: true });
  const updated: string[] = [];
  let failed = false;
  for (const file of files) {
    const outcome = await syncEntryFile(srcDir, dstDir, file);
    if (outcome === 'updated') updated.push(file);
    if (outcome === 'failed') failed = true;
  }
  if (updated.length === 0 && !failed) log.info('managed hook entries up to date');
  return updated;
}

function includesEntrySync(opts: HookSyncOptions): boolean {
  const hasEntryOverride = opts.entrySrcDir !== undefined || opts.entryDstDir !== undefined;
  const hasScriptOverride = opts.srcDir !== undefined || opts.dstDir !== undefined;
  return hasEntryOverride || !hasScriptOverride;
}

/** Sync all managed hook assets at startup; script-only directory overrides remain supported. */
export async function syncManagedHooks(opts: HookSyncOptions = {}): Promise<string[]> {
  const scripts = await syncManagedHookScripts(opts);
  if (!includesEntrySync(opts)) return scripts;
  const entries = await syncManagedHookEntries({
    srcDir: opts.entrySrcDir,
    dstDir: opts.entryDstDir,
  });
  return [...scripts, ...entries.map((file) => `config/hooks/${file}`)];
}
