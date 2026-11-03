// Which credentials exist comes from the CredentialInventory alone. The Anthropic account has two
// slots: the subscription (Claude's own login, or a legacy static token) and the API key, which is
// the `api` connection. Every other Claude connection is a connection, not an Anthropic slot.

import {
  claudeOwnsOAuthCredential, readClaudeAccountIdentity, readClaudeStore, type ClaudeSubscriptionSource,
} from '@core/claude-credentials.js';
import type { ClaudeAccountConnection } from '@core/connections-file.js';
import { claudeAccountDir } from '../connections/claude-account-dir.js';
import type { Backend } from '../../agent-adapter/types.js';
import { piAuthPath } from '../../agent-adapter/pi/defaults.js';
import { resolveConfiguredDefaultRun } from '../runs/config-resolver.js';
import { modelsRepo } from '@store/models-repo.js';
import { API_KEY_CONNECTION } from './anthropic-env.js';
import { listFavorites as readFavorites } from '../agents/models.js';
import type { ModelRef } from '../agents/engine-selection.js';
import {
  loadPiRuntime as loadInstalledPiRuntime,
  type LoadPiRuntimeOptions,
  type PiCredential,
  type PiModelRuntime,
  type PiProvider,
  type PiProviderAuthStatus,
  type PiRuntimeLoadResult,
} from './pi-runtime.js';
import {
  createCredentialInventory, credentialInventory, routeName, SUBSCRIPTION_CONNECTION,
  type CredentialInventory,
} from '../connections/index.js';

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

/** Who a login is, as its vendor recorded it. Never a secret. */
export interface AuthAccountIdentity {
  email: string | null;
  organization: string | null;
  /** The plan as the vendor names it, e.g. Claude's `claude_max` or `claude_team`. */
  plan: string | null;
}

/** One login. A provider's default login (Claude's subscription and API key, PI's auth.json) is the
 *  row with `connection: null`; every account is a row of its own under the same provider. */
