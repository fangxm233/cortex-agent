// input:  DEFAULTS_DIR, host PI auth file, PI path defaults
// output: host-side PI auth mirroring and built-in role setup
// pos:    Managed PI agent directory configuration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  symlinkSync,
  copyFileSync,
  constants as fsConstants,
} from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULTS_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { PI_AGENT_DIR, PI_SESSIONS_DIR } from './defaults.js';

const log = createLogger('pi-agent-dir');

// The host-path constants and the pure provider-catalog writer moved out so a trial adapter can
// reach the writer without importing this module's ambient auth mirroring (design §13 A5/A6, T12).
export { PI_AGENT_DIR, PI_SESSIONS_DIR, PI_MODELS_PATH } from './defaults.js';
export {
  buildProviderOverrides, writeProvidersConfig,
  type ProviderOverride, type WriteProvidersOpts,
} from './providers-config.js';

export const PI_DEFAULT_AGENTS_DIR = path.join(DEFAULTS_DIR, 'pi', 'agents');

const BUILTIN_PI_AGENT_NAMES = ['explore', 'general-purpose', 'plan'] as const;

/** Default location of the user's PI OAuth/API-key credentials. */
const USER_PI_AUTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');

// ─── auth.json visibility (symlink / copy from user PI dir) ──────

export interface EnsureAuthVisibleOpts {
  /** Source: where the user's PI auth.json lives. Defaults to ~/.pi/agent/auth.json. */
  userAuthPath?: string;
  /** Target dir (PI_CODING_AGENT_DIR). Defaults to PI_AGENT_DIR. */
  agentDir?: string;
}

/**
 * Make the user's PI OAuth/API-key credentials visible to the PI subprocess running under
 * cortex's PI_CODING_AGENT_DIR. Uses symlink on Linux/macOS so PI's automatic OAuth refresh
 * writes back to the user's canonical location. Falls back to file copy on Windows.
 *
 * Idempotent: a correctly-pointed symlink is preserved; a stale file/symlink is replaced.
 * Silently no-ops when the user has not logged into PI (no source auth.json).
 */
export function ensureAuthVisible(opts?: EnsureAuthVisibleOpts): void {
  const userAuth = opts?.userAuthPath ?? USER_PI_AUTH_PATH;
  const agentDir = opts?.agentDir ?? PI_AGENT_DIR;
  const cortexAuth = path.join(agentDir, 'auth.json');

  if (!existsSync(userAuth)) {
    // User hasn't logged into PI; nothing to mirror.
    return;
  }

  mkdirSync(agentDir, { recursive: true });

  // Inspect the destination — preserve correct symlink, replace anything else.
  if (existsSync(cortexAuth) || isBrokenSymlink(cortexAuth)) {
    try {
      const stat = lstatSync(cortexAuth);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(cortexAuth);
        if (target === userAuth && process.platform !== 'win32') {
          // Already a correctly-pointing symlink, nothing to do.
          return;
        }
      }
      unlinkSync(cortexAuth);
    } catch (err) {
      log.warn(`Failed to inspect/remove existing ${cortexAuth}: ${(err as Error).message}`);
      return;
    }
  }

  if (process.platform === 'win32') {
    // Windows: symlink requires elevated permissions on many systems; copy instead.
    // KNOWN LIMITATION: PI's OAuth refresh writes to the cortex-private copy, not the user's
    // original file. Re-running ensureAuthVisible would overwrite the refreshed token. See
    // /home/fangxin/.cortex/plan/generic-wibbling-pine.md §D4 for Windows-specific TODO.
    copyFileSync(userAuth, cortexAuth);
  } else {
    symlinkSync(userAuth, cortexAuth);
  }
}

/** Returns true if `p` is a dangling symlink (exists in lstat sense but not in stat sense). */
function isBrokenSymlink(p: string): boolean {
  try {
    const lst = lstatSync(p);
    if (!lst.isSymbolicLink()) return false;
    // existsSync follows links; if it returned false we already know the link is broken.
    return !existsSync(p);
  } catch {
    return false;
  }
}

// ─── Built-in subagent roles ─────────────────────────────────────

export interface EnsurePIAgentRolesOpts {
  defaultsDir?: string;
  agentDir?: string;
}

export function ensurePIAgentRoles(opts?: EnsurePIAgentRolesOpts): void {
  const defaultsDir = opts?.defaultsDir ?? PI_DEFAULT_AGENTS_DIR;
  const targetDir = path.join(opts?.agentDir ?? PI_AGENT_DIR, 'agents');
  mkdirSync(targetDir, { recursive: true });
  for (const name of BUILTIN_PI_AGENT_NAMES) {
    const source = path.join(defaultsDir, `${name}.md`);
    const target = path.join(targetDir, `${name}.md`);
    try {
      copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

// ─── Directory bootstrap ──────────────────────────────────────────

export function ensurePIAgentDirs(): void {
  mkdirSync(PI_AGENT_DIR, { recursive: true });
  mkdirSync(PI_SESSIONS_DIR, { recursive: true });
  ensurePIAgentRoles();
}
