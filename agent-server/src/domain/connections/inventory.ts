// CredentialInventory: the one place that answers which connections exist, whether each can
// authenticate, and whether its spend is a subscription or metered. Every view it returns is
// secret-free; the routing modules beside it are the only readers of the keys themselves.

import {
  claudeOwnsOAuthCredential, claudeSubscriptionLogin, type ClaudeCredentialDeps, type ClaudeSubscriptionSource,
} from '@core/claude-credentials.js';
import {
  CONNECTIONS_FILE, SUBSCRIPTION_CONNECTION, isAccountConnection, isPiCustomConnection,
  maskKey, piProviderConnections, readConnections,
  type AccountConnection, type ClaudeAccountConnection, type ClaudeAuthStyle, type ClaudeKeyConnection,
  type ConnectionBilling, type PiAccountConnection, type PiConnection,
} from '@core/connections-file.js';
import type { Backend } from '@core/types/agent-types.js';
import { readOAuthProviders } from '../../agent-adapter/pi/chatgpt-signin.js';
import { piAuthPath } from '../../agent-adapter/pi/defaults.js';
import { claudeAccountDir } from './claude-account-dir.js';
import { piAccountAuthType } from './pi-account-dir.js';

export type ConnectionKind = 'subscription' | 'key' | 'override' | 'custom' | 'account';

/** A connection as the UI, logs and every non-routing caller see it. Never carries a key. */
export interface ConnectionView {
  id: string;
  backend: Backend;
  /** Claude: null. PI: the provider this connection serves. */
  provider: string | null;
  kind: ConnectionKind;
  label: string;
  /** Null: the vendor's own endpoint. */
  baseUrl: string | null;
  authStyle?: ClaudeAuthStyle;
  /** PI custom providers only: the request protocol. */
  api?: string;
  billing: ConnectionBilling;
  authenticated: boolean;
  keyHint: string | null;
  /** Null: the backend's own catalog decides. */
  models: string[] | null;
}

export interface InventoryDeps {
  file?: string;
  claude?: ClaudeCredentialDeps;
  /** PI's credential store; its OAuth logins are subscriptions. */
  piAuthPath?: string;
  /** Where Claude account config dirs live. */
  claudeAccountsDir?: string;
  /** Where PI account agent dirs live. */
  piAccountsDir?: string;
}

export interface SelectionRef {
  backend: Backend;
  provider: string | null;
  connection: string | null;
}

function subscriptionView(): ConnectionView {
  return {
    id: SUBSCRIPTION_CONNECTION, backend: 'claude', provider: null, kind: 'subscription',
    label: 'Claude subscription', baseUrl: null, billing: 'subscription', authenticated: true,
    keyHint: null, models: null,
  };
}

function claudeKeyView(connection: ClaudeKeyConnection): ConnectionView {
  return {
    id: connection.id, backend: 'claude', provider: null, kind: 'key', label: connection.label,
    baseUrl: connection.baseUrl ?? null, authStyle: connection.authStyle, billing: connection.billing,
    authenticated: true, keyHint: maskKey(connection.key), models: connection.models ?? null,
  };
}

/** An account bills as Claude's subscription does; it is listed only while it is signed in. */
function claudeAccountView(connection: ClaudeAccountConnection): ConnectionView {
  return {
    id: connection.id, backend: 'claude', provider: null, kind: 'account', label: connection.label,
    baseUrl: null, billing: 'subscription', authenticated: true, keyHint: null, models: null,
  };
}

function piView(connection: PiConnection): ConnectionView {
  const custom = isPiCustomConnection(connection);
  return {
    id: connection.id, backend: 'pi', provider: connection.provider,
    kind: custom ? 'custom' : 'override', label: connection.label ?? connection.provider,
    baseUrl: connection.baseUrl, ...(custom ? { api: connection.api } : {}), billing: 'metered',
    authenticated: custom ? true : !!connection.key, keyHint: maskKey(connection.key),
    models: custom ? connection.models.map((model) => model.id) : null,
  };
}


/** A PI account bills as the credential it signed in with: an OAuth login is a subscription, an
 *  API key metered. Listed only while it is signed in. */
function piAccountView(account: PiAccountConnection, authType: 'api_key' | 'oauth'): ConnectionView {
  return {
    id: account.id, backend: 'pi', provider: account.provider, kind: 'account', label: account.label,
    baseUrl: null, billing: piAccountBilling(account.provider, authType), authenticated: true,
    keyHint: null, models: null,
  };
}

function piAccountViews(deps: InventoryDeps, accounts: AccountConnection[]): ConnectionView[] {
  const views: ConnectionView[] = [];
  for (const account of accounts) {
    if (account.backend !== 'pi') continue;
    const authType = piAccountAuthType(account, { accountsDir: deps.piAccountsDir });
    if (authType) views.push(piAccountView(account, authType));
  }
  return views;
}

