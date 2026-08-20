// input:  spawn config, Codex quota readings, usage store, and throttle
// output: resolveQuotaSource and durable labeled reportCodexQuota
// pos:    Persists PI quota under routed provider keys and feeds throttle
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { handleRateLimitEvent, type RateLimitSource } from '@domain/costs/rate-limit-throttle.js';
import { usageStore, type ProviderUsage, type UsageStore } from '@domain/costs/usage-store.js';
import type { CodexQuotaReading } from '@domain/costs/codex-quota.js';
import type { AgentSpawnConfig } from '../types.js';

/** Signature of the throttle entry point; injected in tests, defaulted to the real one. */
type SubmitRateLimit = (
  info: { rateLimitType: string; rateLimitLabel?: string; utilization: number; resetsAt: number },
  source: RateLimitSource,
) => Promise<void>;

type UsageWriter = Pick<UsageStore, 'update'>;

export interface CodexQuotaSinkDeps {
  submit?: SubmitRateLimit;
  usageStore?: UsageWriter;
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
 * the gateway sub-path `/m/<mode>/<provider>` that spawn-config derives from the profile's mode,
 * and its absence means the profile had no mode — which the gate reads as 'api'.
 */
export function resolveQuotaSource(
  config: Pick<AgentSpawnConfig, 'piProvider' | 'piGatewayPath'>,
): RateLimitSource {
  const provider = config.piProvider || 'pi';
  const mode = config.piGatewayPath?.match(/\/m\/([^/]+)\//)?.[1] ?? 'api';
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
  deps: CodexQuotaSinkDeps = {},
): Promise<void> {
  const persisted = (deps.usageStore ?? usageStore)
    .update(providerUsage(reading, source, (deps.now ?? Date.now)()))
    .then(() => null, (error: unknown) => ({ error }));
  let submitError: unknown;
  try {
    await submitWindows(reading, source, deps.submit ?? handleRateLimitEvent);
  } catch (error) {
    submitError = error;
  }
  const persistError = await persisted;
  if (submitError !== undefined) throw submitError;
  if (persistError) throw persistError.error;
}
