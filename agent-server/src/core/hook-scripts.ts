import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinLayerEnabled } from './builtin-layer.js';
import { DEFAULTS_DIR, HOOKS_DIR } from './paths.js';

/** The shipped hook scripts and the helpers they import, run in place from the install. */
export const BUILTIN_HOOKS_DIR = path.join(DEFAULTS_DIR, 'hooks');

/** Preloaded into a script from the user's hooks dir, so its relative imports of the shipped
 *  helpers (`./cortex-context-lib.mjs`, `./cortex-hook-api.mjs`, …) still resolve when only the
 *  script itself was copied there. A helper the user did copy is used as it is. */
const OVERLAY_IMPORT = path.join(BUILTIN_HOOKS_DIR, 'overlay', 'register.mjs');

export interface HookScriptDirs {
  /** The user's hooks dir: a script here replaces the built-in of the same name. */
  user: string;
  /** The shipped hooks dir; null in a sealed home, which runs only its own scripts. */
  builtin: string | null;
}

export function defaultHookScriptDirs(): HookScriptDirs {
  return { user: HOOKS_DIR, builtin: builtinLayerEnabled() ? BUILTIN_HOOKS_DIR : null };
}

export interface ResolvedHookScript {
  path: string;
  /** Read from the user's hooks dir (their own script or their copy of a built-in). */
  user: boolean;
}

/** Where `run.script` is read from. A name in neither dir resolves to the user's path, so the
 *  failure names the place a user script would go. */
export function resolveHookScript(script: string, dirs: HookScriptDirs = defaultHookScriptDirs()): ResolvedHookScript {
  const own = path.join(dirs.user, script);
  if (existsSync(own) || !dirs.builtin) return { path: own, user: true };
  const shipped = path.join(dirs.builtin, script);
  return existsSync(shipped) ? { path: shipped, user: false } : { path: own, user: true };
}

/** The `node` arguments that run one hook script. */
export function hookScriptArgs(script: string, dirs: HookScriptDirs = defaultHookScriptDirs()): string[] {
  const resolved = resolveHookScript(script, dirs);
  if (!resolved.user || !dirs.builtin) return [resolved.path];
  return ['--import', pathToFileURL(OVERLAY_IMPORT).href, resolved.path];
}
