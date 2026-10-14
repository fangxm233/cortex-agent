// One-time move of an install to built-in assets read in place.
//
// Cortex used to copy its plugins, hooks, rules, agent roles and system prompts into the home: the
// plugins and hooks were rewritten on every version bump, the rest copied once. Now they are read
// from the install and the home holds only the user's own files. This step leaves an existing home
// loading exactly what it loaded before, with only the user's content left in it:
//
// - Plugins and hooks were rewritten at each bump, so a deployed file with a shipped counterpart was
//   never the user's: it goes (into the archive when it differs from the shipped file). Files with no
//   shipped counterpart stay, and leftovers that no longer form a skill are archived. A hook
//   registration keeps only a switched `enabled`, as a partial override.
// - Rules, agent roles and system prompts were copied once and then the user's: a copy identical to
//   the shipped file goes, a changed one stays as the user's override.
// - Environments listed the plugins they loaded. Built-ins now load by default, so their entries go
//   and every built-in an environment did not list is recorded in its `disabledPlugins`.
//
// Removed content that is not a byte copy of a shipped file is moved to
// config/archive/builtin-overlay-<stamp>/, never deleted. Every part is idempotent.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';

const log = createLogger('builtin-overlay-migration');

/** Skill directories Cortex shipped inside a built-in plugin and has since retired. They no longer
 *  ship, so without this they would stay behind as the user's own skills. */
const RETIRED_SKILL_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['cortex-system', 'skills/commission'],
  ['cortex-system', 'skills/task'],
  ['cortex-system', 'skills/thread'],
];

/** Plugin files Cortex shipped and no longer does; the user layer of a built-in has no manifest. */
const RETIRED_PLUGIN_FILES = ['plugin.json', path.join('.claude-plugin', 'plugin.json')];

const HOOK_VERSION_LINE = /^[ \t]*\/\/[ \t]*@cortex-hook-version\b[^\n]*\n?/gm;

export interface BuiltinOverlayMigrationOptions {
  dataDir: string;
  defaultsDir: string;
  now?: Date;
}

export interface BuiltinOverlayReport {
  removed: string[];
  archived: string[];
  environments: string[];
}

interface Ctx extends BuiltinOverlayMigrationOptions {
  archiveDir: string;
  report: BuiltinOverlayReport;
}

// ── Filesystem helpers ─────────────────────────────────────────

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isFile();
  } catch {
    return false;
  }
}

async function readText(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function childNames(dir: string, kind: 'file' | 'dir'): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => (kind === 'dir' ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** Every regular file under `dir`, as paths relative to it. Symlinks are files here: never followed. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(dir, rel));
    else out.push(rel);
  }
  return out;
}

/** Remove `dir` and every directory under it left empty, bottom-up. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  for (const name of await childNames(dir, 'dir')) await pruneEmptyDirs(path.join(dir, name));
  try {
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
  } catch {
    // Gone already, or not empty: nothing to prune.
  }
}

function homeRelative(ctx: Ctx, target: string): string {
  return path.relative(ctx.dataDir, target);
}

async function archive(ctx: Ctx, target: string): Promise<void> {
  const rel = homeRelative(ctx, target);
  const destination = path.join(ctx.archiveDir, rel);
  if (await exists(destination)) throw new Error(`archive target already exists: ${destination}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(target, destination);
  ctx.report.archived.push(rel);
}

async function remove(ctx: Ctx, target: string): Promise<void> {
  await fs.rm(target, { force: true });
  ctx.report.removed.push(homeRelative(ctx, target));
}

/** A deployed copy of a shipped file: removed when identical (after `normalize`), archived otherwise. */
async function retireDeployedCopy(
  ctx: Ctx,
  deployed: string,
  shipped: string,
  normalize: (text: string) => string = (text) => text,
): Promise<void> {
  const [own, theirs] = await Promise.all([readText(deployed), readText(shipped)]);
  if (own !== null && theirs !== null && normalize(own) === normalize(theirs)) await remove(ctx, deployed);
  else await archive(ctx, deployed);
}

// ── Plugins ────────────────────────────────────────────────────

