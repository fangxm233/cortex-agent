// input:  DATA_DIR/config/thread-templates/agents/*.json + DATA_DIR/plugins + versions.json sentinel
// output: retireTemplatePluginRefs() — drops references to retired plugins from deployed agent
//         templates and adds plugin dirs that shipped after the install was created
// pos:    Startup asset-sync sibling to syncManagedPlugins; supplies the half of plugin retirement
//         that plugin-sync cannot do. plugin-sync owns DATA_DIR/plugins (copy shipped files, prune
//         RETIRED_PLUGIN_PATHS); this owns the *references* to those plugins. Without it a plugin
//         that stops shipping keeps loading forever on existing installs — nothing deletes the
//         deployed copy, and config/thread-templates/ is only ever written by `cortex init`, which
//         an upgrade does not run (postinstall restarts the daemon, it does not re-init).
//
//   CONVENTION: retiring or moving a plugin takes THREE edits, not one.
//     1. remove it from defaults/plugins/ and from the shipped templates' pluginDirs
//     2. add it to RETIRED_TEMPLATE_PLUGINS here, with the last version you shipped
//     3. if individual skills moved between plugins, add RETIRED_PLUGIN_PATHS entries in
//        plugin-sync.ts so the old copy stops competing with the new one
//   Step 1 alone is a no-op for every existing install.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DATA_DIR, PLUGINS_DIR, STORE_DIR } from '@core/paths.js';
import { atomicWrite } from '@core/atomic-write.js';
import { CORTEX_VERSION } from '@core/version.js';
import { createLogger } from '@core/log.js';
import { parsePluginVersion } from './plugin-sync.js';
import { compareCalVer, loadVersionsFrom, saveVersionsTo } from './version-migrations.js';

const log = createLogger('plugin-retirement');

/** versions.json key guarding this one-shot rewrite. Present → already run; the user is free to
 *  re-add a retired plugin dir by hand afterwards without us stripping it again on next boot. */
export const TEMPLATE_PLUGIN_REFS_KEY = 'config/thread-templates/agents';

/** Plugins that no longer ship, with the last version that did.
 *
 *  `lastShippedVersion` is the customization discriminator. A deployed copy at or below it is the
 *  stock copy we put there, so dropping its reference loses nothing the user wrote. A copy above it
 *  was re-versioned locally — someone is maintaining that plugin themselves, and its reference is
 *  left alone. Files on disk are never deleted either way: an unreferenced plugin is inert, and a
 *  wrongly-deleted one is unrecoverable. */
export const RETIRED_TEMPLATE_PLUGINS: ReadonlyArray<{ name: string; lastShippedVersion: string }> = [
  // Trimmed from the bundled set in 2026.9.8 (commit e50411c58).
  { name: 'cortex-common', lastShippedVersion: '0.1.5' },
  { name: 'cortex-coder', lastShippedVersion: '0.1.2' },
  { name: 'cortex-stage-gate', lastShippedVersion: '0.1.4' },
];

/** Plugin dirs that started shipping after older installs were created, keyed by the agent files
 *  whose shipped definition carries them. Deployed templates are never rewritten by an upgrade, so
 *  without this a newly bundled plugin lands in DATA_DIR/plugins and is never loaded by anything. */
export const ADDED_TEMPLATE_PLUGIN_DIRS: ReadonlyArray<{ agents: readonly string[]; dir: string }> = [
  // cortex-commission split out of cortex-system in 2026.9.8; loads only where commissions start.
  { agents: ['main', 'direct', 'direct-web'], dir: 'plugins/cortex-commission' },
];

type RetiredState = 'absent' | 'stock' | 'customized';

/** Which retired plugin a pluginDirs entry points at, or null if it points elsewhere.
 *  Only direct children of DATA_DIR/plugins count — an entry aimed anywhere else is the user's
 *  own layout and not ours to rewrite. */
function retiredNameOf(entry: string, dataDir: string): string | null {
  const abs = path.isAbsolute(entry) ? entry : path.resolve(dataDir, entry);
  const rel = path.relative(path.join(dataDir, 'plugins'), abs);
  if (!rel || rel.startsWith('..') || rel.includes(path.sep)) return null;
  return RETIRED_TEMPLATE_PLUGINS.some((p) => p.name === rel) ? rel : null;
}

