// CredentialInventory: the one place that answers which connections exist, whether each can
// authenticate, and whether its spend is a subscription or metered. Every view it returns is
// secret-free; the routing modules beside it are the only readers of the keys themselves.

import {
  claudeSubscriptionLogin, type ClaudeCredentialDeps, type ClaudeSubscriptionSource,
} from '@core/claude-credentials.js';
import {
  CONNECTIONS_FILE, SUBSCRIPTION_CONNECTION, isPiCustomConnection, maskKey, readConnections,
  type ClaudeAuthStyle, type ClaudeKeyConnection, type ConnectionBilling, type PiConnection,
  type StoredConnection,
} from '@core/connections-file.js';
import type { Backend } from '@core/types/agent-types.js';
import { readOAuthProviders } from '../../agent-adapter/pi/chatgpt-signin.js';
import { piAuthPath } from '../../agent-adapter/pi/defaults.js';

export type ConnectionKind = 'subscription' | 'key' | 'override' | 'custom';

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

function viewOf(connection: StoredConnection): ConnectionView {
  return connection.backend === 'claude' ? claudeKeyView(connection) : piView(connection);
}

export interface CredentialInventory {
  /** Every connection: Claude's subscription first when present, then the file in order. */
  list(): ConnectionView[];
  claudeConnections(): ConnectionView[];
  piConnections(): ConnectionView[];
  findClaude(id: string): ConnectionView | null;
  findPi(provider: string): ConnectionView | null;
  /** Whether any Claude connection exists. */
  hasClaude(): boolean;
  /** Which credential Claude's subscription runs on; null when it is not signed in. */
  claudeSubscriptionSource(): ClaudeSubscriptionSource | null;
  /** The connection a Claude selection that names none runs on: the subscription, else the first
   *  stored Claude connection; null when there is no Claude connection at all. */
  defaultClaudeConnection(): string | null;
  billingOf(ref: SelectionRef): ConnectionBilling;
}

export function createCredentialInventory(deps: InventoryDeps = {}): CredentialInventory {
  const claudeDeps = deps.claude ?? {};
  const stored = (): StoredConnection[] => readConnections(deps.file ?? CONNECTIONS_FILE);
  const subscriptionSource = (): ClaudeSubscriptionSource | null => claudeSubscriptionLogin(claudeDeps)?.source ?? null;
  const claudeConnections = (): ConnectionView[] => [
    ...(subscriptionSource() ? [subscriptionView()] : []),
    ...stored().filter((entry) => entry.backend === 'claude').map(viewOf),
  ];
  const piConnections = (): ConnectionView[] => stored().filter((entry) => entry.backend === 'pi').map(viewOf);
  const findClaude = (id: string): ConnectionView | null => claudeConnections().find((view) => view.id === id) ?? null;
  const findPi = (provider: string): ConnectionView | null => piConnections().find((view) => view.provider === provider) ?? null;
  const piOAuth = (): Set<string> => readOAuthProviders(deps.piAuthPath ?? piAuthPath());
  return {
    list: () => [...claudeConnections(), ...piConnections()],
    claudeConnections,
    piConnections,
    findClaude,
    findPi,
    hasClaude: () => claudeConnections().length > 0,
    claudeSubscriptionSource: subscriptionSource,
    defaultClaudeConnection: () => claudeConnections()[0]?.id ?? null,
    billingOf: (ref) => (ref.backend === 'claude'
      ? claudeBilling(ref.connection, claudeConnections())
      : piBilling(ref.provider, findPi, piOAuth)),
  };
}

/** A selection naming no connection runs on the default one (see defaultClaudeConnection). */
function claudeBilling(connection: string | null, views: ConnectionView[]): ConnectionBilling {
  const id = connection ?? views[0]?.id ?? SUBSCRIPTION_CONNECTION;
  if (id === SUBSCRIPTION_CONNECTION) return 'subscription';
  return views.find((view) => view.id === id)?.billing ?? 'metered';
}

/** PI providers that exist only as a subscription sign-in, with no API-key form. Their spend is
 *  never a bill, so spend recorded before a sign-out, or before the login moved to another
 *  provider, stays covered. */
const SUBSCRIPTION_ONLY_PI_PROVIDERS: ReadonlySet<string> = new Set([
  'openai-codex', 'google-gemini-cli', 'google-antigravity',
]);

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
