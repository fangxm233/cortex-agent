import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  LoginFlowError,
  failureWithDetail,
  type AuthInteraction,
  type LoginFlowConsumer,
} from './login-flow.js';
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
  /** The upstream error, for the server log only. */
  cause?: unknown;
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

const log = createLogger('pi-login');

export interface PiApiKeyLoginDependencies {
  loadRuntime?: () => Promise<PiRuntimeLoadResult>;
  refreshProviders?: () => void;
}

function failed(
  provider: string,
  code: PiApiKeyLoginErrorCode,
  message: string,
  cause?: unknown,
): PiApiKeyLoginFailure {
  const error = cause === undefined ? { code, message } : { code, message, cause };
  return { ok: false, provider, authType: 'api_key', error };
}

async function loadRuntime(
  dependencies: PiApiKeyLoginDependencies,
): Promise<PiRuntimeLoadResult | null> {
  try {
    return await (dependencies.loadRuntime ?? loadPiRuntime)();
  } catch (error) {
    log.warn('PI runtime failed to load:', error);
    return null;
  }
}

function supportsApiKeyLogin(provider: PiProvider): boolean {
  return typeof provider.auth.apiKey?.login === 'function';
}

function finishLogin(provider: string, dependencies: PiApiKeyLoginDependencies): PiApiKeyLoginResult {
  (dependencies.refreshProviders ?? (() => piProviderDiscovery.refresh()))();
  publishAuthRecovered({ backend: 'pi', provider });
  return { ok: true, provider, authType: 'api_key', expiresAt: null };
}

type LoginTarget =
  | { runtime: PiModelRuntime; label: string }
  | { failure: PiApiKeyLoginFailure };

function resolveTarget(result: PiRuntimeLoadResult | null, providerId: string): LoginTarget {
  if (!result?.available) {
    const message = failureWithDetail(t('ux.auth.piRuntimeUnavailable'), result?.error);
    return { failure: failed(providerId, 'runtime_unavailable', message) };
  }
  const provider = result.runtime.getProviders().find(candidate => candidate.id === providerId);
  if (!provider) {
    return { failure: failed(providerId, 'provider_not_found', t('ux.auth.piProviderNotFound')) };
  }
  const label = provider.name || providerId;
  if (!supportsApiKeyLogin(provider)) {
    const message = t('ux.auth.piApiKeyUnsupported', { provider: label });
    return { failure: failed(providerId, 'api_key_login_unsupported', message) };
  }
  return { runtime: result.runtime, label };
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
  } catch (error) {
    const message = failureWithDetail(t('ux.auth.piApiKeyFailed', { provider: target.label }), error);
    return failed(providerId, 'login_failed', message, error);
  }
  return finishLogin(providerId, dependencies);
}

export function createPiApiKeyLoginConsumer(
  providerId: string,
  dependencies: PiApiKeyLoginDependencies = {},
): LoginFlowConsumer {
  return async (interaction) => {
    const result = await loginPiApiKey(providerId, interaction, dependencies);
    if (result.ok === false) {
      throw new LoginFlowError(result.error.code, result.error.message, result.error.cause);
    }
    return {
      provider: result.provider,
      authType: result.authType,
      expiresAt: result.expiresAt,
    };
  };
}
