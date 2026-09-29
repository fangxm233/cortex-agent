import { t } from '@core/i18n.js';
import { piUserAuthPath } from '@core/pi-sdk.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import {
  applyAuthEnv,
  getSavedApiEnv,
  removeAnthropicApiKey,
  removeClaudeCodeOAuthToken,
} from '../agents/config.js';
import { logoutClaudeAuth } from './cc-auth-cli.js';
import {
  getAuthStatus,
  type AuthCredentialStatus,
  type AuthStatusSnapshot,
  type AuthType,
  type GetAuthStatusOptions,
} from './auth-status.js';
import {
  loadPiRuntime,
  type LoadPiRuntimeOptions,
  type PiRuntimeLoadResult,
} from './pi-runtime.js';

export interface LogoutAccountInput {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
}

export type AuthLogoutErrorCode =
  | 'not_manageable'
  | 'runtime_unavailable'
  | 'logout_failed';

export interface AuthLogoutSuccess extends LogoutAccountInput {
  ok: true;
}

export interface AuthLogoutFailure extends LogoutAccountInput {
  ok: false;
  error: {
    code: AuthLogoutErrorCode;
    message: string;
  };
}

export type AuthLogoutResult = AuthLogoutSuccess | AuthLogoutFailure;

export interface LogoutAccountDependencies {
  getAuthStatus?: (options?: GetAuthStatusOptions) => Promise<AuthStatusSnapshot>;
  getAuthStatusOptions?: GetAuthStatusOptions;
  loadPiRuntime?: (options?: LoadPiRuntimeOptions) => Promise<PiRuntimeLoadResult>;
  removeAnthropicApiKey?: typeof removeAnthropicApiKey;
  logoutClaudeAuth?: typeof logoutClaudeAuth;
  configureClaudeEnv?: () => void;
  refreshProviders?: () => void;
  piAuthPath?: string;
}

const ERROR_KEYS: Record<AuthLogoutErrorCode, string> = {
  not_manageable: 'ux.auth.notManageable',
  runtime_unavailable: 'ux.auth.piRuntimeUnavailable',
  logout_failed: 'ux.auth.logoutFailed',
};

function failed(
  input: LogoutAccountInput,
  code: AuthLogoutErrorCode,
): AuthLogoutFailure {
  return { ok: false, ...input, error: { code, message: t(ERROR_KEYS[code]) } };
}

function succeeded(input: LogoutAccountInput): AuthLogoutSuccess {
  return { ok: true, ...input };
}

function piAuthPath(dependencies: LogoutAccountDependencies): string {
  return dependencies.piAuthPath ?? piUserAuthPath();
}

async function readStatus(
  dependencies: LogoutAccountDependencies,
): Promise<AuthStatusSnapshot | null> {
  const reader = dependencies.getAuthStatus ?? getAuthStatus;
  const options = {
    ...dependencies.getAuthStatusOptions,
    piAuthPath: piAuthPath(dependencies),
  };
  try {
    return await reader(options);
  } catch {
    return null;
  }
}

function selectedCredential(
  snapshot: AuthStatusSnapshot,
  input: LogoutAccountInput,
): AuthCredentialStatus | null {
  const account = snapshot.accounts.find(item => (
    item.backend === input.backend && item.provider === input.provider
  ));
  if (!account) return null;
  if (account.authType === input.authType) {
    const current = account.credentials.find(item => (
      item.authType === input.authType && item.source === account.source
    ));
    if (current) return current;
  }
  return account.credentials.find(item => item.authType === input.authType) ?? null;
}

function reloadClaude(dependencies: LogoutAccountDependencies): void {
  const reload = dependencies.configureClaudeEnv ?? applyAuthEnv;
  reload();
}

async function removeClaudeSavedCredential(
  input: LogoutAccountInput,
  remove: () => Promise<void>,
  dependencies: LogoutAccountDependencies,
): Promise<AuthLogoutResult> {
  try {
    await remove();
    reloadClaude(dependencies);
    return succeeded(input);
  } catch {
    return failed(input, 'logout_failed');
  }
}

async function clearLegacyClaudeOAuth(): Promise<void> {
  if (!getSavedApiEnv().CLAUDE_CODE_OAUTH_TOKEN) return;
  await removeClaudeCodeOAuthToken();
}

async function logoutClaude(
  input: LogoutAccountInput,
  credential: AuthCredentialStatus,
  dependencies: LogoutAccountDependencies,
): Promise<AuthLogoutResult> {
  if (input.authType === 'api_key') {
    const remove = dependencies.removeAnthropicApiKey ?? removeAnthropicApiKey;
    return removeClaudeSavedCredential(input, remove, dependencies);
  }
  if (credential.source === 'legacy-env') {
    return removeClaudeSavedCredential(input, removeClaudeCodeOAuthToken, dependencies);
  }
  try {
    await (dependencies.logoutClaudeAuth ?? logoutClaudeAuth)();
    await clearLegacyClaudeOAuth();
    reloadClaude(dependencies);
    return succeeded(input);
  } catch {
    return failed(input, 'logout_failed');
  }
}

async function loadRuntime(
  dependencies: LogoutAccountDependencies,
): Promise<PiRuntimeLoadResult | null> {
  const loader = dependencies.loadPiRuntime ?? loadPiRuntime;
  try {
    return await loader({ authPath: piAuthPath(dependencies) });
  } catch {
    return null;
  }
}

function finishPiLogout(
  input: LogoutAccountInput,
  dependencies: LogoutAccountDependencies,
): AuthLogoutResult {
  try {
    (dependencies.refreshProviders ?? (() => piProviderDiscovery.refresh()))();
    return succeeded(input);
  } catch {
    return failed(input, 'logout_failed');
  }
}

async function logoutPi(
  input: LogoutAccountInput,
  dependencies: LogoutAccountDependencies,
): Promise<AuthLogoutResult> {
  const loaded = await loadRuntime(dependencies);
  if (!loaded?.available) return failed(input, 'runtime_unavailable');
  try {
    await loaded.runtime.logout(input.provider);
  } catch {
    return failed(input, 'logout_failed');
  }
  return finishPiLogout(input, dependencies);
}

export async function logoutAccount(
  input: LogoutAccountInput,
  dependencies: LogoutAccountDependencies = {},
): Promise<AuthLogoutResult> {
  const snapshot = await readStatus(dependencies);
  if (!snapshot) return failed(input, 'logout_failed');
  const credential = selectedCredential(snapshot, input);
  if (!credential?.manageable) return failed(input, 'not_manageable');
  return input.backend === 'pi'
    ? logoutPi(input, dependencies)
    : logoutClaude(input, credential, dependencies);
}