async function retirePluginFile(ctx: Ctx, id: string, rel: string): Promise<void> {
  const deployed = path.join(ctx.dataDir, 'plugins', id, rel);
  const shipped = path.join(ctx.defaultsDir, 'plugins', id, rel);
  if (await isFile(shipped)) return retireDeployedCopy(ctx, deployed, shipped);
  if (RETIRED_PLUGIN_FILES.includes(rel)) await archive(ctx, deployed);
}

/** A skill directory without a SKILL.md is not a skill; what is left in it goes to the archive. */
async function archiveSkillLeftovers(ctx: Ctx, userRoot: string): Promise<void> {
  const skillsDir = path.join(userRoot, 'skills');
  for (const name of await childNames(skillsDir, 'dir')) {
    const dir = path.join(skillsDir, name);
    if (await isFile(path.join(dir, 'SKILL.md'))) continue;
    if ((await filesUnder(dir)).length > 0) await archive(ctx, dir);
  }
}

async function migratePlugin(ctx: Ctx, id: string): Promise<void> {
  const userRoot = path.join(ctx.dataDir, 'plugins', id);
  if (!await exists(userRoot)) return;
  for (const [plugin, rel] of RETIRED_SKILL_DIRS) {
    if (plugin === id && await exists(path.join(userRoot, rel))) await archive(ctx, path.join(userRoot, rel));
  }
  for (const rel of await filesUnder(userRoot)) await retirePluginFile(ctx, id, rel);
  await archiveSkillLeftovers(ctx, userRoot);
  await pruneEmptyDirs(userRoot);
}

/** Whether the home still holds the deployed copies of the old model. A deployed built-in plugin
 *  always carried a manifest, and the plugin sync put a missing one back on every start. */
async function hasDeployedPlugins(ctx: Ctx, builtinIds: readonly string[]): Promise<boolean> {
  for (const id of builtinIds) {
    for (const rel of RETIRED_PLUGIN_FILES) {
      if (await exists(path.join(ctx.dataDir, 'plugins', id, rel))) return true;
    }
  }
  return false;
}

// ── Hooks ──────────────────────────────────────────────────────

function withoutHookVersion(text: string): string {
  return text.replace(HOOK_VERSION_LINE, '');
}

async function migrateHookScripts(ctx: Ctx): Promise<void> {
  const shippedDir = path.join(ctx.defaultsDir, 'hooks');
  for (const file of await childNames(shippedDir, 'file')) {
    const deployed = path.join(ctx.dataDir, 'hooks', file);
    if (await exists(deployed)) await retireDeployedCopy(ctx, deployed, path.join(shippedDir, file), withoutHookVersion);
  }
}

