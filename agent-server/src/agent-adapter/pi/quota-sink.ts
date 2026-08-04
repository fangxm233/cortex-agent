// input:  spawn config, codex quota readings, the rate-limit throttle
// output: resolveQuotaSource and reportCodexQuota
// pos:    Feeds PI provider quota readings into the throttle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { handleRateLimitEvent, type RateLimitSource } from '@domain/costs/rate-limit-throttle.js';
import type { CodexQuotaReading } from '@domain/costs/codex-quota.js';
import type { AgentSpawnConfig } from '../types.js';

/** Signature of the throttle entry point; injected in tests, defaulted to the real one. */
type SubmitRateLimit = (
  info: { rateLimitType: string; utilization: number; resetsAt: number },
  source: RateLimitSource,
) => Promise<void>;

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

/**
 * File each advertised window as its own throttle event. The throttle owns the thresholds and
 * decides whether a window is worth pausing for, so every window is submitted as observed —
 * including the ones far below the line, which keep the recorded reset time fresh.
 */
export async function reportCodexQuota(
  reading: CodexQuotaReading,
  source: RateLimitSource,
  submit: SubmitRateLimit = handleRateLimitEvent,
): Promise<void> {
  for (const window of reading.windows) {
    await submit(
      { rateLimitType: window.type, utilization: window.utilization, resetsAt: window.resetsAt },
      source,
    );
  }
}
