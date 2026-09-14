import type { RateLimitSource } from '@domain/costs/rate-limit-throttle.js';
import type { ProviderUsage, UsageStore } from '@domain/costs/usage-store.js';
import type { CodexQuotaReading } from '@core/codex-quota.js';

/** Signature of the throttle entry point. Always injected: which throttle a reading activates and
 *  which store it lands in are the host's decisions, and an adapter that defaulted to the daemon's
 *  singletons would let a trial write the real ones (D10). */
type SubmitRateLimit = (
  info: { rateLimitType: string; rateLimitLabel?: string; utilization: number; resetsAt: number },
  source: RateLimitSource,
) => Promise<void>;

type UsageWriter = Pick<UsageStore, 'update'>;

export interface CodexQuotaSinkDeps {
  submit: SubmitRateLimit;
  usageStore: UsageWriter;
  now?: () => number;
}

const DISPLAY_NAMES: Record<string, string> = {
  'openai-codex': 'OpenAI Codex',
};

/**
 * Resolve the two keys the dispatch gate looks a throttle up by. `configIsRateLimited` asks
 * `isProviderModeRateLimited(resolveRateLimitProvider(config), config.mode || 'api')`, so a reading
 * filed under any other pair would be recorded and then never consulted. The provider mirrors
 * `resolveRateLimitProvider` (profile provider, else the backend name); the mode is recovered from
 * the gateway sub-path `/m/<mode>/<provider>` that the engine spec derives from the profile's mode,
 * and its absence means the profile had no mode — which the gate reads as 'api'.
 */
export function resolveQuotaSource(
  route: { provider?: string | null; gatewayPath?: string | null },
): RateLimitSource {
  const provider = route.provider || 'pi';
  const mode = route.gatewayPath?.match(/\/m\/([^/]+)\//)?.[1] ?? 'api';
  return { provider, displayName: DISPLAY_NAMES[provider] ?? provider, mode };
}

function providerUsage(
  reading: CodexQuotaReading,
  source: RateLimitSource,
  observedAtMs: number,
): ProviderUsage {
  return {
    provider: source.provider,
    displayName: source.displayName,
    modes: source.mode ? [source.mode] : [],
    windows: reading.windows.map((window) => ({ ...window })),
    observedAt: Math.floor(observedAtMs / 1000),
    freshness: 'stale',
    // Quota windows only exist for plan-backed traffic, so this row is the provider's
    // subscription row — it must share a key with the one usage collection composes.
    billing: 'subscription',
  };
}

async function submitWindows(
  reading: CodexQuotaReading,
  source: RateLimitSource,
  submit: SubmitRateLimit,
): Promise<void> {
  for (const window of reading.windows) {
    await submit(
      {
        rateLimitType: window.type,
        ...(window.label ? { rateLimitLabel: window.label } : {}),
        utilization: window.utilization,
        resetsAt: window.resetsAt,
      },
      source,
    );
  }
}

/** Persist every observation while preserving the throttle's sequential submission behavior. */
export async function reportCodexQuota(
  reading: CodexQuotaReading,
  source: RateLimitSource,
  deps: CodexQuotaSinkDeps,
): Promise<void> {
  const persisted = deps.usageStore
    .update(providerUsage(reading, source, (deps.now ?? Date.now)()))
    .then(() => null, (error: unknown) => ({ error }));
  let submitError: unknown;
  try {
    await submitWindows(reading, source, deps.submit);
  } catch (error) {
    submitError = error;
  }
  const persistError = await persisted;
  if (submitError !== undefined) throw submitError;
  if (persistError) throw persistError.error;
}
