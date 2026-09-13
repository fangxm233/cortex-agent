// input:  agent handles, provider config, auth events
// output: provider identity, gating, and lifecycle wrappers
// pos:    Provider-attributed run lifecycle helpers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { Backend } from '../../agent-adapter/index.js';
import type { AgentHandle, AgentResult } from '@core/types/agent-types.js';
import { classifyAuthError, publishAuthRecovered, publishAuthRequired } from '../auth/auth-events.js';
import { isProviderModeRateLimited } from '../costs/rate-limit-throttle.js';
import { isRetryableError } from './config.js';

interface ProviderConfig {
  backend: Backend;
  provider?: string | null;
  mode: string | null;
}

interface AuthRunOptions {
  channel?: string;
  trackSessionId?: string | null;
  sessionId?: string | null;
}

const DEFAULT_PROVIDER_BY_BACKEND: Partial<Record<Backend, string>> = {
  claude: 'anthropic',
};

export function resolveRateLimitProvider(
  config: Pick<ProviderConfig, 'backend' | 'provider'>,
): string {
  return config.provider || DEFAULT_PROVIDER_BY_BACKEND[config.backend] || config.backend;
}

/** Generic over the handle shape so a caller's own fields (the engine session an attempt owns)
 *  survive the wrapper: these helpers decorate a run, they do not redefine it. */
export function withRateLimitProvider<T extends AgentHandle>(handle: T, provider: string): T {
  return {
    ...handle,
    promise: handle.promise.then(
      (result) => ({ ...result, rateLimitProvider: result.rateLimitProvider || provider }),
      (error) => {
        if (isRetryableError(error as Error)) {
          (error as Error & { rateLimitProvider?: string }).rateLimitProvider ??= provider;
        }
        throw error;
      },
    ),
  } as T;
}

export function withAuthLifecycle<T extends AgentHandle>(
  handle: T,
  options: AuthRunOptions,
  config: ProviderConfig,
): T {
  const identity = { backend: config.backend, provider: resolveRateLimitProvider(config) };
  return {
    ...handle,
    promise: handle.promise.then(
      (result) => {
        if (!result.rateLimited) publishAuthRecovered(identity);
        return result;
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const kind = classifyAuthError(message);
        if (kind) {
          publishAuthRequired({
            ...identity, authType: null, kind,
            channel: options.channel ?? null,
            sessionId: options.trackSessionId ?? options.sessionId ?? handle.sessionId ?? null,
          });
        }
        throw error;
      },
    ),
  } as T;
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
