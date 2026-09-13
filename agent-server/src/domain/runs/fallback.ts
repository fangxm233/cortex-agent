// input:  a resolved profile and the throttle's current view of each provider/mode
// output: the ordered attempt chain for one run, and the gate that skips a blocked attempt
// pos:    Run layer — what a run tries, in what order, and when it does not bother trying
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// A run is not one call to a backend: a profile may name fallbacks, and each attempt can be
// skipped before it spawns (its provider/mode is already rate-limited) or retired after it
// returns (rate-limited result, transient error). This module owns that sequence and nothing
// else — no events, no notices, no process. `AgentRun` walks the plan; `notices.ts` narrates it.

import { isThrottled } from '../costs/rate-limit-throttle.js';
import { resolveProfileConfig } from '../agents/profile-manager.js';
import type { ResolvedProfileConfig, RunAttemptConfig } from '../agents/profile-manager.js';
import { configIsRateLimited, resolveRateLimitProvider } from '../agents/provider-run-lifecycle.js';

export { configIsRateLimited, rateLimitedResult, resolveRateLimitProvider } from '../agents/provider-run-lifecycle.js';
export { isRetryableError, isRetryableResult } from '../agents/config.js';

/**
 * The attempts a run may make, in order: the profile itself, then its declared fallbacks.
 *
 * The head is the profile's own engine selection with `name`/`fallback` dropped — a profile IS its
 * first attempt, which is why `ResolvedProfileConfig` extends {@link RunAttemptConfig}. Building
 * the list here (rather than at each caller) is what makes "attempt index" a meaningful number.
 */
export function planAttempts(profile: ResolvedProfileConfig): RunAttemptConfig[] {
  const head: RunAttemptConfig = {
    model: profile.model,
    backend: profile.backend,
    mode: profile.mode,
    provider: profile.provider,
    extraEnv: profile.extraEnv,
    extraOption: profile.extraOption,
    claudeBackend: profile.claudeBackend,
    thinking: profile.thinking,
    maxOutputTokens: profile.maxOutputTokens,
  };
  return [head, ...(profile.fallback ?? [])];
}

/** How an attempt is named in logs and in the fallback notice the user reads. Takes only the two
 *  fields it prints so a caller holding a partial config can still label it. */
export function attemptLabel(attempt: Pick<RunAttemptConfig, 'model' | 'mode'>): string {
  return `${attempt.model}/${attempt.mode || 'default'}`;
}

/**
 * True when every attempt in the profile's chain is currently rate-limited, so a job runner can
 * decline to claim work instead of spawning a backend that will only come back 429.
 * Cheap-exits on the global throttle flag: with nothing throttled there is nothing to check.
 */
export function allConfigsRateLimited(profileName: string | null): boolean {
  if (!isThrottled()) return false;
  try {
    return planAttempts(resolveProfileConfig(profileName)).every(configIsRateLimited);
  } catch {
    return false;
  }
}

/**
 * Whether this attempt should be skipped without spawning. A user-initiated run always spawns:
 * the person is waiting, and a stale throttle entry must not silently swallow their turn.
 */
export function shouldSkipAttempt(
  attempt: Parameters<typeof configIsRateLimited>[0],
  opts: { isUserInitiated?: boolean },
): boolean {
  return configIsRateLimited(attempt) && !opts.isUserInitiated;
}

/** The provider an attempt's rate-limit windows and cost rows are attributed to. */
export function attemptProvider(attempt: Parameters<typeof resolveRateLimitProvider>[0]): string {
  return resolveRateLimitProvider(attempt);
}
