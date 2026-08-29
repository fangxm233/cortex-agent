// input:  DEFAULTS_DIR/plugins/<plugin> (each with .claude-plugin/plugin.json `version`) + PLUGINS_DIR (DATA_DIR/plugins)
// output: syncManagedPlugins() — deploys a new plugin, or refreshes a deployed one when the shipped version is newer
// pos:    Startup asset-sync sibling to runMigrations / syncManagedHooks; keeps DATA_DIR/plugins in sync
//         with defaults. init.ts copyDefaults() uses safeCopyDir (copy-if-missing) and only runs on
//         `cortex init`, so an existing install never gets a NEW plugin or an UPDATED skill on upgrade.
//         This closes that gap, keyed on each plugin's .claude-plugin/plugin.json `version`.
//
//   CONVENTION: whenever you change ANY file inside a plugin (a skill's SKILL.md, a script, the
//   manifest), bump that plugin's `version` in .claude-plugin/plugin.json — the analog of bumping
//   @cortex-hook-version on a hook. Without a bump the change will NOT propagate to existing installs.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULTS_DIR, PLUGINS_DIR } from '@core/paths.js';
import { atomicWrite } from '@core/atomic-write.js';
import { compareCalVer } from './version-migrations.js';
import { createLogger } from '@core/log.js';

const log = createLogger('plugin-sync');

const MANIFEST_REL = path.join('.claude-plugin', 'plugin.json');

/** Skill directories that MOVED to another plugin. The sync only ever writes shipped files, never
 *  deletes, so a skill that changed plugins would otherwise stay live at its old address on every
 *  existing install — and a skill's whole point is that it loads. Each entry is removed once and
 *  then stays removed (it no longer ships, so nothing puts it back).
 *
 *  `[plugin, relative path]`; the path is joined under PLUGINS_DIR and must stay inside it. */
export const RETIRED_PLUGIN_PATHS: ReadonlyArray<readonly [string, string]> = [
  // Moved to cortex-commission, which loads only in commission mode (DR-0037 v2).
  ['cortex-system', 'skills/commission'],
];

/** Remove retired paths from the deployed tree. Returns the plugin-relative ids actually removed. */
export async function pruneRetiredPluginPaths(dstDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const [plugin, rel] of RETIRED_PLUGIN_PATHS) {
    const target = path.resolve(dstDir, plugin, rel);
    // Belt and braces: a bad entry must not turn this into an arbitrary delete.
    if (!target.startsWith(path.resolve(dstDir) + path.sep)) continue;
    if (!existsSync(target)) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(`${plugin}/${rel}`);
      log.info(`removed retired plugin path ${plugin}/${rel}`);
    } catch (e) {
      log.error(`failed to remove retired plugin path ${plugin}/${rel}: ${(e as Error).message}`);
    }
  }
  return removed;
}

/** Parse the `version` field from a plugin.json manifest string, or null if absent/malformed.
 *  compareCalVer is a generic numeric dotted-version comparator, so plain semver ("0.1.0") works. */
export function parsePluginVersion(manifestJson: string): string | null {
  try {
    const parsed = JSON.parse(manifestJson);
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).version === 'string') {
      const v = (parsed as Record<string, string>).version.trim();
      return v.length > 0 ? v : null;
    }
  } catch {
    // malformed JSON → treat as unversioned
  }
  return null;
}

/** Read a plugin's manifest version from `<pluginDir>/.claude-plugin/plugin.json`, or null. */
async function readPluginVersion(pluginDir: string): Promise<string | null> {
  try {
    return parsePluginVersion(await fs.readFile(path.join(pluginDir, MANIFEST_REL), 'utf8'));
  } catch {
    return null;
  }
}

/** Recursively walk every file under `src` and atomicWrite it into `dst` at the same relative
 *  path, creating parent dirs as needed. Overwrites shipped files; never deletes anything already
 *  in `dst` (so user-added skills/files inside a managed plugin are preserved). */
async function copyPluginTree(src: string, dst: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyPluginTree(srcPath, dstPath);
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      await atomicWrite(dstPath, await fs.readFile(srcPath, 'utf8'));
    }
  }
}

/**
 * Keep version-managed plugins in PLUGINS_DIR in sync with the shipped defaults.
 *
 * A default plugin that declares a `version` in `.claude-plugin/plugin.json` is deployed when
 * missing, and refreshed (all its shipped files rewritten) whenever the shipped version is newer
 * than the deployed one. A missing or unversioned deployed copy counts as oldest, so legacy installs
 * are brought under management on first run. Unversioned default plugins (no manifest version) are
 * left to init's copy-if-missing and never touched here. User-added files inside a managed plugin are
 * preserved (only shipped files are written, nothing is deleted). Idempotent and crash-safe via
 * atomicWrite.
 *
 * `opts` exists for tests; production calls it with no args (real DEFAULTS_DIR/plugins + PLUGINS_DIR).
 * Returns the list of plugin names that were deployed or refreshed.
 */
export async function syncManagedPlugins(opts: { srcDir?: string; dstDir?: string } = {}): Promise<string[]> {
  const srcDir = opts.srcDir ?? path.join(DEFAULTS_DIR, 'plugins');
  const dstDir = opts.dstDir ?? PLUGINS_DIR;

  if (!existsSync(srcDir)) return [];

  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    return [];
  }

  await fs.mkdir(dstDir, { recursive: true });
  await pruneRetiredPluginPaths(dstDir);

  const updated: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const srcPlugin = path.join(srcDir, name);

    const srcVer = await readPluginVersion(srcPlugin);
    if (!srcVer) continue; // unversioned default → leave to init's copy-if-missing

    const dstPlugin = path.join(dstDir, name);
    if (existsSync(dstPlugin)) {
      const dstVer = await readPluginVersion(dstPlugin);
      // Deployed copy already at or ahead of the shipped version → current; skip.
      // A missing/unparseable deployed version (dstVer === null) counts as oldest → refresh.
      if (dstVer && compareCalVer(dstVer, srcVer) >= 0) continue;
    }

    try {
      await copyPluginTree(srcPlugin, dstPlugin);
      updated.push(name);
      log.info(`synced plugin ${name} → ${srcVer}`);
    } catch (e) {
      log.error(`failed to sync plugin ${name}: ${(e as Error).message}`);
    }
  }

  if (updated.length === 0) {
    log.info('managed plugins up to date');
  }
  return updated;
}
