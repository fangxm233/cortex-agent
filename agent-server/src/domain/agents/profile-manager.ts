// input:  profiles.json through profileRepo
// output: validated profile and fallback resolution
// pos:    Resolves named Claude/PI profiles and provider identity
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { profileRepo } from '@store/profile-repo.js';
import type { Backend } from '../../agent-adapter/types.js';

export interface ProfileEntry {
  model: string;
  backend?: Backend;
  /** Gateway route mode — a logical name resolved by gateway.yaml (e.g. "plan", "api", "anthropic").
   *  Used for ALL backends to build the gateway URL `/m/<mode>/<endpoint>`; gateway.yaml owns the
   *  upstream URL + keys for each mode. (For claude the endpoint is "anthropic"; for pi it is the
   *  `provider` below.) */
  mode?: string;
  /** Opaque provider identity used by rate-limit isolation. For backend='pi' it also selects the
   *  PI request protocol and gateway endpoint; PI profiles must declare it explicitly. */
  provider?: string;
  extraEnv?: Record<string, string>;
  extraOption?: Record<string, string>;
  /** DR-0012: opt into TUI-mode Claude (interactive tmux + jsonl tail). Default 'print' for backward
   *  compatibility. Only meaningful when backend='claude'. Other backends ignore the field. */
  claudeBackend?: 'print' | 'tui';
  /** Optional thinking level. Backend-native value set, validated against the entry's effective
   *  backend: claude → `--effort` (low/medium/high/xhigh/max), pi → `--thinking`
   *  (off/minimal/low/medium/high/xhigh). Fallback entries do not inherit it. */
  thinking?: string;
  fallback?: ProfileEntry[];
}

export interface ProfilesFile {
  defaultProfile: string;
  profiles: Record<string, ProfileEntry>;
}

export interface ResolvedProfile extends ProfileEntry {
  name: string;
}

export interface ResolvedProfileConfig {
  name: string;
  model: string;
  backend: Backend;
  mode: string | null;
  /** Opaque rate-limit provider identity; for PI it is also the required request protocol. */
  provider: string | null;
  extraEnv: Record<string, string>;
  extraOption: Record<string, string>;
  /** DR-0012: resolved claude adapter mode. 'print' (default, uses -p + stream-json) or 'tui'
   *  (interactive Claude under tmux + jsonl tail). Ignored for non-claude backends. */
  claudeBackend: 'print' | 'tui';
  /** Thinking level (backend-native value). null → nothing is passed to the CLI. */
  thinking: string | null;
  fallback: Array<{ model: string; backend: Backend; mode: string | null; provider: string | null; extraEnv: Record<string, string>; extraOption: Record<string, string>; claudeBackend: 'print' | 'tui'; thinking: string | null }>;
}

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MODE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// provider shares mode's safe-name shape (alphanumeric, dash, underscore).
const PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const VALID_BACKENDS: ReadonlySet<string> = new Set(['claude', 'pi']);
const THINKING_LEVELS_BY_BACKEND: Record<Backend, Set<string>> = {
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  pi: new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
};

function loadProfilesFile(): ProfilesFile {
  try {
    const data = profileRepo.readSync();
    validateProfilesFile(data);
    return data;
  } catch (error) {
    throw new Error(`Failed to load profiles.json: ${(error as Error).message}`);
  }
}

function validateProfileEntry(profile: unknown, label: string, inheritedBackend: Backend = 'claude'): void {
  const p = profile as Record<string, unknown>;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new Error(`${label} must be an object`);
  }
  if (!p.model || typeof p.model !== 'string') {
    throw new Error(`${label} must define a non-empty string model`);
  }
  if (p.backend !== undefined && !VALID_BACKENDS.has(p.backend as string)) {
    throw new Error(`${label} has invalid backend: ${p.backend}`);
  }
  // Effective backend resolves to the explicit value, else the inherited one (primary → fallback).
  const effectiveBackend = (typeof p.backend === 'string' ? p.backend : inheritedBackend) as Backend;
  // PI requires an explicit provider — no default, no fallback (the PI `--provider` / gateway
  // endpoint group must be stated outright, never silently assumed).
  if (effectiveBackend === 'pi' && p.provider === undefined) {
    throw new Error(`${label} uses backend 'pi' and must declare an explicit provider (no default)`);
  }
  if (p.mode !== undefined) {
    if (typeof p.mode !== 'string' || !MODE_NAME_RE.test(p.mode)) {
      throw new Error(`${label} has invalid mode: ${p.mode}`);
    }
  }
  if (p.provider !== undefined) {
    if (typeof p.provider !== 'string' || !PROVIDER_NAME_RE.test(p.provider)) {
      throw new Error(`${label} has invalid provider: ${String(p.provider)}`);
    }
  }
  if (p.extraEnv !== undefined) {
    if (!p.extraEnv || typeof p.extraEnv !== 'object' || Array.isArray(p.extraEnv)) {
      throw new Error(`${label} extraEnv must be a plain object`);
    }
    for (const [k, v] of Object.entries(p.extraEnv as Record<string, unknown>)) {
      if (!ENV_KEY_RE.test(k)) {
        throw new Error(`${label} extraEnv has invalid key: ${k}`);
      }
      if (typeof v !== 'string') {
        throw new Error(`${label} extraEnv["${k}"] must be a string`);
      }
    }
  }
  if (p.extraOption !== undefined) {
    if (!p.extraOption || typeof p.extraOption !== 'object' || Array.isArray(p.extraOption)) {
      throw new Error(`${label} extraOption must be a plain object`);
    }
    for (const [k, v] of Object.entries(p.extraOption as Record<string, unknown>)) {
      if (typeof k !== 'string' || !k.startsWith('--')) {
        throw new Error(`${label} extraOption key must start with --: ${k}`);
      }
      if (typeof v !== 'string') {
        throw new Error(`${label} extraOption["${k}"] must be a string`);
      }
    }
  }
  if (p.claudeBackend !== undefined) {
    if (p.claudeBackend !== 'print' && p.claudeBackend !== 'tui') {
      throw new Error(`${label} has invalid claudeBackend: ${String(p.claudeBackend)} (expected 'print' or 'tui')`);
    }
  }
  if (p.thinking !== undefined) {
    const levels = THINKING_LEVELS_BY_BACKEND[effectiveBackend];
    if (!levels) {
      throw new Error(`${label} declares thinking but backend '${effectiveBackend}' does not support it`);
    }
    if (typeof p.thinking !== 'string' || !levels.has(p.thinking)) {
      throw new Error(`${label} has invalid thinking: ${String(p.thinking)} (backend '${effectiveBackend}' expects one of: ${[...levels].join(', ')})`);
    }
  }
}