export interface AuthAccountStatus {
  backend: 'claude' | 'pi';
  provider: string;
  /** Null: the provider's default login. Otherwise the account connection's id. */
  connection: string | null;
  isDefault: boolean;
  /** The provider's name on a default row; the user's label on an account row. */
  label: string;
  /** Known only while signed in, and only where the vendor records it. */
  identity: AuthAccountIdentity | null;
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
  connection: string | null = null,
): AuthType | null {
  const account = snapshot.accounts.find(item => (
    item.backend === backend && item.provider === provider && (item.connection ?? null) === connection
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
  /** Which Claude credentials exist. Defaults to the daemon's inventory, or one over
   *  `claudeConfigDir` when that is given. */
  inventory?: ClaudeStatusInventory;
  /** Where Claude account config dirs live. */
  claudeAccountsDir?: string;
  /** The connection the default Claude selection runs on. */
  getDefaultClaudeConnection?: () => string;
  getActiveBackend?: () => Backend;
  listFavorites?: () => ModelRef[];
  getDefaultSelection?: () => SelectionReference | null;
}

type ClaudeStatusInventory = Pick<CredentialInventory, 'findClaude' | 'claudeSubscriptionSource'>
  & Partial<Pick<CredentialInventory, 'accounts'>>;

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

/** Claude's login held where no expiry can be read: the macOS keychain. */
function claudeKeychainCredential(): AuthCredentialStatus {
  return {
    authType: 'oauth', state: 'logged-in', source: 'keychain',
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

/** What the inventory says the Anthropic account holds, plus the store's expiry metadata. */
interface ClaudeSlots {
  apiKey: boolean;
  subscription: ClaudeSubscriptionSource | null;
  oauth: ClaudeOAuthMetadata | null;
  identity: AuthAccountIdentity | null;
}

function subscriptionCredential(slots: ClaudeSlots, nowMs: number): AuthCredentialStatus | null {
  if (!slots.subscription) return null;
  if (slots.subscription !== 'claude-store') return claudeLegacyOAuthCredential();
  return slots.oauth ? claudeOAuthCredential(slots.oauth, nowMs) : claudeKeychainCredential();
}

function claudeCredentials(slots: ClaudeSlots, nowMs: number): AuthCredentialStatus[] {
  const oauth = subscriptionCredential(slots, nowMs);
  return [...(slots.apiKey ? [claudeApiKeyCredential()] : []), ...(oauth ? [oauth] : [])];
}

const CLAUDE_DEFAULT_ROW = {
  backend: 'claude', provider: 'anthropic', connection: null, isDefault: true, label: 'Anthropic',
} as const;

function claudeAccountFromCredential(
  credential: AuthCredentialStatus,
  credentials: AuthCredentialStatus[],
  inUse: boolean,
  identity: AuthAccountIdentity | null,
): AuthAccountStatus {
  return {
    ...CLAUDE_DEFAULT_ROW, identity,
    capabilities: ['api_key', 'oauth'], authType: credential.authType, state: credential.state,
    source: credential.source, expiresAt: credential.expiresAt,
    refreshExpiresAt: credential.refreshExpiresAt, inUse, credentials,
    ...(credential.detail ? { detail: credential.detail } : {}),
  };
}

function loggedOutClaudeAccount(credentials: AuthCredentialStatus[], inUse: boolean): AuthAccountStatus {
  return {
    ...CLAUDE_DEFAULT_ROW, identity: null,
    capabilities: ['api_key', 'oauth'], authType: null, state: 'logged-out', source: null,
    expiresAt: null, refreshExpiresAt: null, inUse, credentials,
  };
}

/** The account's current slot is the one the default connection uses: the API key for the `api`
 *  connection, the subscription otherwise. Never falls back to the other slot. */
function buildClaudeAccount(
  slots: ClaudeSlots,
  connection: string,
  nowMs: number,
  inUse: boolean,
): AuthAccountStatus {
  const credentials = claudeCredentials(slots, nowMs);
  const slot: AuthType = connection === API_KEY_CONNECTION ? 'api_key' : 'oauth';
  const current = credentials.find(item => item.authType === slot);
  const identity = slots.oauth ? slots.identity : null;
  return current
    ? claudeAccountFromCredential(current, credentials, inUse, identity)
    : loggedOutClaudeAccount(credentials, inUse);
}

/** An account's login, read from its own config dir; null when it is signed out. */
function claudeAccountCredential(configDir: string, nowMs: number): AuthCredentialStatus | null {
  const oauth = readClaudeOAuth(configDir);
  if (oauth) return claudeOAuthCredential(oauth, nowMs);
  return claudeOwnsOAuthCredential({ claudeConfigDir: configDir }) ? claudeKeychainCredential() : null;
}

function buildClaudeAccountRow(
  account: ClaudeAccountConnection,
  options: GetAuthStatusOptions,
  nowMs: number,
  inUse: boolean,
): AuthAccountStatus {
  const configDir = claudeAccountDir(account.id, { accountsDir: options.claudeAccountsDir });
  const credential = claudeAccountCredential(configDir, nowMs);
  return {
    backend: 'claude', provider: 'anthropic', connection: account.id, isDefault: false, label: account.label,
    identity: credential ? readClaudeAccountIdentity({ claudeConfigDir: configDir }) : null,
    capabilities: ['oauth'], authType: credential ? 'oauth' : null, state: credential?.state ?? 'logged-out',
    source: credential?.source ?? null, expiresAt: credential?.expiresAt ?? null, refreshExpiresAt: null,
    // A signed-out account is the user's choice, not something to warn about.
    inUse: inUse && credential !== null, credentials: credential ? [credential] : [],
  };
}

function claudeAccountRows(options: GetAuthStatusOptions, nowMs: number, inUse: boolean): AuthAccountStatus[] {
  const accounts = claudeInventory(options).accounts?.() ?? [];
  return accounts
    .filter((account): account is ClaudeAccountConnection => account.backend === 'claude')
    .map(account => buildClaudeAccountRow(account, options, nowMs, inUse));
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
    backend: 'pi', provider: provider.id, connection: null, isDefault: true, label: provider.name, identity: null,
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
    backend: 'pi', provider: provider.id, connection: null, isDefault: true, label: provider.name, identity: null,
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

/** The connection the default Claude selection runs on. */
function defaultClaudeConnection(): string {
  const selection = configuredDefault();
  return selection ? routeName(selection) : SUBSCRIPTION_CONNECTION;
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

function claudeInventory(options: GetAuthStatusOptions): ClaudeStatusInventory {
  if (options.inventory) return options.inventory;
  return options.claudeConfigDir || options.claudeAccountsDir
    ? createCredentialInventory({
      claude: { claudeConfigDir: options.claudeConfigDir }, claudeAccountsDir: options.claudeAccountsDir,
    })
    : credentialInventory;
}

function claudeSlots(options: GetAuthStatusOptions): ClaudeSlots {
  const inventory = claudeInventory(options);
  return {
    apiKey: inventory.findClaude(API_KEY_CONNECTION) !== null,
    subscription: inventory.claudeSubscriptionSource(),
    oauth: readClaudeOAuth(options.claudeConfigDir),
    identity: readClaudeAccountIdentity({ claudeConfigDir: options.claudeConfigDir }),
  };
}

export async function getAuthStatus(options: GetAuthStatusOptions = {}): Promise<AuthStatusSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const authPath = options.piAuthPath ?? piAuthPath();
  const usage = collectInUse(options);
  const loader = options.loadPiRuntime ?? loadInstalledPiRuntime;
  const pi = await loader({ authPath });
  const claude = buildClaudeAccount(
    claudeSlots(options), (options.getDefaultClaudeConnection ?? defaultClaudeConnection)(),
    now.getTime(), usage.claude,
  );
  const accounts = [claude, ...claudeAccountRows(options, now.getTime(), usage.claude)];
  if (pi.available) appendPiAccounts(accounts, pi, authPath, now.getTime(), usage.pi);
  return { generatedAt: now.toISOString(), accounts, piRuntime: piRuntimeSnapshot(pi) };
}