export interface CredentialInventory {
  /** Every connection: Claude's subscription first when present, then the file in order, PI's
   *  signed-in accounts last. */
  list(): ConnectionView[];
  claudeConnections(): ConnectionView[];
  piConnections(): ConnectionView[];
  findClaude(id: string): ConnectionView | null;
  findPi(provider: string): ConnectionView | null;
  /** The signed-in PI accounts, of one provider when given, in file order. */
  piAccounts(provider?: string): ConnectionView[];
  /** Every account in file order, signed in or not; one whose first login is still running is not
   *  an account yet. */
  accounts(): AccountConnection[];
  /** Whether any Claude connection exists. */
  hasClaude(): boolean;
  /** Which credential Claude's subscription runs on; null when it is not signed in. */
  claudeSubscriptionSource(): ClaudeSubscriptionSource | null;
  /** The connection a Claude selection that names none runs on: the subscription, else the first
   *  stored Claude connection; null when there is no Claude connection at all. */
  defaultClaudeConnection(): string | null;
  billingOf(ref: SelectionRef): ConnectionBilling;
}

/** Claude's subscription first when signed in, then the file's key connections and signed-in
 *  accounts in file order. */
function claudeViews(deps: InventoryDeps): ConnectionView[] {
  const claudeDeps = deps.claude ?? {};
  const signedIn = (account: ClaudeAccountConnection): boolean => claudeOwnsOAuthCredential({
    ...claudeDeps, claudeConfigDir: claudeAccountDir(account.id, { accountsDir: deps.claudeAccountsDir }),
  });
  const views: ConnectionView[] = claudeSubscriptionLogin(claudeDeps) ? [subscriptionView()] : [];
  for (const entry of readConnections(deps.file ?? CONNECTIONS_FILE)) {
    if (entry.backend !== 'claude') continue;
    if (!isAccountConnection(entry)) views.push(claudeKeyView(entry));
    else if (!entry.pending && signedIn(entry)) views.push(claudeAccountView(entry));
  }
  return views;
}

export function createCredentialInventory(deps: InventoryDeps = {}): CredentialInventory {
  const claudeDeps = deps.claude ?? {};
  const stored = () => readConnections(deps.file ?? CONNECTIONS_FILE);
  const subscriptionSource = (): ClaudeSubscriptionSource | null => claudeSubscriptionLogin(claudeDeps)?.source ?? null;
  const claudeConnections = (): ConnectionView[] => claudeViews(deps);
  const piConnections = (): ConnectionView[] => piProviderConnections(stored()).map(piView);
  const accounts = (): AccountConnection[] => stored()
    .filter((entry): entry is AccountConnection => isAccountConnection(entry) && !entry.pending);
  const findClaude = (id: string): ConnectionView | null => claudeConnections().find((view) => view.id === id) ?? null;
  const findPi = (provider: string): ConnectionView | null => piConnections().find((view) => view.provider === provider) ?? null;
  const piOAuth = (): Set<string> => readOAuthProviders(deps.piAuthPath ?? piAuthPath());
  const piAccounts = (provider?: string): ConnectionView[] => piAccountViews(deps, accounts())
    .filter((view) => provider === undefined || view.provider === provider);
  return {
    list: () => [...claudeConnections(), ...piConnections(), ...piAccounts()],
    claudeConnections,
    piConnections,
    findClaude,
    findPi,
    piAccounts,
    accounts,
    hasClaude: () => claudeConnections().length > 0,
    claudeSubscriptionSource: subscriptionSource,
    defaultClaudeConnection: () => claudeConnections()[0]?.id ?? null,
    billingOf: (ref) => (ref.backend === 'claude'
      ? claudeBilling(ref.connection, claudeConnections(), accounts())
      : piAccounts(ref.provider ?? undefined).find((view) => view.id === ref.connection)?.billing
        ?? piBilling(ref.provider, findPi, piOAuth)),
  };
}

/** A selection naming no connection runs on the default one (see defaultClaudeConnection). An
 *  account is a subscription whether or not it is signed in right now. */
function claudeBilling(connection: string | null, views: ConnectionView[], accounts: AccountConnection[]): ConnectionBilling {
  const id = connection ?? views[0]?.id ?? SUBSCRIPTION_CONNECTION;
  if (id === SUBSCRIPTION_CONNECTION) return 'subscription';
  if (accounts.some((account) => account.backend === 'claude' && account.id === id)) return 'subscription';
  return views.find((view) => view.id === id)?.billing ?? 'metered';
}

/** PI providers that exist only as a subscription sign-in, with no API-key form. Their spend is
 *  never a bill, so spend recorded before a sign-out, or before the login moved to another
 *  provider, stays covered. */
const SUBSCRIPTION_ONLY_PI_PROVIDERS: ReadonlySet<string> = new Set([
  'openai-codex', 'google-gemini-cli', 'google-antigravity',
]);

function piAccountBilling(provider: string, authType: 'api_key' | 'oauth'): ConnectionBilling {
  return SUBSCRIPTION_ONLY_PI_PROVIDERS.has(provider) || authType === 'oauth' ? 'subscription' : 'metered';
}

/** A PI provider whose Cortex connection carries a key is metered: that key is what PI sends.
 *  Otherwise — no connection, or one that only moves the endpoint — PI sends its own credential:
 *  its OAuth logins are subscriptions (Sign in with ChatGPT, for one), its API keys metered. */
function piBilling(
  provider: string | null,
  findPi: (provider: string) => ConnectionView | null,
  piOAuth: () => Set<string>,
): ConnectionBilling {
  if (!provider || findPi(provider)?.keyHint) return 'metered';
  if (SUBSCRIPTION_ONLY_PI_PROVIDERS.has(provider)) return 'subscription';
  return piOAuth().has(provider) ? 'subscription' : 'metered';
}

/** The daemon's inventory over its own stores. */
export const credentialInventory: CredentialInventory = createCredentialInventory();
