// Known P1 limitation: API mode reflects only the saved local key. A healthy gateway may carry
// upstream credentials while this snapshot reports the API-key slot as logged out.

import { readClaudeStore } from '@core/claude-credentials.js';
import { piUserAuthPath } from '@core/pi-sdk.js';
import type { Backend } from '../../agent-adapter/types.js';
import { resolveConfiguredDefaultRun } from '../runs/config-resolver.js';
import { modelsRepo } from '@store/models-repo.js';
import { getSavedApiEnv as readSavedApiEnv } from './anthropic-env.js';
import { listFavorites as readFavorites } from '../agents/models.js';
import type { ModelRef } from '../agents/engine-selection.js';
import {
  readClaudeAuthStatus as readInstalledClaudeAuthStatus,
  type ClaudeAuthStatus,
} from './cc-auth-cli.js';
import {
  loadPiRuntime as loadInstalledPiRuntime,
  type LoadPiRuntimeOptions,
  type PiCredential,
  type PiModelRuntime,
  type PiProvider,
  type PiProviderAuthStatus,
  type PiRuntimeLoadResult,
} from './pi-runtime.js';

export type AuthType = 'oauth' | 'api_key';
export type AuthAccountState = 'logged-in' | 'expiring' | 'expired' | 'logged-out' | 'unknown';

export interface AuthCredentialStatus {
  authType: AuthType;
  state: AuthAccountState;
  source: string | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  manageable: boolean;
  detail?: string;
}

export interface AuthAccountStatus {
  backend: 'claude' | 'pi';
  provider: string;
  label: string;
  capabilities: AuthType[];
  authType: AuthType | null;
  state: AuthAccountState;
  source: string | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  inUse: boolean;
  credentials: AuthCredentialStatus[];
  detail?: string;
}

export interface AuthStatusSnapshot {
  generatedAt: string;
  accounts: AuthAccountStatus[];
  piRuntime: { available: boolean; version: string | null; entry: string | null; error: string | null };
}

export function preferredAuthType(
  snapshot: AuthStatusSnapshot,
  backend: 'claude' | 'pi',
  provider: string,
): AuthType | null {
  const account = snapshot.accounts.find(item => (
    item.backend === backend && item.provider === provider
  ));
  if (account?.capabilities.includes('oauth')) return 'oauth';
  return account?.capabilities.includes('api_key') ? 'api_key' : null;
}

interface SelectionReference {
  backend: Backend;
  provider: string | null;
}

export interface GetAuthStatusOptions {
  now?: () => Date;
  claudeConfigDir?: string;
  piAuthPath?: string;
  loadPiRuntime?: (options?: LoadPiRuntimeOptions) => Promise<PiRuntimeLoadResult>;
  getSavedApiEnv?: () => {
    ANTHROPIC_API_KEY: string | undefined;
    ANTHROPIC_BASE_URL: string | undefined;
    CLAUDE_CODE_OAUTH_TOKEN?: string | undefined;
    CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT?: string | undefined;
  };
  getClaudeMode?: () => string;
  getActiveBackend?: () => Backend;
  listFavorites?: () => ModelRef[];
  getDefaultSelection?: () => SelectionReference | null;
  readClaudeAuthStatus?: () => Promise<ClaudeAuthStatus>;
}