/** Classify the deployed copy of a retired plugin. A manifest we cannot read counts as customized:
 *  the safe default when we cannot prove the copy is ours is to leave it wired up. */
async function classifyRetired(pluginsDir: string, name: string, lastShippedVersion: string): Promise<RetiredState> {
  let manifest: string;
  try {
    manifest = await fs.readFile(path.join(pluginsDir, name, '.claude-plugin', 'plugin.json'), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'customized';
  }
  const deployed = parsePluginVersion(manifest);
  if (!deployed) return 'customized';
  return compareCalVer(deployed, lastShippedVersion) <= 0 ? 'stock' : 'customized';
}

async function listAgentFiles(agentsDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(agentsDir)).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`cannot read ${agentsDir}: ${(e as Error).message}`);
    }
    return [];
  }
}

export interface RetirementOptions {
  /** Override DATA_DIR. Tests point this at a temp tree; production passes nothing. */
  dataDir?: string;
  /** Override DATA_DIR/plugins. Defaults to `<dataDir>/plugins`. */
  pluginsDir?: string;
  /** Override the versions.json directory. Defaults to `<dataDir>/data`. */
  storeDir?: string;
}

/**
 * One-shot rewrite of deployed agent templates so they match the plugin set that actually ships.
 *
 * Drops pluginDirs entries pointing at a retired plugin whose deployed copy is missing (a dead
 * pointer) or stock (ours to retire), and adds plugin dirs that began shipping after the install
 * was created. Locally customized retired plugins keep their references. Nothing on disk is
 * deleted, and agent files the rewrite does not change are not rewritten at all.
 *
 * Guarded by a versions.json sentinel so it runs exactly once per install: afterwards the user can
 * re-add any of these dirs by hand and it stays. Returns the agent file names that changed.
 */
export async function retireTemplatePluginRefs(opts: RetirementOptions = {}): Promise<string[]> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const pluginsDir = opts.pluginsDir ?? (opts.dataDir ? path.join(opts.dataDir, 'plugins') : PLUGINS_DIR);
  const storeDir = opts.storeDir ?? (opts.dataDir ? path.join(opts.dataDir, 'data') : STORE_DIR);
  const versionsFile = path.join(storeDir, 'versions.json');

  const versions = await loadVersionsFrom(versionsFile);
  if (versions[TEMPLATE_PLUGIN_REFS_KEY]) return [];

  const agentsDir = path.join(dataDir, 'config', 'thread-templates', 'agents');
  const files = await listAgentFiles(agentsDir);

  // Classify each retired plugin once, not once per file.
  const states = new Map<string, RetiredState>();
  for (const { name, lastShippedVersion } of RETIRED_TEMPLATE_PLUGINS) {
    states.set(name, await classifyRetired(pluginsDir, name, lastShippedVersion));
  }

  const changed: string[] = [];
  for (const file of files) {
    const absPath = path.join(agentsDir, file);
    let agent: Record<string, unknown>;
    try {
      agent = JSON.parse(await fs.readFile(absPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      log.warn(`skipping ${file}: ${(e as Error).message}`);
      continue;
    }
    const dirs = agent.pluginDirs;
    if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string')) continue;

    const kept = (dirs as string[]).filter((entry) => {
      const name = retiredNameOf(entry, dataDir);
      if (!name) return true;
      const state = states.get(name);
      if (state === 'customized') return true;
      log.info(`${file}: dropping ${entry} (${state} retired plugin)`);
      return false;
    });

    const agentName = file.replace(/\.json$/, '');
    for (const { agents, dir } of ADDED_TEMPLATE_PLUGIN_DIRS) {
      if (!agents.includes(agentName) || kept.includes(dir)) continue;
      kept.push(dir);
      log.info(`${file}: adding ${dir}`);
    }

    if (kept.length === dirs.length && kept.every((d, i) => d === dirs[i])) continue;
    agent.pluginDirs = kept;
    await atomicWrite(absPath, JSON.stringify(agent, null, 2) + '\n');
    changed.push(file);
  }

  versions[TEMPLATE_PLUGIN_REFS_KEY] = CORTEX_VERSION;
  await saveVersionsTo(versionsFile, versions);

  if (changed.length > 0) log.info(`rewrote plugin refs in ${changed.length} agent template(s)`);
  return changed;
}
