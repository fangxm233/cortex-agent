// input:  a channel, an optional session record, an optional explicit profile name, an attempt
// output: the profile a run should use, its name, its channel model override, and its mode route
// pos:    domain/runs — the one place a run's configuration is decided (D5)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { getActiveProfile, getChannelModelOverride, resolveModeEnv, type ModeEnv } from '../agents/config.js';
import {
  getDefaultProfileName, resolveProfileConfig,
  type ResolvedProfileConfig, type RunAttemptConfig,
} from '../agents/profile-manager.js';

export interface RunConfigQuery {
  /** Conduit the run belongs to. Absent for runs with no channel (a scheduled job's first turn). */
  channel?: string | null;
  /** The Cortex session this run continues, when the caller has its record. Its recorded profile
   *  beats the channel's: a session keeps the profile it was started under even if the channel
   *  has since moved on. */
  session?: { profileName?: string | null } | null;
  /** A profile the caller was handed explicitly — a thread agent's `profile`, a step's override.
   *  Highest priority, and deliberately NOT validated here: an unknown name must reach the run so
   *  the run rejects it, after the execution record exists. */
  override?: string | null;
}

export interface ResolvedRunConfig {
  /** The name that won the priority chain, whether or not it names a real profile. */
  profileName: string;
  /** Always usable. Synthetic when `resolved` is false — see `resolved`. */
  profile: ResolvedProfileConfig;
  /** `!model` for this channel, to be layered on top of `profile.model`. null is the normal case. */
  modelOverride: string | null;
  /** False when `profileName` names no profile in profiles.json. The caller still gets a profile
   *  so it can open an execution record with a truthful backend, and still has the bad name to
   *  fail on. Callers that simply want to run should treat false as an error. */
  resolved: boolean;
}

const FALLBACK_BACKEND = 'claude' as const;
const FALLBACK_MODE = 'plan';

/**
 * The profile name for a run, by D5's priority: explicit override → the session's recorded
 * profile → the channel's profile → the global active profile → profiles.defaultProfile.
 *
 * `getActiveProfile(channel)` already folds the middle two together (and resolves init's
 * `'__active__'` placeholder), so only the ends are added here.
 */
export function resolveProfileName(query: RunConfigQuery = {}): string {
  return query.override
    || query.session?.profileName
    || getActiveProfile(query.channel ?? undefined)
    || getDefaultProfileName();
}

/** A profile shaped like the requested one but carrying no configuration: it keeps the name so the
 *  run still rejects it, and borrows a backend/mode so the execution record is not a lie. Replaces
 *  three byte-identical copies that each hard-coded the retired global backend. */
function syntheticProfile(
  profileName: string, backend: ResolvedProfileConfig['backend'], mode: string | null,
): ResolvedProfileConfig {
  return {
    name: profileName,
    model: '',
    backend,
    mode,
    provider: null,
    extraEnv: {},
    extraOption: {},
    claudeBackend: 'print',
    thinking: null,
    maxOutputTokens: null,
    fallback: [],
  };
}

/**
 * What an unknown profile name borrows: the profile the channel would have used had the caller not
 * named one. Before D5 this was the stored global backend; with backend living on the profile, the
 * channel's own chain is the nearest honest answer, and it agrees with the old one whenever the
 * global backend matched the channel's profile — which is the only case where it was ever right.
 */
function borrowedIdentity(query: RunConfigQuery): { backend: ResolvedProfileConfig['backend']; mode: string | null } {
  const name = resolveProfileName({ channel: query.channel, session: query.session });
  try {
    const profile = resolveProfileConfig(name);
    return { backend: profile.backend, mode: profile.mode };
  } catch {
    return { backend: FALLBACK_BACKEND, mode: FALLBACK_MODE };
  }
}

/**
 * Resolve everything a run needs to know about its configuration, in one place.
 *
 * Backend, model, provider, mode, thinking and the fallback chain come from the profile and only
 * from the profile (D5). The single exception is the channel's `!model` override, returned
 * separately rather than folded in so a caller can tell "the profile says X" from "this channel
 * was told to use Y" — the run applies it, the display distinguishes them.
 */
export function resolveRunConfig(query: RunConfigQuery = {}): ResolvedRunConfig {
  const profileName = resolveProfileName(query);
  const modelOverride = getChannelModelOverride(query.channel);
  try {
    return { profileName, profile: resolveProfileConfig(profileName), modelOverride, resolved: true };
  } catch {
    const { backend, mode } = borrowedIdentity(query);
    return {
      profileName,
      profile: syntheticProfile(profileName, backend, mode),
      modelOverride,
      resolved: false,
    };
  }
}

/**
 * The Anthropic route (base URL + credentials) one attempt runs under. Per attempt, because a
 * fallback may be a different mode entirely, and per run because the project/trigger it carries
 * select the gateway's account: resolving this never writes a daemon global (K-053), the value
 * reaches exactly the one child env it was resolved for.
 */
export function resolveRunRoute(
  attempt: { mode?: RunAttemptConfig['mode'] },
  context: { project?: string | null; trigger?: string | null } = {},
): ModeEnv {
  const metadata: Record<string, string> = {};
  if (context.project) metadata.project = context.project;
  if (context.trigger) metadata.trigger = context.trigger;
  return resolveModeEnv(
    attempt.mode || 'api', Object.keys(metadata).length > 0 ? metadata : undefined,
  );
}

/** The backend a channel's next run will use. Replaces `getActiveBackend()` on the run path. */
export function resolveRunBackend(query: RunConfigQuery = {}): ResolvedProfileConfig['backend'] {
  return resolveRunConfig(query).profile.backend;
}

/**
 * The profile a run actually executes: the resolved profile with the channel's `!model` override
 * applied to its primary model.
 *
 * The fallback chain is deliberately untouched. It is the profile's stated recovery path for when
 * the primary model is unavailable, not a second model choice the user made — overriding it too
 * would mean a `!model` on a rate-limited channel silently disabled the profile's own escape.
 */
export function effectiveProfile(config: ResolvedRunConfig): ResolvedProfileConfig {
  if (!config.modelOverride) return config.profile;
  return { ...config.profile, model: config.modelOverride };
}
