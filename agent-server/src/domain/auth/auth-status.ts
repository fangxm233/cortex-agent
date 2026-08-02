// input:  Claude/PI auth, saved expiry, profiles, runtime
// output: auth status snapshot and preferred login type
// pos:    Backend authentication status snapshot producer
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// Known P1 limitation: API mode reflects only the saved local key. A healthy gateway may carry
// upstream credentials while this snapshot reports the API-key slot as logged out.

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Backend } from '../../agent-adapter/types.js';
import {
  getActiveBackend as readActiveBackend,
  getActiveProfile,
  getClaudeMode as readClaudeMode,
  getSavedApiEnv as readSavedApiEnv,
} from '../agents/config.js';
import {
  listProfiles as readProfiles,
  resolveProfileConfig,
  type ProfileEntry,
  type ResolvedProfile,
} from '../agents/profile-manager.js';
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

interface ActiveProfileReference {
  backend: Backend;
  provider: string | null;
}

export interface GetAuthStatusOptions {
  now?: () => Date;
  claudeCredentialsPath?: string;
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
  listProfiles?: () => ResolvedProfile[];
  getActiveProfileConfig?: () => ActiveProfileReference;
}

interface ClaudeOAuthMetadata {
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

interface ClaudeCredentialRead {
  kind: 'present' | 'missing' | 'invalid';
  oauth: ClaudeOAuthMetadata | null;
}

interface InUseAccounts {
  claude: boolean;
  pi: Set<string>;
}

const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ISO_8601_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
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

function parseIsoInstant(value: string | null): number | null {
  if (value === null || !ISO_8601_INSTANT_PATTERN.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readClaudeOAuth(filePath: string): ClaudeCredentialRead {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const raw = parsed.claudeAiOauth;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'missing', oauth: null };
    const credential = raw as Record<string, unknown>;
    const hasToken = [credential.accessToken, credential.refreshToken]
      .some(value => typeof value === 'string' && value.length > 0);
    if (!hasToken) return { kind: 'missing', oauth: null };
    return {
      kind: 'present',
      oauth: {
        expiresAt: validEpoch(credential.expiresAt),
        refreshExpiresAt: validEpoch(credential.refreshTokenExpiresAt),
      },
    };
  } catch (error) {
    const kind = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
    return { kind, oauth: null };
  }
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
  return {
    authType: 'oauth',
    state: stateFromExpiry(nowMs, [oauth.expiresAt, oauth.refreshExpiresAt]),
    source: 'credentials.json',
    expiresAt: toIso(oauth.expiresAt),
    refreshExpiresAt: toIso(oauth.refreshExpiresAt),
    manageable: true,
  };
}

function claudeSavedOAuthCredential(
  expiresAtIso: string | null,
  nowMs: number,
): AuthCredentialStatus {
  const expiresAtMs = parseIsoInstant(expiresAtIso);
  const validExpiresAt = expiresAtMs === null ? null : expiresAtIso;
  return {
    authType: 'oauth',
    state: expiresAtMs === null ? 'logged-in' : stateFromExpiry(nowMs, [expiresAtMs]),
    source: 'env',
    expiresAt: validExpiresAt,
    refreshExpiresAt: null,
    manageable: true,
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
  oauthToken: string | undefined,
  oauthTokenExpiresAt: string | undefined,
  nowMs: number,
): AuthCredentialStatus[] {
  const credentials: AuthCredentialStatus[] = [];
  if (apiKey) credentials.push(claudeApiKeyCredential());
  if (oauthToken) {
    credentials.push(claudeSavedOAuthCredential(oauthTokenExpiresAt ?? null, nowMs));
  }
  if (oauth) credentials.push(claudeOAuthCredential(oauth, nowMs));
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
  credentialRead: ClaudeCredentialRead,
  apiKey: string | undefined,
  oauthToken: string | undefined,
  oauthTokenExpiresAt: string | undefined,
  mode: string,
  nowMs: number,
  inUse: boolean,
): AuthAccountStatus {
  const credentials = claudeCredentials(
    credentialRead.oauth, apiKey, oauthToken, oauthTokenExpiresAt, nowMs,
  );
  if (mode === 'api') {
    const current = credentials.find(item => item.authType === 'api_key');
    return current ? claudeAccountFromCredential(current, credentials, inUse)
      : emptyClaudeAccount('logged-out', credentials, inUse);
  }
  const current = credentials.find(item => item.authType === 'oauth');
  if (current) return claudeAccountFromCredential(current, credentials, inUse);
  const state = credentialRead.kind === 'invalid' ? 'unknown' : 'logged-out';
  return emptyClaudeAccount(state, credentials, inUse);
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

function addProfileReference(usage: InUseAccounts, entry: ProfileEntry, inherited: Backend = 'claude'): void {
  const backend = entry.backend ?? inherited;
  if (backend === 'claude') usage.claude = true;
  if (backend === 'pi' && entry.provider) usage.pi.add(entry.provider);
}

function addProfile(usage: InUseAccounts, profile: ResolvedProfile): void {
  const primaryBackend = profile.backend ?? 'claude';
  addProfileReference(usage, profile);
  for (const fallback of profile.fallback ?? []) addProfileReference(usage, fallback, primaryBackend);
}

function defaultActiveProfileConfig(): ActiveProfileReference {
  const profile = resolveProfileConfig(getActiveProfile());
  return { backend: profile.backend, provider: profile.provider };
}

function collectInUse(options: GetAuthStatusOptions): InUseAccounts {
  const usage: InUseAccounts = { claude: false, pi: new Set<string>() };
  try {
    for (const profile of (options.listProfiles ?? readProfiles)()) addProfile(usage, profile);
  } catch {
    // A broken profile file must not hide credential state.
  }
  const backend = (options.getActiveBackend ?? readActiveBackend)();
  if (backend === 'claude') usage.claude = true;
  if (backend !== 'pi') return usage;
  try {
    const active = (options.getActiveProfileConfig ?? defaultActiveProfileConfig)();
    if (active.backend === 'pi' && active.provider) usage.pi.add(active.provider);
  } catch {
    // Active profile resolution is advisory for inUse only.
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

export async function getAuthStatus(options: GetAuthStatusOptions = {}): Promise<AuthStatusSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const home = os.homedir();
  const claudePath = options.claudeCredentialsPath ?? path.join(home, '.claude', '.credentials.json');
  const piAuthPath = options.piAuthPath ?? path.join(home, '.pi', 'agent', 'auth.json');
  const usage = collectInUse(options);
  const apiEnv = { ...(options.getSavedApiEnv ?? readSavedApiEnv)() };
  const claude = buildClaudeAccount(
    readClaudeOAuth(claudePath), apiEnv.ANTHROPIC_API_KEY,
    apiEnv.CLAUDE_CODE_OAUTH_TOKEN, apiEnv.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT,
    (options.getClaudeMode ?? readClaudeMode)(), now.getTime(), usage.claude,
  );
  const loader = options.loadPiRuntime ?? loadInstalledPiRuntime;
  const pi = await loader({ authPath: piAuthPath });
  const accounts = [claude];
  if (pi.available) appendPiAccounts(accounts, pi, piAuthPath, now.getTime(), usage.pi);
  return { generatedAt: now.toISOString(), accounts, piRuntime: piRuntimeSnapshot(pi) };
}