interface ClaudeOAuthMetadata {
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

interface InUseAccounts {
  claude: boolean;
  pi: Set<string>;
}

const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PI_API_KEY_SOURCES = new Set<PiProviderAuthStatus['source']>([
  'runtime',
  'environment',
  'fallback',
  'models_json_key',
  'models_json_command',
]);

function validEpoch(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

function readClaudeOAuth(claudeConfigDir: string | undefined): ClaudeOAuthMetadata | null {
  const store = readClaudeStore({ claudeConfigDir });
  return store ? { expiresAt: store.expiresAt, refreshExpiresAt: store.refreshExpiresAt } : null;
}

function stateFromExpiry(nowMs: number, expiries: Array<number | null>): AuthAccountState {
  const present = expiries.filter((value): value is number => value !== null);
  if (present.some(value => value <= nowMs)) return 'expired';
  if (present.some(value => value - nowMs < EXPIRING_WINDOW_MS)) return 'expiring';
  return 'logged-in';
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function claudeOAuthCredential(
  oauth: ClaudeOAuthMetadata,
  nowMs: number,
): AuthCredentialStatus {
  // The access token auto-refreshes while the refresh token lives, so the
  // credential's real lifetime is the refresh-token expiry when present.
  const lifetime = oauth.refreshExpiresAt ?? oauth.expiresAt;
  return {
    authType: 'oauth',
    state: stateFromExpiry(nowMs, [lifetime]),
    source: 'credentials.json',
    expiresAt: toIso(lifetime),
    refreshExpiresAt: null,
    manageable: true,
  };
}

function claudeCliCredential(): AuthCredentialStatus {
  return {
    authType: 'oauth', state: 'logged-in', source: 'claude-cli',
    expiresAt: null, refreshExpiresAt: null, manageable: true,
  };
}

function claudeLegacyOAuthCredential(): AuthCredentialStatus {
  return {
    authType: 'oauth', state: 'unknown', source: 'legacy-env',
    expiresAt: null, refreshExpiresAt: null, manageable: true,
    detail: 'legacy_runtime_token',
  };
}

function claudeApiKeyCredential(): AuthCredentialStatus {
  return {
    authType: 'api_key',
    state: 'logged-in',
    source: 'env',
    expiresAt: null,
    refreshExpiresAt: null,
    manageable: true,
  };
}

function claudeCredentials(
  oauth: ClaudeOAuthMetadata | null,
  apiKey: string | undefined,
  cliLoggedIn: boolean,
  legacyToken: string | undefined,
  nowMs: number,
): AuthCredentialStatus[] {
  const credentials: AuthCredentialStatus[] = [];
  if (apiKey) credentials.push(claudeApiKeyCredential());
  if (cliLoggedIn) {
    credentials.push(oauth ? claudeOAuthCredential(oauth, nowMs) : claudeCliCredential());
  } else if (legacyToken) credentials.push(claudeLegacyOAuthCredential());
  return credentials;
}

function claudeAccountFromCredential(
  credential: AuthCredentialStatus,
  credentials: AuthCredentialStatus[],
  inUse: boolean,
): AuthAccountStatus {
  return {
    backend: 'claude', provider: 'anthropic', label: 'Anthropic',
    capabilities: ['api_key', 'oauth'], authType: credential.authType, state: credential.state,
    source: credential.source, expiresAt: credential.expiresAt,
    refreshExpiresAt: credential.refreshExpiresAt, inUse, credentials,
    ...(credential.detail ? { detail: credential.detail } : {}),
  };
}

function emptyClaudeAccount(
  state: AuthAccountState,
  credentials: AuthCredentialStatus[],
  inUse: boolean,
): AuthAccountStatus {
  return {
    backend: 'claude', provider: 'anthropic', label: 'Anthropic',
    capabilities: ['api_key', 'oauth'], authType: null, state, source: null,
    expiresAt: null, refreshExpiresAt: null, inUse, credentials,
  };
}

function buildClaudeAccount(
  oauth: ClaudeOAuthMetadata | null,
  apiKey: string | undefined,
  cliLoggedIn: boolean | null,
  legacyToken: string | undefined,
  mode: string,
  nowMs: number,
  inUse: boolean,
): AuthAccountStatus {
  const credentials = claudeCredentials(
    oauth, apiKey, cliLoggedIn === true, legacyToken, nowMs,
  );
  if (mode === 'api') {
    const current = credentials.find(item => item.authType === 'api_key');
    return current ? claudeAccountFromCredential(current, credentials, inUse)
      : emptyClaudeAccount('logged-out', credentials, inUse);
  }
  const current = cliLoggedIn === true
    ? credentials.find(item => item.authType === 'oauth')
    : undefined;
  if (current) return claudeAccountFromCredential(current, credentials, inUse);
  return emptyClaudeAccount(cliLoggedIn === null ? 'unknown' : 'logged-out', credentials, inUse);
}

function providerCapabilities(provider: PiProvider): AuthType[] {
  const capabilities: AuthType[] = [];
  if (typeof provider.auth.apiKey?.login === 'function') capabilities.push('api_key');
  if (typeof provider.auth.oauth?.login === 'function') capabilities.push('oauth');
  return capabilities;
}

function piAccountFromCredential(
  provider: PiProvider,
  credential: AuthCredentialStatus,
  credentials: AuthCredentialStatus[],
  inUse: boolean,
): AuthAccountStatus {
  return {
    backend: 'pi', provider: provider.id, label: provider.name,
    capabilities: providerCapabilities(provider), authType: credential.authType,
    state: credential.state, source: credential.source, expiresAt: credential.expiresAt,
    refreshExpiresAt: null, inUse, credentials,
    ...(credential.detail ? { detail: credential.detail } : {}),
  };
}

function unknownPiAccount(
  provider: PiProvider,
  source: string | null,
  inUse: boolean,
  credentials: AuthCredentialStatus[] = [],
): AuthAccountStatus {
  return {
    backend: 'pi', provider: provider.id, label: provider.name,
    capabilities: providerCapabilities(provider), authType: null, state: 'unknown', source,
    expiresAt: null, refreshExpiresAt: null, inUse, credentials,
  };
}

function storedPiCredential(
  credential: PiCredential,
  nowMs: number,
): AuthCredentialStatus {
  const expires = credential.type === 'oauth' ? validEpoch(credential.expires) : null;
  return {
    authType: credential.type,
    state: credential.type === 'oauth' ? stateFromExpiry(nowMs, [expires]) : 'logged-in',
    source: 'stored',
    expiresAt: toIso(expires),
    refreshExpiresAt: null,
    manageable: true,
  };
}

function ambientPiCredential(status: PiProviderAuthStatus): AuthCredentialStatus {
  const modelsJsonKey = status.source === 'models_json_key';
  return {
    authType: 'api_key',
    state: 'logged-in',
    source: status.source ?? null,
    expiresAt: null,
    refreshExpiresAt: null,
    manageable: false,
    ...(modelsJsonKey ? { detail: 'models_json_key' } : {}),
  };
}

function mergePiCredentials(
  active: AuthCredentialStatus,
  stored: AuthCredentialStatus | null,
): AuthCredentialStatus[] {
  const credentials = [active];
  const distinctSlot = stored
    && (stored.authType !== active.authType || stored.source !== active.source);
  if (distinctSlot) credentials.push(stored);
  return credentials;
}

function normalizePiAccount(
  provider: PiProvider,
  status: PiProviderAuthStatus,
  stored: AuthCredentialStatus | null,
  inUse: boolean,
): AuthAccountStatus {
  // PI reports runtime keys before stored credentials; keep that active precedence while retaining
  // each distinct (authType, source) credential slot.
  if (status.configured && PI_API_KEY_SOURCES.has(status.source)) {
    const active = ambientPiCredential(status);
    return piAccountFromCredential(provider, active, mergePiCredentials(active, stored), inUse);
  }
  if (status.configured && status.source === 'stored' && stored) {
    return piAccountFromCredential(provider, stored, [stored], inUse);
  }
  const credentials = stored ? [stored] : [];
  if (!status.configured) {
    return { ...unknownPiAccount(provider, status.source ?? null, inUse, credentials), state: 'logged-out' };
  }
  return unknownPiAccount(provider, status.source ?? null, inUse, credentials);
}

function buildPiAccount(
  runtime: PiModelRuntime,
  readStored: (providerId: string, authPath?: string) => PiCredential | undefined,
  provider: PiProvider,
  authPath: string,
  nowMs: number,
  inUse: boolean,
): AuthAccountStatus {
  let status: PiProviderAuthStatus;
  try {
    status = runtime.getProviderAuthStatus(provider.id);
  } catch {
    return unknownPiAccount(provider, null, inUse);
  }
  try {
    const credential = readStored(provider.id, authPath);
    const stored = credential ? storedPiCredential(credential, nowMs) : null;
    return normalizePiAccount(provider, status, stored, inUse);
  } catch {
    return unknownPiAccount(provider, status.source ?? null, inUse);
  }
}

function addModelReference(usage: InUseAccounts, entry: SelectionReference): void {
  if (entry.backend === 'claude') usage.claude = true;
  if (entry.backend === 'pi' && entry.provider) usage.pi.add(entry.provider);
}

function configuredDefault() {
  return modelsRepo.readIfPresent()?.default ? resolveConfiguredDefaultRun() : null;
}

function defaultRunBackend(): Backend | null {
  return configuredDefault()?.backend ?? null;
}

function defaultClaudeMode(): string {
  return configuredDefault()?.mode ?? 'plan';
}

function collectInUse(options: GetAuthStatusOptions): InUseAccounts {
  const usage: InUseAccounts = { claude: false, pi: new Set<string>() };
  try {
    for (const model of (options.listFavorites ?? readFavorites)()) addModelReference(usage, model);
  } catch {
    // A broken models file must not hide credential state.
  }
  // Include the configured default even if it is not favorited.
  const backend = (options.getActiveBackend ?? defaultRunBackend)();
  if (backend === 'claude') usage.claude = true;
  if (backend !== 'pi') return usage;
  try {
    const active = (options.getDefaultSelection ?? configuredDefault)();
    if (active) addModelReference(usage, active);
  } catch {
    // Default selection resolution is advisory for inUse only.
  }
  return usage;
}

function piRuntimeSnapshot(result: PiRuntimeLoadResult): AuthStatusSnapshot['piRuntime'] {
  return {
    available: result.available,
    version: result.version,
    entry: result.entry,
    error: result.error,
  };
}

function appendPiAccounts(
  accounts: AuthAccountStatus[],
  pi: Extract<PiRuntimeLoadResult, { available: true }>,
  authPath: string,
  nowMs: number,
  inUse: Set<string>,
): void {
  for (const provider of pi.runtime.getProviders()) {
    accounts.push(buildPiAccount(
      pi.runtime, pi.readStoredCredential, provider, authPath, nowMs, inUse.has(provider.id),
    ));
  }
}

async function resolveClaudeLogin(options: GetAuthStatusOptions): Promise<boolean | null> {
  try {
    const status = await (options.readClaudeAuthStatus ?? readInstalledClaudeAuthStatus)();
    return status.loggedIn;
  } catch {
    return null;
  }
}

export async function getAuthStatus(options: GetAuthStatusOptions = {}): Promise<AuthStatusSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const piAuthPath = options.piAuthPath ?? piUserAuthPath();
  const usage = collectInUse(options);
  const apiEnv = { ...(options.getSavedApiEnv ?? readSavedApiEnv)() };
  const loader = options.loadPiRuntime ?? loadInstalledPiRuntime;
  const [cliLoggedIn, pi] = await Promise.all([
    resolveClaudeLogin(options), loader({ authPath: piAuthPath }),
  ]);
  const claude = buildClaudeAccount(
    readClaudeOAuth(options.claudeConfigDir), apiEnv.ANTHROPIC_API_KEY, cliLoggedIn,
    apiEnv.CLAUDE_CODE_OAUTH_TOKEN,
    (options.getClaudeMode ?? defaultClaudeMode)(), now.getTime(), usage.claude,
  );
  const accounts = [claude];
  if (pi.available) appendPiAccounts(accounts, pi, piAuthPath, now.getTime(), usage.pi);
  return { generatedAt: now.toISOString(), accounts, piRuntime: piRuntimeSnapshot(pi) };
}
