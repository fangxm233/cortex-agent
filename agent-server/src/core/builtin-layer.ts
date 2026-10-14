import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Built-in assets (plugins, hooks, rules, agent roles, system prompts) are read straight from the
 * install's `defaults/` at runtime. The Cortex home holds only the user's own files: one at the
 * matching location replaces the built-in, a new name adds, and deleting it restores the built-in.
 */
export type LayerOrigin = 'builtin' | 'overridden' | 'local';

/** A sealed home (`CORTEX_CONFIG_IMMUTABLE=1`, a benchmark trial) declares its whole surface, so the
 *  built-in plugins, hooks and rules stay out of it. */
export function builtinLayerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CORTEX_CONFIG_IMMUTABLE !== '1';
}

export interface LayeredFile {
  name: string;
  /** The file in effect: the user's when there is one, otherwise the built-in. */
  path: string;
  origin: LayerOrigin;
  /** The built-in file of the same name, whether or not it is overridden. */
  builtinPath: string | null;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function fileNames(dir: string | null, suffix: string): Set<string> {
  if (!dir) return new Set();
  try {
    return new Set(readdirSync(dir).filter((name) => name.endsWith(suffix) && isFile(path.join(dir, name))));
  } catch {
    return new Set();
  }
}

function layeredFile(name: string, builtinDir: string | null, userDir: string, inBuiltin: boolean, inUser: boolean): LayeredFile {
  const builtinPath = inBuiltin && builtinDir ? path.join(builtinDir, name) : null;
  if (!inUser) return { name, path: builtinPath!, origin: 'builtin', builtinPath };
  return { name, path: path.join(userDir, name), origin: builtinPath ? 'overridden' : 'local', builtinPath };
}

/** Every `*<suffix>` file of the two layers, by name; a user file shadows the built-in of the same
 *  name. `builtinDir` null means the user layer alone. */
export function listLayeredFiles(builtinDir: string | null, userDir: string, suffix: string): LayeredFile[] {
  const builtin = fileNames(builtinDir, suffix);
  const user = fileNames(userDir, suffix);
  return [...new Set([...builtin, ...user])].sort()
    .map((name) => layeredFile(name, builtinDir, userDir, builtin.has(name), user.has(name)));
}

/** One named file through the two layers, or null when neither has it. */
export function resolveLayeredFile(builtinDir: string | null, userDir: string, name: string): LayeredFile | null {
  const inBuiltin = builtinDir !== null && isFile(path.join(builtinDir, name));
  const inUser = isFile(path.join(userDir, name));
  return inBuiltin || inUser ? layeredFile(name, builtinDir, userDir, inBuiltin, inUser) : null;
}
