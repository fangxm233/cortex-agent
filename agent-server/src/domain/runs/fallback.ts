// Provider and credential attribution for the run's single engine selection.
import type { EngineSelection } from '../agents/engine-selection.js';
import { configIsRateLimited, resolveRateLimitProvider } from '../agents/provider-run-lifecycle.js';

export { configIsRateLimited, rateLimitedResult, resolveRateLimitProvider } from '../agents/provider-run-lifecycle.js';
export { isRetryableError, isRetryableResult } from './retryable-errors.js';

/** A person waiting on a run bypasses cached throttle state. */
export function shouldSkipAttempt(
  selection: Parameters<typeof configIsRateLimited>[0],
  opts: { isUserInitiated?: boolean },
): boolean {
  return configIsRateLimited(selection) && !opts.isUserInitiated;
}

export function attemptProvider(selection: Parameters<typeof resolveRateLimitProvider>[0]): string {
  return resolveRateLimitProvider(selection);
}

export function attemptAuthType(
  selection: Pick<EngineSelection, 'backend' | 'mode'>,
): 'oauth' | 'api_key' | null {
  if (selection.backend !== 'claude') return null;
  return selection.mode === 'api' ? 'api_key' : 'oauth';
}

export function attemptProviderOrNull(selection: EngineSelection): string | null {
  return selection.model ? resolveRateLimitProvider(selection) : null;
}
