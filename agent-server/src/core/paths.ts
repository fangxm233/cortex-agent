// input:  nothing (leaf module)
// output: INSTALL_ROOT / DEFAULTS_DIR / DATA_DIR / CONFIG_DIR / STORE_DIR / CONTEXT_DIR / PROJECTS_DIR / WORKSPACE_DIR / PLUGINS_DIR / PROMPTS_DIR / HOOKS_DIR / LOGS_DIR / resolveWorkspaceRelPath()
//         (deprecated aliases: PACKAGE_ROOT, SERVER_ROOT, REPO_ROOT — all map to INSTALL_ROOT for migration period)
// pos:    canonical path constants — install root (immutable code/assets) + user data/config/store/context/tmp
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

// This file lives at dist/core/paths.js when installed (or running from repo via tsx).
// Two levels up resolves to the install/package root, which contains `dist/` and `defaults/`.
//   Install layout:  <prefix>/lib/node_modules/cortex-agent-server/{dist,defaults}/
//   Repo layout:     <repo>/agent-server/{dist,defaults}/  (Node resolves symlinks via realpath)
const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Installed package root — where `dist/` and `defaults/` live. Immutable code/assets,
 *  never write here. For user-mutable state use DATA_DIR. */
export const INSTALL_ROOT = path.resolve(CORE_DIR, '..', '..');

/** Default scaffold assets shipped with the package. Read-only at runtime;
 *  `cortex init` copies what users need from here into DATA_DIR. */
export const DEFAULTS_DIR = path.join(INSTALL_ROOT, 'defaults');

/** @deprecated Use INSTALL_ROOT. Kept as alias during refactor. */
export const PACKAGE_ROOT = INSTALL_ROOT;

/** @deprecated Use INSTALL_ROOT. Kept as alias during refactor. */
export const SERVER_ROOT = INSTALL_ROOT;

/** @deprecated Use INSTALL_ROOT or DATA_DIR depending on intent. Alias during refactor. */
export const REPO_ROOT = INSTALL_ROOT;

/** User data directory. Reads $CORTEX_HOME, falls back to ~/.cortex/. */
export const DATA_DIR = process.env.CORTEX_HOME
  ? path.resolve(process.env.CORTEX_HOME)
  : path.join(os.homedir(), '.cortex');

/** Configuration files — .env, budget, mode, profiles, templates, etc. (DATA_DIR/config/). */
export const CONFIG_DIR = path.join(DATA_DIR, 'config');

/** Persistent store for runtime JSON state files (DATA_DIR/data/). */
export const STORE_DIR = path.join(DATA_DIR, 'data');

/** Research context root — OVERVIEW, decisions, projects, scans, user profile (DATA_DIR/context/). */
export const CONTEXT_DIR = path.join(DATA_DIR, 'context');

/** User project directory. Reads $CORTEX_PROJECTS_DIR, falls back to CONTEXT_DIR/projects/. */
export const PROJECTS_DIR = process.env.CORTEX_PROJECTS_DIR
  ? path.resolve(process.env.CORTEX_PROJECTS_DIR)
  : path.join(CONTEXT_DIR, 'projects');

/** Temporary workspace directory for thread artifacts, tool results, etc. */
export const WORKSPACE_DIR = path.join(DATA_DIR, 'tmp');

/** Resolve a UI-relative `workspace/…` path to an absolute path strictly inside WORKSPACE_DIR.
 *  The `workspace/` prefix is a stable UI-facing ALIAS for WORKSPACE_DIR's contents — it is NOT the
 *  directory's real basename (which is `tmp`). File cards (attachments/outputs) are stored under
 *  `WORKSPACE_DIR/<sub>` and surfaced to the UI as `workspace/<sub>`; every consumer that turns such a
 *  relative path back into an absolute one MUST go through here so the alias resolves consistently
 *  (the divergent `path.join(WORKSPACE_DIR, '..', rel)` in agent-runner produced `<DATA_DIR>/workspace/…`,
 *  a non-existent path, once WORKSPACE_DIR moved from `workspace` to `tmp`).
 *  Returns null when the prefix is wrong or the resolved target escapes the workspace root. */
export function resolveWorkspaceRelPath(rel: string): string | null {
  const PREFIX = 'workspace/';
  if (!rel.startsWith(PREFIX)) return null;
  const sub = rel.slice(PREFIX.length);
  const root = path.resolve(WORKSPACE_DIR);
  const target = path.resolve(root, sub);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Plugin packages directory (DATA_DIR/plugins/). */
export const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');

/** Prompt files directory — directives, systemPrompts, promptTemplates (DATA_DIR/prompts/). */
export const PROMPTS_DIR = path.join(DATA_DIR, 'prompts');

/** Claude Code hook scripts directory (DATA_DIR/hooks/). */
export const HOOKS_DIR = path.join(DATA_DIR, 'hooks');

/** Log files directory — server daily logs, event logs, session logs (DATA_DIR/logs/). */
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
