import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import { piUserAuthPath } from '@core/pi-sdk.js';
import { piProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import {
  applyAuthEnv,
  getSavedApiEnv,
  removeAnthropicApiKey,
  removeClaudeCodeOAuthToken,
} from './anthropic-env.js';
import { logoutClaudeAuth } from './cc-auth-cli.js';
import {
  getAuthStatus,
  type AuthCredentialStatus,
  type AuthStatusSnapshot,
  type AuthType,
  type GetAuthStatusOptions,
} from './auth-status.js';
import { failureReason, failureWithDetail, scrubSecrets } from './login-flow.js';
import {
  loadPiRuntime,
  type LoadPiRuntimeOptions,
  type PiCredential,
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

const log = createLogger('logout');

/** A logout failure, followed by the first line of its upstream reason when there is one. The
 *  credential being removed is masked out of both the message and the log line. */
function failed(
  input: LogoutAccountInput,
  code: AuthLogoutErrorCode,
  cause?: unknown,
  secrets: readonly string[] = [],
): AuthLogoutFailure {
  const prefix = t(ERROR_KEYS[code]);
  if (cause === undefined) return { ok: false, ...input, error: { code, message: prefix } };
  log.warn(`logout ${input.backend}/${input.provider} failed (${code}):`,
    scrubSecrets(failureReason(cause), secrets));
  const message = scrubSecrets(failureWithDetail(prefix, cause), secrets);
  return { ok: false, ...input, error: { code, message } };
}

function credentialValues(credential: PiCredential | undefined): string[] {
  if (!credential) return [];
  return Object.values(credential).flatMap(value => (
    typeof value === 'string' ? [value]
      : value && typeof value === 'object' ? Object.values(value).filter(item => typeof item === 'string')
        : []
  ));
}

function savedClaudeSecrets(): string[] {
  const saved = getSavedApiEnv();
  return [saved.ANTHROPIC_API_KEY, saved.CLAUDE_CODE_OAUTH_TOKEN].filter(value => !!value) as string[];
}

function succeeded(input: LogoutAccountInput): AuthLogoutSuccess {
  return { ok: true, ...input };
}

function piAuthPath(dependencies: LogoutAccountDependencies): string {
  return dependencies.piAuthPath ?? piUserAuthPath();
}

function readStatus(dependencies: LogoutAccountDependencies): Promise<AuthStatusSnapshot> {
  const reader = dependencies.getAuthStatus ?? getAuthStatus;
  return reader({ ...dependencies.getAuthStatusOptions, piAuthPath: piAuthPath(dependencies) });
}

/** The credential of the requested type a logout acts on: one Cortex can remove wins over one it
 *  cannot (a stored key next to an environment key), then the one the account is using. */
function selectedCredential(
  snapshot: AuthStatusSnapshot,
  input: LogoutAccountInput,
): AuthCredentialStatus | null {
  const account = snapshot.accounts.find(item => (
    item.backend === input.backend && item.provider === input.provider
  ));
  if (!account) return null;
  const candidates = account.credentials.filter(item => item.authType === input.authType);
  const current = account.authType === input.authType
    ? candidates.find(item => item.source === account.source)
    : undefined;
  if (current?.manageable) return current;
  return candidates.find(item => item.manageable) ?? current ?? candidates[0] ?? null;
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
  const secrets = savedClaudeSecrets();
  try {
    await remove();
    reloadClaude(dependencies);
    return succeeded(input);
  } catch (error) {
    return failed(input, 'logout_failed', error, secrets);
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
  const secrets = savedClaudeSecrets();
  try {
    await (dependencies.logoutClaudeAuth ?? logoutClaudeAuth)();
    await clearLegacyClaudeOAuth();
    reloadClaude(dependencies);
    return succeeded(input);
  } catch (error) {
    return failed(input, 'logout_failed', error, secrets);
  }
}

async function loadRuntime(
  dependencies: LogoutAccountDependencies,
): Promise<PiRuntimeLoadResult> {
  const loader = dependencies.loadPiRuntime ?? loadPiRuntime;
  try {
    return await loader({ authPath: piAuthPath(dependencies) });
  } catch (error) {
    return {
      available: false, version: null, entry: null, error: failureReason(error),
      runtime: null, readStoredCredential: null,
    };
  }
}

function finishPiLogout(
  input: LogoutAccountInput,
  dependencies: LogoutAccountDependencies,
): AuthLogoutResult {
  try {
    (dependencies.refreshProviders ?? (() => piProviderDiscovery.refresh()))();
    return succeeded(input);
  } catch (error) {
    return failed(input, 'logout_failed', error);
  }
}

function storedPiSecrets(
  loaded: Extract<PiRuntimeLoadResult, { available: true }>,
  input: LogoutAccountInput,
  dependencies: LogoutAccountDependencies,
): string[] {
  try {
    return credentialValues(loaded.readStoredCredential(input.provider, piAuthPath(dependencies)));
  } catch {
    return [];
  }
}

async function logoutPi(
  input: LogoutAccountInput,
  dependencies: LogoutAccountDependencies,
): Promise<AuthLogoutResult> {
  const loaded = await loadRuntime(dependencies);
  if (!loaded.available) return failed(input, 'runtime_unavailable', loaded.error ?? undefined);
  const secrets = storedPiSecrets(loaded, input, dependencies);
  try {
    await loaded.runtime.logout(input.provider);
  } catch (error) {
    return failed(input, 'logout_failed', error, secrets);
  }
  return finishPiLogout(input, dependencies);
}

export async function logoutAccount(
  input: LogoutAccountInput,
  dependencies: LogoutAccountDependencies = {},
): Promise<AuthLogoutResult> {
  let snapshot: AuthStatusSnapshot;
  try {
    snapshot = await readStatus(dependencies);
  } catch (error) {
    return failed(input, 'logout_failed', error);
  }
  const credential = selectedCredential(snapshot, input);
  if (!credential?.manageable) return failed(input, 'not_manageable');
  return input.backend === 'pi'
    ? logoutPi(input, dependencies)
    : logoutClaude(input, credential, dependencies);
}
