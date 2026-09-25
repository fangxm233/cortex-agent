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
  /** PI model output cap written into the generated provider catalog. */
  maxOutputTokens?: number;
  fallback?: ProfileEntry[];
}

export interface ProfilesFile {
  defaultProfile: string;
  profiles: Record<string, ProfileEntry>;
  /** Which profile `!backend <name>` lands on, per backend. Optional: without it the first
   *  profile declared for that backend is used, which is the answer most homes want anyway. */
  defaultProfileByBackend?: Partial<Record<Backend, string>>;
}

export interface ResolvedProfile extends ProfileEntry {
  name: string;
}

/**
 * One entry in a run's attempt chain: everything that decides WHICH engine runs and how it is
 * configured, and nothing about what it is asked to do. A profile is its own first attempt (see
 * {@link ResolvedProfileConfig}), and each declared fallback is another one.
 */
export interface RunAttemptConfig {
  model: string;
  backend: Backend;
  mode: string | null;
  /** Opaque rate-limit provider identity; for PI it is also the required request protocol. */
  provider: string | null;
  extraEnv: Record<string, string>;
  extraOption: Record<string, string>;
  /** Resolved Claude adapter mode. Only 'print' runs: the TUI runtime was retired (D9), so a
   *  profile still configured `'tui'` is accepted, warned about once by `ClaudeAdapter.open`, and
   *  run on the print path. Kept on the type because it is still a field of profiles.json and of
   *  the Web profile editor; nothing downstream branches on it any more. */
  claudeBackend: 'print' | 'tui';
  /** Thinking level (backend-native value). null → nothing is passed to the CLI. */
  thinking: string | null;
  maxOutputTokens?: number | null;
}

/** A named profile, resolved: its own engine selection plus the chain it falls back through. */
export interface ResolvedProfileConfig extends RunAttemptConfig {
  name: string;
  fallback: RunAttemptConfig[];
}

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MODE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// provider shares mode's safe-name shape (alphanumeric, dash, underscore).
const PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const VALID_BACKENDS: ReadonlySet<string> = new Set(['claude', 'pi']);
/** The one table of legal thinking levels per backend. Exported so the selection path (a composer
 *  picking a level for a session) and the Web catalog validate against the SAME set the profile
 *  validator enforces — two tables would drift the moment a backend gained a level. Ordered
 *  low → high because the UI renders them in this order. */
export const THINKING_LEVELS_BY_BACKEND: Record<Backend, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};

const THINKING_LEVEL_SETS: Record<Backend, Set<string>> = {
  claude: new Set(THINKING_LEVELS_BY_BACKEND.claude),
  pi: new Set(THINKING_LEVELS_BY_BACKEND.pi),
};

/** Is `level` a value this backend accepts? The selection path's gate, the profile validator's
 *  rule — one predicate. */
export function isValidThinkingLevel(backend: Backend, level: string): boolean {
  return THINKING_LEVEL_SETS[backend]?.has(level) ?? false;
}

/** The profiles object whose validation already passed. `profileRepo` caches the PARSE; the
 *  validation was left to run again on every call, and every caller of this module goes through
 *  here — a 300-session `sessions.list` revalidated the whole file 300 times per request. */
let validatedProfiles: ProfilesFile | null = null;

/**
 * Identity, not a revision counter, is what makes this safe: every path that can change the
 * profiles — `save`, `mutate`, and the hot-reload watcher's `invalidate` + `readSync` — installs a
 * NEW object, so a stale verdict cannot outlive a change. A file that fails validation is never
 * recorded, so it keeps throwing until it is fixed.
 */
function loadProfilesFile(): ProfilesFile {
  try {
    const data = profileRepo.readSync();
    if (data !== validatedProfiles) {
      validateProfilesFile(data);
      validatedProfiles = data;
    }
    return data;
  } catch (error) {
    throw new Error(`Failed to load profiles.json: ${(error as Error).message}`);
  }
}

function validateMaxOutputTokens(
  value: unknown,
  backend: Backend,
  label: string,
): void {
  if (value === undefined) return;
  if (backend !== 'pi' || !Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} has invalid maxOutputTokens for backend '${backend}'`);
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
    if (typeof p.thinking !== 'string' || !isValidThinkingLevel(effectiveBackend, p.thinking)) {
      throw new Error(`${label} has invalid thinking: ${String(p.thinking)} (backend '${effectiveBackend}' expects one of: ${levels.join(', ')})`);
    }
  }
  validateMaxOutputTokens(p.maxOutputTokens, effectiveBackend, label);
}

/**
 * Pure resolver: maps a ProfileEntry's claudeBackend field to one of the two accepted values.
 * Defaults to 'print' for any non-'tui' value (including a missing field). Since D9 retired the
 * TUI runtime this only decides whether the adapter emits its one deprecation warning — both
 * values run the print path.
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
  const byBackend = d.defaultProfileByBackend;
  if (byBackend !== undefined) {
    if (!byBackend || typeof byBackend !== 'object' || Array.isArray(byBackend)) {
      throw new Error('defaultProfileByBackend must be an object');
    }
    for (const [backend, name] of Object.entries(byBackend as Record<string, unknown>)) {
      if (!VALID_BACKENDS.has(backend)) {
        throw new Error(`defaultProfileByBackend has unknown backend: ${backend}`);
      }
      if (typeof name !== 'string' || !profs[name]) {
        throw new Error(`defaultProfileByBackend.${backend} = "${String(name)}" is missing from profiles`);
      }
    }
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

/**
 * The profile `!backend <name>` switches a channel to.
 *
 * `defaultProfileByBackend` wins when it names one; otherwise the FIRST profile declared for that
 * backend, because declaration order in profiles.json is the only preference signal a user has
 * already expressed. Returns null when the home has no profile on that backend at all — the caller
 * must say so rather than silently switching to something else.
 */
export function getDefaultProfileForBackend(backend: Backend): string | null {
  let file: ProfilesFile;
  try { file = loadProfilesFile(); } catch { return null; }
  const declared = file.defaultProfileByBackend?.[backend];
  if (declared && file.profiles[declared]) return declared;
  for (const [name, profile] of Object.entries(file.profiles)) {
    if ((profile.backend ?? 'claude') === backend) return name;
  }
  return null;
}

/**
 * The first profile declared for a (backend, provider) pair, if the home has one.
 *
 * Used when a selection moves to a provider the current profile does not use: that provider's own
 * profile already states the gateway route (and the rest of the routing) the user configured for
 * it, so borrowing from it beats guessing. Declaration order decides among several, the same
 * preference signal `getDefaultProfileForBackend` reads.
 */
export function findProfileForProvider(backend: Backend, provider: string): ResolvedProfile | null {
  let file: ProfilesFile;
  try { file = loadProfilesFile(); } catch { return null; }
  for (const [name, profile] of Object.entries(file.profiles)) {
    if ((profile.backend ?? 'claude') !== backend) continue;
    if ((profile.provider ?? null) !== provider) continue;
    return { name, ...profile };
  }
  return null;
}

/**
 * The gateway route a selection on `provider` should run under.
 *
 * A profile already using that provider is authoritative; without one, `cortex init` names each PI
 * endpoint after its provider (`mode = endpoint = provider`, see core/gateway-generator.ts), so the
 * provider name is the route the generated gateway.yaml holds.
 */
export function resolveModeForProvider(backend: Backend, provider: string): string {
  return findProfileForProvider(backend, provider)?.mode || provider;
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
    maxOutputTokens: profile.maxOutputTokens ?? null,
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
    maxOutputTokens: fb.maxOutputTokens ?? null,
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
