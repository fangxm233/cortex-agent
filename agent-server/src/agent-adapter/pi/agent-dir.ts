// input:  DATA_DIR, DEFAULTS_DIR, PI auth/provider files
// output: PI paths plus provider, auth, and built-in role setup
// pos:    Managed PI agent directory configuration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  mkdirSync,
  writeFileSync,
  renameSync,
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
import { DATA_DIR, DEFAULTS_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('pi-agent-dir');

/** PI_CODING_AGENT_DIR: PI reads models.json, auth.json from this dir. */
export const PI_AGENT_DIR = path.join(DATA_DIR, 'data', 'pi');
export const PI_SESSIONS_DIR = path.join(DATA_DIR, 'logs', 'sessions-pi');
export const PI_MODELS_PATH = path.join(PI_AGENT_DIR, 'models.json');
export const PI_DEFAULT_AGENTS_DIR = path.join(DEFAULTS_DIR, 'pi', 'agents');

const BUILTIN_PI_AGENT_NAMES = ['explore', 'general-purpose', 'plan'] as const;

/** Default location of the user's PI OAuth/API-key credentials. */
const USER_PI_AUTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');

// ─── Multi-provider models.json ───────────────────────────────────

/**
 * One provider entry to write into the cortex-controlled `models.json`. cortex uses PI's
 * "Override Built-in Providers" mechanism (docs/models.md §Overriding Built-in Providers):
 * specifying only `baseUrl` redirects all of that provider's traffic to our gateway while
 * keeping PI's built-in model catalog and OAuth/API-key auth resolution from auth.json intact.
 */
export interface ProviderOverride {
  /** PI provider name (e.g. "anthropic", "deepseek", "openai-codex"). */
  name: string;
  /**
   * Path segment appended to the gateway URL. Defaults to `/${name}`.
   * Set explicitly when a provider needs to land on a non-standard gateway path
   * (e.g. deepseek's anthropic-compat endpoint: `/deepseek/anthropic`).
   */
  basePath?: string;
  /**
   * Per-spawn PI compat flags to write into this provider's models.json entry.
   * Merged ON TOP of PROVIDER_COMPAT_OVERRIDES (explicit wins). Normally unset —
   * the static table covers the known cases.
   */
  compat?: Record<string, unknown>;
}

/**
 * PI compat flags that PI auto-detects from the provider's *real* endpoint URL but loses once
 * cortex rewrites `baseUrl` to the gateway. PI's `detectCompat()` keys `supportsDeveloperRole`
 * off `baseUrl.includes("deepseek.com")` ONLY (not the provider name), so routing DeepSeek
 * through `http://127.0.0.1:9880/deepseek` makes PI wrongly assume the endpoint accepts the
 * OpenAI `developer` system-prompt role — DeepSeek's API rejects it with HTTP 400 (empty output).
 * We re-assert the lost flags here, keyed by PI provider name (the override preserves the name).
 * Add a row here if another gateway-routed provider exhibits the same URL-detection loss.
 */
const PROVIDER_COMPAT_OVERRIDES: Record<string, Record<string, unknown>> = {
  deepseek: { supportsDeveloperRole: false },
};

export interface WriteProvidersOpts {
  /** Override target file path. Defaults to PI_MODELS_PATH. */
  modelsPath?: string;
}

/**
 * Atomic-write models.json with multi-provider baseUrl overrides. Each provider entry has a
 * `baseUrl` pointing to `<gatewayUrl><basePath>`; no apiKey is written so PI resolves credentials
 * from auth.json (or environment variables) per PI's auth resolution order.
 *
 * Called by PIAdapter.spawn() — sole writer of this file, no other code path touches it.
 */
export function writeProvidersConfig(
  providers: ProviderOverride[],
  gatewayUrl: string,
  opts?: WriteProvidersOpts,
): void {
  const targetPath = opts?.modelsPath ?? PI_MODELS_PATH;

  const providersBlock: Record<string, { baseUrl: string; compat?: Record<string, unknown> }> = {};
  for (const p of providers) {
    const basePath = p.basePath ?? `/${p.name}`;
    const entry: { baseUrl: string; compat?: Record<string, unknown> } = {
      baseUrl: `${gatewayUrl}${basePath}`,
    };
    // Re-assert compat flags PI can no longer auto-detect now that baseUrl is the gateway.
    // Static table first, then per-override compat (explicit wins).
    const compat = { ...PROVIDER_COMPAT_OVERRIDES[p.name], ...p.compat };
    if (Object.keys(compat).length > 0) entry.compat = compat;
    providersBlock[p.name] = entry;
  }

  const data = { providers: providersBlock };
  const content = JSON.stringify(data, null, 2) + '\n';

  mkdirSync(path.dirname(targetPath), { recursive: true });

  // Atomic write: tmp + rename
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of orphan tmp file (rename failure case)
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Compute the set of PI providers whose baseUrl should be overridden to the gateway for a spawn.
 *
 * Design: "route through gateway" and "PI has credentials" are independent concerns. Discovery
 * (`pi --list-models`) only reports providers the user is authenticated to, but a profile may
 * legitimately route a provider through the gateway even without direct PI credentials (the
 * gateway injects managed keys). So the override set is the union of:
 *   - `discovered`        — providers PI reports creds for (credential passthrough via auth.json)
 *   - `currentProvider`   — the provider THIS spawn uses (`--provider`); it MUST be routed, always
 *
 * `gatewayPath`, when set, becomes the current provider's `basePath` (decouples the gateway route
 * from the provider name — e.g. provider "anthropic" landing on "/deepseek-anthropic"). It wins
 * over the default `/<name>` even if the current provider was also discovered.
 */
export function buildProviderOverrides(
  discovered: string[],
  currentProvider: string | null,
  gatewayPath?: string | null,
): ProviderOverride[] {
  const byName = new Map<string, ProviderOverride>();
  for (const name of discovered) {
    if (!byName.has(name)) byName.set(name, { name });
  }
  if (currentProvider) {
    byName.set(currentProvider, {
      name: currentProvider,
      ...(gatewayPath ? { basePath: gatewayPath } : {}),
    });
  }
  return Array.from(byName.values());
}

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
