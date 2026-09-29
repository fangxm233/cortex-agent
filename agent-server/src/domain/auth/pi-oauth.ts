import { t } from '@core/i18n.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  LoginFlowError,
  type AuthInteraction,
  type LoginFlowConsumer,
} from './login-flow.js';
import {
  loadPiRuntime,
  type PiCredential,
  type PiModelRuntime,
  type PiProvider,
  type PiRuntimeLoadResult,
} from './pi-runtime.js';

export type PiOAuthLoginErrorCode =
  | 'runtime_unavailable'
  | 'provider_not_found'
  | 'oauth_unsupported'
  | 'login_failed';

export interface PiOAuthLoginError {
  code: PiOAuthLoginErrorCode;
  message: string;
}

export type PiOAuthLoginResult =
  | {
    ok: true;
    provider: string;
    authType: 'oauth';
    expiresAt: string | null;
  }
  | {
    ok: false;
    provider: string;
    authType: 'oauth';
    error: PiOAuthLoginError;
  };

type PiOAuthLoginFailure = Extract<PiOAuthLoginResult, { ok: false }>;

export interface PiOAuthLoginDependencies {
  loadRuntime?: () => Promise<PiRuntimeLoadResult>;
  refreshProviders?: () => void;
}

function failed(
  provider: string,
  code: PiOAuthLoginErrorCode,
  message: string,
): PiOAuthLoginFailure {
  return { ok: false, provider, authType: 'oauth', error: { code, message } };
}

async function loadRuntime(
  dependencies: PiOAuthLoginDependencies,
): Promise<PiRuntimeLoadResult | null> {
  try {
    return await (dependencies.loadRuntime ?? loadPiRuntime)();
  } catch {
    return null;
  }
}

function supportsOAuthLogin(provider: PiProvider): boolean {
  return typeof provider.auth?.oauth?.login === 'function';
}

function credentialExpiresAt(credential: PiCredential): string | null {
  if (credential.type !== 'oauth' || !Number.isFinite(credential.expires)) return null;
  const expiresAt = new Date(credential.expires);
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt.toISOString();
}

function finishLogin(
  provider: string,
  expiresAt: string | null,
  dependencies: PiOAuthLoginDependencies,
): PiOAuthLoginResult {
  (dependencies.refreshProviders ?? (() => piProviderDiscovery.refresh()))();
  publishAuthRecovered({ backend: 'pi', provider });
  return { ok: true, provider, authType: 'oauth', expiresAt };
}

type LoginTarget =
  | { runtime: PiModelRuntime }
  | { failure: PiOAuthLoginFailure };

function resolveTarget(result: PiRuntimeLoadResult | null, providerId: string): LoginTarget {
  if (!result?.available) {
    return { failure: failed(providerId, 'runtime_unavailable', t('ux.auth.piRuntimeUnavailable')) };
  }
  const provider = result.runtime.getProviders().find(candidate => candidate.id === providerId);
  if (!provider) {
    return { failure: failed(providerId, 'provider_not_found', t('ux.auth.piProviderNotFound')) };
  }
  if (!supportsOAuthLogin(provider)) {
    const message = t('ux.auth.piOAuthUnsupported');
    return { failure: failed(providerId, 'oauth_unsupported', message) };
  }
  return { runtime: result.runtime };
}

export async function loginPiOAuth(
  providerId: string,
  interaction: AuthInteraction,
  dependencies: PiOAuthLoginDependencies = {},
): Promise<PiOAuthLoginResult> {
  let target: LoginTarget;
  try {
    target = resolveTarget(await loadRuntime(dependencies), providerId);
  } catch {
    return failed(providerId, 'login_failed', t('ux.auth.piOAuthFailed'));
  }
  if ('failure' in target) return target.failure;
  try {
    const credential = await target.runtime.login(providerId, 'oauth', interaction);
    return finishLogin(providerId, credentialExpiresAt(credential), dependencies);
  } catch {
    return failed(providerId, 'login_failed', t('ux.auth.piOAuthFailed'));
  }
}

export function createPiOAuthLoginConsumer(
  providerId: string,
  dependencies: PiOAuthLoginDependencies = {},
): LoginFlowConsumer {
  return async (interaction) => {
    const result = await loginPiOAuth(providerId, interaction, dependencies);
    if (result.ok === false) throw new LoginFlowError(result.error.code, result.error.message);
    return {
      provider: result.provider,
      authType: result.authType,
      expiresAt: result.expiresAt,
    };
  };
}
