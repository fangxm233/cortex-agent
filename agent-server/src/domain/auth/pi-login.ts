// input:  PI runtime loader, AuthInteraction, discovery, auth events
// output: PI api-key login result and LoginFlow consumer
// pos:    PI api-key login adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import { publishAuthRecovered } from './auth-events.js';
import type { AuthInteraction, LoginFlowConsumer } from './login-flow.js';
import {
  loadPiRuntime,
  type PiModelRuntime,
  type PiProvider,
  type PiRuntimeLoadResult,
} from './pi-runtime.js';

export type PiApiKeyLoginErrorCode =
  | 'runtime_unavailable'
  | 'provider_not_found'
  | 'api_key_login_unsupported'
  | 'login_failed';

export interface PiApiKeyLoginError {
  code: PiApiKeyLoginErrorCode;
  message: string;
}

export type PiApiKeyLoginResult =
  | {
    ok: true;
    provider: string;
    authType: 'api_key';
    expiresAt: null;
  }
  | {
    ok: false;
    provider: string;
    authType: 'api_key';
    error: PiApiKeyLoginError;
  };

type PiApiKeyLoginFailure = Extract<PiApiKeyLoginResult, { ok: false }>;

export interface PiApiKeyLoginDependencies {
  loadRuntime?: () => Promise<PiRuntimeLoadResult>;
  refreshProviders?: () => void;
  publishRecovered?: (input: { backend: 'pi'; provider: string }) => void;
}

export class PiApiKeyLoginFlowError extends Error {
  readonly name = 'PiApiKeyLoginFlowError';

  constructor(readonly result: PiApiKeyLoginFailure) {
    super(result.error.message);
  }
}

function failed(
  provider: string,
  code: PiApiKeyLoginErrorCode,
  message: string,
): PiApiKeyLoginFailure {
  return { ok: false, provider, authType: 'api_key', error: { code, message } };
}

async function loadRuntime(
  dependencies: PiApiKeyLoginDependencies,
): Promise<PiRuntimeLoadResult | null> {
  try {
    return await (dependencies.loadRuntime ?? loadPiRuntime)();
  } catch {
    return null;
  }
}

function supportsApiKeyLogin(provider: PiProvider): boolean {
  return typeof provider.auth.apiKey?.login === 'function';
}

function finishLogin(provider: string, dependencies: PiApiKeyLoginDependencies): PiApiKeyLoginResult {
  (dependencies.refreshProviders ?? (() => piProviderDiscovery.refresh()))();
  (dependencies.publishRecovered ?? publishAuthRecovered)({ backend: 'pi', provider });
  return { ok: true, provider, authType: 'api_key', expiresAt: null };
}

type LoginTarget =
  | { runtime: PiModelRuntime }
  | { failure: PiApiKeyLoginFailure };

function resolveTarget(result: PiRuntimeLoadResult | null, providerId: string): LoginTarget {
  if (!result?.available) {
    return { failure: failed(providerId, 'runtime_unavailable', 'PI runtime is unavailable.') };
  }
  const provider = result.runtime.getProviders().find(candidate => candidate.id === providerId);
  if (!provider) {
    return { failure: failed(providerId, 'provider_not_found', 'PI provider was not found.') };
  }
  if (!supportsApiKeyLogin(provider)) {
    const message = 'PI provider does not support API-key login.';
    return { failure: failed(providerId, 'api_key_login_unsupported', message) };
  }
  return { runtime: result.runtime };
}

export async function loginPiApiKey(
  providerId: string,
  interaction: AuthInteraction,
  dependencies: PiApiKeyLoginDependencies = {},
): Promise<PiApiKeyLoginResult> {
  const target = resolveTarget(await loadRuntime(dependencies), providerId);
  if ('failure' in target) return target.failure;
  try {
    await target.runtime.login(providerId, 'api_key', interaction);
  } catch {
    return failed(providerId, 'login_failed', 'PI API-key login failed.');
  }
  return finishLogin(providerId, dependencies);
}

export function createPiApiKeyLoginConsumer(
  providerId: string,
  dependencies: PiApiKeyLoginDependencies = {},
): LoginFlowConsumer {
  return async (interaction) => {
    const result = await loginPiApiKey(providerId, interaction, dependencies);
    if (result.ok === false) throw new PiApiKeyLoginFlowError(result);
    return result;
  };
}
