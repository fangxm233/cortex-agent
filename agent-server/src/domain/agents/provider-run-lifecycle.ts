// input:  provider config and the rate-limit throttle's view of each provider/mode
// output: provider identity, mode gating, and the synthetic rate-limited result
// pos:    Provider identity helpers shared by the run layer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { Backend } from '../../agent-adapter/index.js';
import type { AgentResult } from '@core/types/agent-types.js';
import { isProviderModeRateLimited } from '../costs/rate-limit-throttle.js';

interface ProviderConfig {
  backend: Backend;
  provider?: string | null;
  mode: string | null;
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
  return isProviderModeRateLimited(resolveRateLimitProvider(config), config.mode || 'api');
}

export function rateLimitedResult(mode: string, provider: string): AgentResult {
  return {
    sessionId: null, total_cost_usd: null, num_turns: null,
    rateLimited: true, rateLimitMessage: `Mode ${mode} is rate-limited`, rateLimitProvider: provider,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
  };
}
