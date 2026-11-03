// What the gateway era left behind, read as connections: the Claude routes of gateway.yaml, an
// Anthropic key saved in config/.env (or exported to the daemon), PI routes pointed somewhere other
// than their provider's own URL, and the custom PI providers Cortex wrote into PI's catalog with a
// placeholder key while the real one sat in the gateway route. Pure: reading and writing the files
// is the caller's.

import {
  CONNECTION_ID_RE, LEGACY_SUBSCRIPTION_MODE, SUBSCRIPTION_CONNECTION, claudeKeyConnections, connectionKey,
  type ClaudeAuthStyle, type ClaudeKeyConnection, type PiCustomConnection, type PiModelDefinition,
  type StoredConnection,
} from '@core/connections-file.js';
import {
  ANTHROPIC_ENDPOINT, GENERATED_PI_UPSTREAMS, PI_ANTHROPIC_MODE, piGatewayMode, type EndpointMap,
} from './legacy-gateway.js';

type Json = Record<string, unknown>;

export interface LegacySources {
  /** gateway.yaml's endpoint/mode tree; null when the install has no gateway.yaml. */
  endpoints: EndpointMap | null;
  /** config/.env, parsed. */
  dotenv: Record<string, string>;
  /** The daemon's own environment. */
  env: NodeJS.ProcessEnv;
  /** `providers` of PI's user catalog (`~/.pi/agent/models.json`). */
  piProviders: Record<string, unknown>;
}

export interface ConnectionsPlan {
  connections: StoredConnection[];
  /** PI catalog entries a custom connection now defines. */
  retiredPiEntries: string[];
  /** config/.env variables whose credential a connection now holds. */
  retiredDotenvKeys: string[];
  /** Routes that could not become a connection, and why. Never carries a key. */
  skipped: Array<{ route: string; reason: string }>;
}

const OFFICIAL_ANTHROPIC_URL = 'https://api.anthropic.com';
/** The key Cortex wrote into PI's catalog for a provider whose real key the gateway held. */
const GATEWAY_PLACEHOLDER_KEY = 'cortex-gateway';
const ENV_REFERENCE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** gateway.yaml `anthropic` modes that are not key connections: the subscription, and PI's own
 *  `anthropic` provider routed through the same section. */
const NOT_KEY_MODES = new Set([LEGACY_SUBSCRIPTION_MODE, PI_ANTHROPIC_MODE]);

function isJson(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== 'undefined' && trimmed !== 'null' ? trimmed : undefined;
}

function sameUrl(a: string, b: string): boolean {
  const normal = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
  return normal(a) === normal(b);
}

/** A route key as written: a literal, or `$VAR` / `${VAR}` naming config/.env (then the env). */
export function resolveKeyReference(raw: unknown, sources: LegacySources): string | undefined {
  const value = text(raw);
  const reference = value?.match(ENV_REFERENCE);
  if (!reference) return value;
  return text(sources.dotenv[reference[1]]) ?? text(sources.env[reference[1]]);
}

function routeKey(route: Json, sources: LegacySources): string | undefined {
  const keys = Array.isArray(route.keys) ? route.keys : [];
  for (const raw of keys) {
    const key = resolveKeyReference(raw, sources);
    if (key) return key;
  }
  return undefined;
}

/** The Anthropic key the daemon sent through a route holding none of its own. */
function savedAnthropicKey(sources: LegacySources): { key?: string; baseUrl?: string } {
  const fromFile = text(sources.dotenv.ANTHROPIC_API_KEY);
  if (fromFile) return { key: fromFile, baseUrl: text(sources.dotenv.ANTHROPIC_BASE_URL) };
  return { key: text(sources.env.ANTHROPIC_API_KEY), baseUrl: text(sources.env.ANTHROPIC_BASE_URL) };
}

function authStyleOf(route: Json): ClaudeAuthStyle {
  return route.auth_style === 'bearer' || route.auth_style === 'openai' ? 'bearer' : 'x-api-key';
}

function claudeConnection(id: string, key: string, baseUrl: string | undefined, authStyle: ClaudeAuthStyle): ClaudeKeyConnection {
  const connection: ClaudeKeyConnection = { id, backend: 'claude', label: id, authStyle, key, billing: 'metered' };
  if (baseUrl && !sameUrl(baseUrl, OFFICIAL_ANTHROPIC_URL)) connection.baseUrl = baseUrl;
  return connection;
}

function claudeRouteConnection(mode: string, route: Json, sources: LegacySources): ClaudeKeyConnection | string {
  if (!CONNECTION_ID_RE.test(mode) || mode === SUBSCRIPTION_CONNECTION) return 'name is not a valid connection id';
  const key = routeKey(route, sources) ?? savedAnthropicKey(sources).key;
  if (!key) return 'no key';
  return claudeConnection(mode, key, text(route.base_url), authStyleOf(route));
}

function addClaudeRoutes(sources: LegacySources, plan: ConnectionsPlan): void {
  for (const [mode, route] of Object.entries(sources.endpoints?.[ANTHROPIC_ENDPOINT] ?? {})) {
    if (NOT_KEY_MODES.has(mode)) continue;
    const result = claudeRouteConnection(mode, route, sources);
    if (typeof result === 'string') plan.skipped.push({ route: `${ANTHROPIC_ENDPOINT}/${mode}`, reason: result });
    else plan.connections.push(result);
  }
}

/** The key a pre-gateway install kept in config/.env, or the daemon was started with, is the `api`
 *  connection — unless a gateway route of that name already became it. */
