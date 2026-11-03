// Provider and credential attribution for the run's single engine selection.
import type { EngineSelection } from '../agents/engine-selection.js';
import { configIsRateLimited, resolveRateLimitProvider } from '../agents/provider-run-lifecycle.js';
import { findAccount, routeName, SUBSCRIPTION_CONNECTION } from '../connections/index.js';

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
  selection: Pick<EngineSelection, 'backend' | 'provider' | 'connection'>,
): 'oauth' | 'api_key' | null {
  if (selection.backend !== 'claude') return null;
  const route = routeName(selection);
  return route === SUBSCRIPTION_CONNECTION || attemptAccount(selection) ? 'oauth' : 'api_key';
}

/** The account a selection runs on; null for a provider's default login. */
export function attemptAccount(selection: Pick<EngineSelection, 'backend' | 'provider' | 'connection'>): string | null {
  const route = routeName(selection);
  return findAccount({ backend: selection.backend, id: route }) ? route : null;
}

export function attemptProviderOrNull(selection: EngineSelection): string | null {
  return selection.model ? resolveRateLimitProvider(selection) : null;
}
