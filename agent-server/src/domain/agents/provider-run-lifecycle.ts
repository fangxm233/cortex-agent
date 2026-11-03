import type { Backend } from '../../agent-adapter/types.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { isProviderModeRateLimited } from '../costs/rate-limit-throttle.js';
import { routeName } from '../connections/index.js';

interface ProviderConfig {
  backend: Backend;
  provider?: string | null;
  connection: string | null;
  /** Decides which Claude connection a selection naming none runs on. */
  model?: string;
}

const DEFAULT_PROVIDER_BY_BACKEND: Partial<Record<Backend, string>> = {
  claude: 'anthropic',
};

export function resolveRateLimitProvider(
  config: Pick<ProviderConfig, 'backend' | 'provider'>,
): string {
  return config.provider || DEFAULT_PROVIDER_BY_BACKEND[config.backend] || config.backend;
}

export function configIsRateLimited(config: ProviderConfig): boolean {
  const route = routeName({ ...config, provider: config.provider ?? null });
  return isProviderModeRateLimited(resolveRateLimitProvider(config), route);
}

export function rateLimitedResult(route: string, provider: string): AgentResult {
  return {
    sessionId: null, total_cost_usd: null, num_turns: null,
    rateLimited: true, rateLimitMessage: `Connection ${route} is rate-limited`, rateLimitProvider: provider,
    rateLimitRoute: route,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
  };
}