function addSavedApiKey(sources: LegacySources, plan: ConnectionsPlan): void {
  if (plan.connections.some((entry) => entry.backend === 'claude' && entry.id === 'api')) return;
  const saved = savedAnthropicKey(sources);
  if (saved.key) plan.connections.push(claudeConnection('api', saved.key, saved.baseUrl, 'x-api-key'));
}

/** The gateway route a PI provider's traffic took: its own mode, else the first one in its section. */
function piRoute(endpoints: EndpointMap, provider: string): Json | undefined {
  const modes = endpoints[provider] ?? {};
  const own = modes[piGatewayMode(provider)];
  // The shared `anthropic` section's other modes are Claude Code's.
  if (own || provider === ANTHROPIC_ENDPOINT) return own;
  return Object.values(modes)[0];
}

function addPiOverrides(sources: LegacySources, plan: ConnectionsPlan): void {
  const endpoints = sources.endpoints ?? {};
  for (const [provider, generated] of Object.entries(GENERATED_PI_UPSTREAMS)) {
    const route = piRoute(endpoints, provider);
    const baseUrl = text(route?.base_url);
    if (!route || !baseUrl || generated.some((url) => sameUrl(baseUrl, url))) continue;
    const key = routeKey(route, sources);
    plan.connections.push({ id: provider, backend: 'pi', provider, baseUrl, ...(key ? { key } : {}) });
  }
}

/** The section a custom provider's route sat in: Anthropic-protocol providers shared `anthropic`. */
function customRoute(endpoints: EndpointMap, name: string, api: string): Json | undefined {
  return endpoints[api === 'anthropic-messages' ? ANTHROPIC_ENDPOINT : name]?.[name];
}

function piModelList(value: unknown): PiModelDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.filter((model): model is PiModelDefinition => isJson(model) && !!text(model.id));
}

function customConnection(name: string, entry: Json, route: Json, sources: LegacySources): PiCustomConnection {
  const connection: PiCustomConnection = {
    id: name, backend: 'pi', provider: name, api: String(entry.api),
    baseUrl: String(text(route.base_url)), models: piModelList(entry.models),
  };
  const key = routeKey(route, sources);
  if (key) connection.key = key;
  if (isJson(entry.headers)) connection.headers = entry.headers as Record<string, string>;
  if (isJson(entry.compat) && Object.keys(entry.compat).length > 0) connection.compat = entry.compat;
  return connection;
}

function customEntryResult(name: string, entry: unknown, sources: LegacySources): PiCustomConnection | string | null {
  if (!isJson(entry) || entry.apiKey !== GATEWAY_PLACEHOLDER_KEY || !text(entry.api)) return null;
  const route = customRoute(sources.endpoints ?? {}, name, String(entry.api));
  if (!route || !text(route.base_url)) return 'no gateway route holds its upstream';
  return CONNECTION_ID_RE.test(name) ? customConnection(name, entry, route, sources) : 'name is not a valid connection id';
}

function addCustomProviders(sources: LegacySources, plan: ConnectionsPlan): void {
  for (const [name, entry] of Object.entries(sources.piProviders)) {
    const result = customEntryResult(name, entry, sources);
    if (result === null) continue;
    if (typeof result === 'string') {
      plan.skipped.push({ route: `pi/${name}`, reason: result });
      continue;
    }
    plan.connections.push(result);
    plan.retiredPiEntries.push(name);
  }
}

/** A Claude route and an Anthropic-protocol custom provider of one name were one endpoint: the
 *  Claude connection serves the models the provider declared. */
function attachClaudeModels(plan: ConnectionsPlan): void {
  const customs = new Map(plan.connections
    .filter((entry): entry is PiCustomConnection => entry.backend === 'pi' && 'api' in entry)
    .filter((entry) => entry.api === 'anthropic-messages')
    .map((entry) => [entry.id, entry.models.map((model) => model.id)]));
  for (const connection of claudeKeyConnections(plan.connections)) {
    const models = customs.get(connection.id);
    if (models?.length) connection.models = models;
  }
}

/** The .env variables to retire: the saved key once a connection holds it, and a base URL that only
 *  ever applied with that key (or with none). */
function retiredDotenvKeys(sources: LegacySources, plan: ConnectionsPlan): string[] {
  const key = text(sources.dotenv.ANTHROPIC_API_KEY);
  const held = !key || claudeKeyConnections(plan.connections).some((entry) => entry.key === key);
  if (!held) return [];
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'].filter((name) => name in sources.dotenv);
}

/** Drop what an earlier run (or the user) already stored: an existing connection is never replaced. */
function withoutExisting(plan: ConnectionsPlan, existing: readonly StoredConnection[]): ConnectionsPlan {
  const stored = new Set(existing.map(connectionKey));
  return { ...plan, connections: plan.connections.filter((entry) => !stored.has(connectionKey(entry))) };
}

export function planConnections(sources: LegacySources, existing: readonly StoredConnection[] = []): ConnectionsPlan {
  const plan: ConnectionsPlan = { connections: [], retiredPiEntries: [], retiredDotenvKeys: [], skipped: [] };
  addClaudeRoutes(sources, plan);
  addSavedApiKey(sources, plan);
  addPiOverrides(sources, plan);
  addCustomProviders(sources, plan);
  attachClaudeModels(plan);
  plan.retiredDotenvKeys = retiredDotenvKeys(sources, { ...plan, connections: [...existing, ...plan.connections] });
  return withoutExisting(plan, existing);
}