/**
 * Pure resolver: maps a ProfileEntry's claudeBackend field to one of the two valid modes.
 * Defaults to 'print' for any non-'tui' value (including missing field). Used at adapter dispatch
 * time so unknown/legacy values silently fall back to the safe 'print' path.
 */
export function resolveClaudeBackend(p: { claudeBackend?: unknown }): 'print' | 'tui' {
  return p.claudeBackend === 'tui' ? 'tui' : 'print';
}

function validateProfilesFile(data: unknown): void {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    throw new Error('top-level value must be an object');
  }

  const { defaultProfile, profiles } = d;
  if (!defaultProfile || typeof defaultProfile !== 'string') {
    throw new Error('defaultProfile must be a non-empty string');
  }
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('profiles must be an object');
  }
  const profs = profiles as Record<string, unknown>;
  if (!profs[defaultProfile]) {
    throw new Error(`defaultProfile "${defaultProfile}" is missing from profiles`);
  }

  for (const [name, profile] of Object.entries(profs)) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(`invalid profile name: ${name}`);
    }
    validateProfileEntry(profile, `profile "${name}"`);
    const pe = profile as Record<string, unknown>;
    const primaryBackend = (typeof pe.backend === 'string' ? pe.backend : 'claude') as Backend;
    if (pe.fallback !== undefined) {
      if (!Array.isArray(pe.fallback)) {
        throw new Error(`profile "${name}" fallback must be an array`);
      }
      pe.fallback.forEach((fb: unknown, i: number) => {
        validateProfileEntry(fb, `profile "${name}" fallback[${i}]`, primaryBackend);
      });
    }
  }
}

function listProfiles(): ResolvedProfile[] {
  const data = loadProfilesFile();
  return Object.entries(data.profiles).map(([name, profile]) => ({ name, ...profile }));
}

function getDefaultProfileName(): string {
  return loadProfilesFile().defaultProfile;
}

function getProfile(name: string | null): ResolvedProfile | null {
  if (!name) return null;
  const data = loadProfilesFile();
  const profile = data.profiles[name];
  return profile ? { name, ...profile } : null;
}

function resolveProfile(name: string | null = null): ResolvedProfile {
  const data = loadProfilesFile();
  const resolvedName = name || data.defaultProfile;
  const profile = data.profiles[resolvedName];
  if (!profile) {
    throw new Error(`Unknown profile: ${resolvedName}`);
  }
  return { name: resolvedName, ...profile };
}

function getProfileModel(name: string | null = null): string {
  return resolveProfile(name).model;
}

function resolveProfileConfig(name: string | null = null): ResolvedProfileConfig {
  const data = loadProfilesFile();
  const resolvedName = name || data.defaultProfile;
  const profile = data.profiles[resolvedName];
  if (!profile) {
    throw new Error(`Unknown profile: ${resolvedName}`);
  }
  const primary = {
    model: profile.model,
    backend: profile.backend || 'claude',
    mode: profile.mode || null,
    provider: profile.provider || null,
    extraEnv: { ...(profile.extraEnv || {}) },
    extraOption: { ...(profile.extraOption || {}) },
    claudeBackend: resolveClaudeBackend(profile),
    thinking: profile.thinking || null,
  };
  const fallback = (profile.fallback || []).map(fb => ({
    model: fb.model,
    backend: fb.backend || primary.backend,
    mode: fb.mode || primary.mode,
    // provider does NOT inherit from primary — pi entries must each declare it explicitly (enforced
    // by validation), and non-pi entries leave it null.
    provider: fb.provider || null,
    extraEnv: { ...(fb.extraEnv || {}) },
    extraOption: { ...(fb.extraOption || {}) },
    claudeBackend: fb.claudeBackend !== undefined ? resolveClaudeBackend(fb) : primary.claudeBackend,
    // thinking does NOT inherit from primary (like provider) — value sets are backend-specific,
    // so each entry must declare its own; undeclared → nothing is passed.
    thinking: fb.thinking || null,
  }));
  return { name: resolvedName, ...primary, fallback };
}

export {
  loadProfilesFile,
  listProfiles,
  getDefaultProfileName,
  getProfile,
  resolveProfile,
  getProfileModel,
  resolveProfileConfig,
  validateProfilesFile,
};
// resolveClaudeBackend is already an `export function` above; named here for discoverability of the public surface.