function parseRecord(text: string | null): Record<string, unknown> | null {
  try {
    const value = text === null ? null : JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Key order is not content: compare registrations by their sorted keys, at every depth. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

function withoutVersion(entry: Record<string, unknown>): string {
  const { version: _version, ...rest } = entry;
  return JSON.stringify(canonical(rest));
}

/** The deployed registration's switch, when the user flipped it away from the shipped one. */
function switchedEnabled(deployed: Record<string, unknown>, shipped: Record<string, unknown>): boolean | null {
  const own = deployed.enabled !== false;
  return own === (shipped.enabled !== false) ? null : own;
}

async function migrateHookRegistration(ctx: Ctx, file: string): Promise<void> {
  const deployedPath = path.join(ctx.dataDir, 'config', 'hooks', file);
  const deployed = parseRecord(await readText(deployedPath));
  // A registration without an event is a partial override already: the user's, in the new shape.
  if (deployed && !('event' in deployed)) return;
  const shipped = parseRecord(await readText(path.join(ctx.defaultsDir, 'config', 'hooks', file)));
  if (deployed && shipped && withoutVersion(deployed) === withoutVersion(shipped)) return remove(ctx, deployedPath);
  const enabled = deployed && shipped ? switchedEnabled(deployed, shipped) : null;
  await archive(ctx, deployedPath);
  if (enabled !== null) await atomicWrite(deployedPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
}

async function migrateHookRegistrations(ctx: Ctx): Promise<void> {
  for (const file of await childNames(path.join(ctx.defaultsDir, 'config', 'hooks'), 'file')) {
    if (await exists(path.join(ctx.dataDir, 'config', 'hooks', file))) await migrateHookRegistration(ctx, file);
  }
}

// ── Rules, agent roles, system prompts ─────────────────────────

function sameText(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  return hash(left) === hash(right);
}

/** Copy-once files: a byte copy of the shipped file goes, anything else is the user's and stays. */
async function dropUnchangedCopies(ctx: Ctx, shippedDir: string, userDir: string): Promise<void> {
  for (const rel of await filesUnder(shippedDir)) {
    const own = path.join(userDir, rel);
    if (!await isFile(own)) continue;
    if (sameText(await readText(own), await readText(path.join(shippedDir, rel)))) await remove(ctx, own);
  }
}

// ── Environments ───────────────────────────────────────────────

function builtinAddresses(ctx: Ctx, builtinIds: readonly string[]): Map<string, string> {
  return new Map(builtinIds.map((id) => [path.join(ctx.dataDir, 'plugins', id), id]));
}

/** The environment as the new model needs it to load the same plugins, or null to leave it be. */
function migratedEnvironment(
  ctx: Ctx,
  body: Record<string, unknown>,
  builtinIds: readonly string[],
): Record<string, unknown> | null {
  if (body.skills === false || 'disabledPlugins' in body) return null;
  if (body.pluginDirs !== undefined && !Array.isArray(body.pluginDirs)) return null;
  const addresses = builtinAddresses(ctx, builtinIds);
  const dirs = Array.isArray(body.pluginDirs) ? body.pluginDirs : [];
  const listed = new Set<string>();
  const kept = dirs.filter((dir) => {
    const id = typeof dir === 'string' ? addresses.get(path.resolve(ctx.dataDir, dir)) : undefined;
    if (id) listed.add(id);
    return !id;
  });
  const next: Record<string, unknown> = { ...body, pluginDirs: kept };
  if (kept.length === 0) delete next.pluginDirs;
  next.disabledPlugins = builtinIds.filter((id) => !listed.has(id));
  return next;
}

async function migrateEnvironments(ctx: Ctx, builtinIds: readonly string[]): Promise<void> {
  const dir = path.join(ctx.dataDir, 'config', 'environments');
  for (const file of (await childNames(dir, 'file')).filter((name) => name.endsWith('.json'))) {
    const body = parseRecord(await readText(path.join(dir, file)));
    const next = body ? migratedEnvironment(ctx, body, builtinIds) : null;
    if (!next) continue;
    await atomicWrite(path.join(dir, file), `${JSON.stringify(next, null, 2)}\n`);
    ctx.report.environments.push(file);
  }
}

// ── Entry point ────────────────────────────────────────────────

function archiveStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export async function migrateToBuiltinOverlay(opts: BuiltinOverlayMigrationOptions): Promise<BuiltinOverlayReport> {
  const stamp = archiveStamp(opts.now ?? new Date());
  const ctx: Ctx = {
    ...opts,
    archiveDir: path.join(opts.dataDir, 'config', 'archive', `builtin-overlay-${stamp}`),
    report: { removed: [], archived: [], environments: [] },
  };
  const builtinIds = await childNames(path.join(opts.defaultsDir, 'plugins'), 'dir');
  // Environments first: whether they need rewriting is read off the deployed plugins removed below.
  if (await hasDeployedPlugins(ctx, builtinIds)) await migrateEnvironments(ctx, builtinIds);
  for (const id of builtinIds) await migratePlugin(ctx, id);
  await migrateHookScripts(ctx);
  await migrateHookRegistrations(ctx);
  await dropUnchangedCopies(ctx, path.join(opts.defaultsDir, 'rules'), path.join(opts.dataDir, 'rules'));
  await dropUnchangedCopies(ctx, path.join(opts.defaultsDir, 'agents'), path.join(opts.dataDir, 'config', 'agents'));
  await dropUnchangedCopies(ctx, path.join(opts.defaultsDir, 'prompts'), path.join(opts.dataDir, 'prompts'));
  log.info(`Built-in assets now read in place: ${JSON.stringify({
    removed: ctx.report.removed.length, archived: ctx.report.archived, environments: ctx.report.environments,
  })}`);
  return ctx.report;
}
