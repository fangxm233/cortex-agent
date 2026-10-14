import path from 'node:path';
import { builtinLayerEnabled } from '@core/builtin-layer.js';
import { DATA_DIR, DEFAULTS_DIR } from '@core/paths.js';
import { listImmediateChildNames } from './fs-helpers.js';

/** The plugins Cortex ships, read in place. `plugins/<id>` in the Cortex home is the user's layer
 *  of the same plugin: its skills replace or add to the shipped ones. */
export const BUILTIN_PLUGINS_DIR = path.join(DEFAULTS_DIR, 'plugins');

/** The built-in plugins dir in effect: none in a sealed home, which lists its whole surface. */
export function defaultBuiltinPluginsDir(): string | null {
  return builtinLayerEnabled() ? BUILTIN_PLUGINS_DIR : null;
}

export function listBuiltinPluginIds(builtinDir: string | null = defaultBuiltinPluginsDir()): string[] {
  return builtinDir ? listImmediateChildNames(builtinDir) : [];
}

export function isBuiltinPlugin(id: string, builtinDir: string | null = defaultBuiltinPluginsDir()): boolean {
  return listBuiltinPluginIds(builtinDir).includes(id);
}

/** A plugin's address in `pluginDirs`, whether it is built in, the user's, or both. */
export function pluginAddress(id: string): string {
  return path.posix.join('plugins', id);
}

export interface EnvironmentPluginFields {
  pluginDirs?: string[];
  disabledPlugins?: string[];
  skills?: boolean;
}

/** Whether built-in plugins load in this environment by default. An environment that switches
 *  skills off, and a sealed home, load only what `pluginDirs` lists. */
export function builtinPluginsApply(def: EnvironmentPluginFields): boolean {
  return def.skills !== false && builtinLayerEnabled();
}

function absolutePluginDir(dir: string, dataDir: string): string {
  return path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(dataDir, dir);
}

/**
 * The plugin directories an environment loads: what it lists, then every built-in plugin it does
 * not opt out of with `disabledPlugins`. Relative entries resolve against the data dir.
 */
export function environmentPluginDirs(
  def: EnvironmentPluginFields,
  opts: { dataDir?: string; builtinIds?: readonly string[] } = {},
): string[] | undefined {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const listed = (def.pluginDirs ?? []).map((dir) => absolutePluginDir(dir, dataDir));
  if (!builtinPluginsApply(def)) return def.pluginDirs ? listed : undefined;
  const disabled = new Set(def.disabledPlugins ?? []);
  const builtins = (opts.builtinIds ?? listBuiltinPluginIds(BUILTIN_PLUGINS_DIR))
    .filter((id) => !disabled.has(id))
    .map((id) => absolutePluginDir(pluginAddress(id), dataDir));
  return [...new Set([...listed, ...builtins])];
}
