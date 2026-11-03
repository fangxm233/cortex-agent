// The connections file: every credential Cortex itself owns, one entry per connection.
//
// Claude Code's subscription login and PI's built-in provider logins stay in their own stores
// (Claude's config dir, PI's auth.json) and never appear here. What this file holds is everything
// those stores cannot express: an Anthropic API key or relay for Claude Code, a base-URL override
// for one of PI's built-in providers, a complete user-defined PI provider, and each additional
// account — whose login lives in a directory of its own, so its entry holds no secret. The file is written
// owner-only because it carries keys; nothing read from it may reach a log or the UI unmasked.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from './atomic-write.js';
import { createLogger } from './log.js';
import { CONFIG_DIR } from './paths.js';

const log = createLogger('connections');

export const CONNECTIONS_FILE = path.join(CONFIG_DIR, 'connections.json');

/** Claude Code's own login. Implicit: present whenever Claude's store holds a credential. */
export const SUBSCRIPTION_CONNECTION = 'subscription';

/** The gateway-era name of the subscription route. */
export const LEGACY_SUBSCRIPTION_MODE = 'plan';

export const CONNECTION_ID_RE = /^[a-zA-Z0-9_-]+$/;

export type ConnectionBilling = 'subscription' | 'metered';
export type ClaudeAuthStyle = 'x-api-key' | 'bearer';

/** An Anthropic-protocol endpoint for Claude Code: the official API on a key, or a relay. */
export interface ClaudeKeyConnection {
  id: string;
  backend: 'claude';
  label: string;
  /** Absent: the official Anthropic API. */
  baseUrl?: string;
  authStyle: ClaudeAuthStyle;
  key: string;
  billing: ConnectionBilling;
  /** Models this endpoint serves. Absent: the Anthropic catalog. */
  models?: string[];
}

/** A PI model definition as PI's models.json takes it; fields beyond `id` pass through. */
export interface PiModelDefinition {
  id: string;
  [field: string]: unknown;
}

/** One of PI's built-in providers, pointed at another URL (a relay, a proxy). A PI connection's id
 *  is its provider name: a provider has one base URL, so it has at most one connection. */
export interface PiOverrideConnection {
  id: string;
  backend: 'pi';
  label?: string;
  provider: string;
  baseUrl: string;
  /** Wins over any credential PI holds for the provider: the key belongs to the URL. */
  key?: string;
}

/** A provider PI does not know, defined completely here. */
export interface PiCustomConnection {
  id: string;
  backend: 'pi';
  label?: string;
  provider: string;
  /** PI request protocol, e.g. `openai-completions`. */
  api: string;
  baseUrl: string;
  key?: string;
  models: PiModelDefinition[];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export type PiConnection = PiOverrideConnection | PiCustomConnection;

/** A login of its own. The credential lives in the account's own directory, never in this file. */
export interface ClaudeAccountConnection {
  id: string;
  backend: 'claude';
  type: 'account';
  label: string;
  /** Written before the first login completes; the entry is dropped when that login fails. */
  pending?: boolean;
}

/** A second (or further) login to one of PI's providers. Its id never equals a provider name: PI
 *  override and custom connections use the provider name as their id. */
export interface PiAccountConnection {
  id: string;
  backend: 'pi';
  type: 'account';
  label: string;
  provider: string;
  pending?: boolean;
}

export type AccountConnection = ClaudeAccountConnection | PiAccountConnection;
export type StoredConnection = ClaudeKeyConnection | PiConnection | AccountConnection;

interface ConnectionsDocument {
  version: 1;
  connections: StoredConnection[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value).filter(([, item]) => typeof item === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

export function isPiCustomConnection(connection: PiConnection): connection is PiCustomConnection {
  return 'api' in connection;
}

export function isAccountConnection(connection: StoredConnection): connection is AccountConnection {
  return 'type' in connection && connection.type === 'account';
}

/** The Claude connections that carry a key: every stored Claude entry but the accounts. */
export function claudeKeyConnections(connections: StoredConnection[]): ClaudeKeyConnection[] {
  return connections.filter((entry): entry is ClaudeKeyConnection => entry.backend === 'claude' && !isAccountConnection(entry));
}

/** The PI override and custom connections: every stored PI entry but the accounts. */
export function piProviderConnections(connections: StoredConnection[]): PiConnection[] {
  return connections.filter((entry): entry is PiConnection => entry.backend === 'pi' && !isAccountConnection(entry));
}

function parseClaude(raw: Json, id: string): ClaudeKeyConnection | null {
  const key = text(raw.key);
  if (!key || id === SUBSCRIPTION_CONNECTION) return null;
  const connection: ClaudeKeyConnection = {
    id, backend: 'claude', label: text(raw.label) ?? id,
    authStyle: raw.authStyle === 'bearer' ? 'bearer' : 'x-api-key',
    key,
    billing: raw.billing === 'subscription' ? 'subscription' : 'metered',
  };
  const baseUrl = text(raw.baseUrl);
  if (baseUrl) connection.baseUrl = baseUrl;
  const models = stringList(raw.models);
  if (models) connection.models = models;
  return connection;
}

function piModels(value: unknown): PiModelDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.filter((model): model is PiModelDefinition => isObject(model) && !!text(model.id));
}

function parsePi(raw: Json, id: string): PiConnection | null {
  const provider = text(raw.provider) ?? id;
  const baseUrl = text(raw.baseUrl);
  if (!CONNECTION_ID_RE.test(provider) || !baseUrl) return null;
  const base: PiOverrideConnection = { id: provider, backend: 'pi', provider, baseUrl };
  const label = text(raw.label);
  if (label) base.label = label;
  const key = text(raw.key);
  if (key) base.key = key;
  const api = text(raw.api);
  if (!api) return base;
  const custom: PiCustomConnection = { ...base, api, models: piModels(raw.models) };
  const headers = stringMap(raw.headers);
  if (headers) custom.headers = headers;
  if (isObject(raw.compat) && Object.keys(raw.compat).length > 0) custom.compat = raw.compat;
  return custom;
}

function parseAccount(raw: Json, id: string): AccountConnection | null {
  const label = text(raw.label) ?? id;
  const pending = raw.pending === true ? { pending: true } : {};
  if (raw.backend === 'claude') {
    return id === SUBSCRIPTION_CONNECTION ? null : { id, backend: 'claude', type: 'account', label, ...pending };
  }
  const provider = text(raw.provider);
  if (!provider || !CONNECTION_ID_RE.test(provider) || provider === id) return null;
  return { id, backend: 'pi', type: 'account', label, provider, ...pending };
}

function parseConnection(raw: unknown): StoredConnection | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  if (!id || !CONNECTION_ID_RE.test(id)) return null;
  if (raw.type === 'account' && (raw.backend === 'claude' || raw.backend === 'pi')) return parseAccount(raw, id);
  if (raw.backend === 'claude') return parseClaude(raw, id);
  if (raw.backend === 'pi') return parsePi(raw, id);
  return null;
}

/** Identity within the file: a Claude connection and a PI provider may share a name. */
export function connectionKey(connection: Pick<StoredConnection, 'backend' | 'id'>): string {
  return `${connection.backend}:${connection.id}`;
}

/** Valid entries in file order; a malformed or duplicate entry is dropped, never fatal. */
export function parseConnections(document: unknown): StoredConnection[] {
  const raw = isObject(document) && Array.isArray(document.connections) ? document.connections : [];
  const seen = new Set<string>();
  const connections: StoredConnection[] = [];
  for (const entry of raw) {
    const connection = parseConnection(entry);
    if (!connection || seen.has(connectionKey(connection))) {
      log.warn('Ignoring an invalid or duplicate entry in connections.json');
      continue;
    }
    seen.add(connectionKey(connection));
    connections.push(connection);
  }
  return connections;
}

/** The stored connections. A missing file is an empty list; an unreadable one is logged and empty. */
export function readConnections(file: string = CONNECTIONS_FILE): StoredConnection[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${file}: ${(error as Error).message}`);
    }
    return [];
  }
  try {
    return parseConnections(JSON.parse(raw));
  } catch (error) {
    log.warn(`Ignoring corrupt ${file}: ${(error as Error).message}`);
    return [];
  }
}

export function writeConnections(connections: StoredConnection[], file: string = CONNECTIONS_FILE): void {
  const document: ConnectionsDocument = { version: 1, connections };
  atomicWriteSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

/** Insert or replace by (backend, id), keeping the entry's position when it already exists. */
export function upsertConnection(connection: StoredConnection, file: string = CONNECTIONS_FILE): void {
  const key = connectionKey(connection);
  const current = readConnections(file);
  const index = current.findIndex((entry) => connectionKey(entry) === key);
  if (index >= 0) current[index] = connection;
  else current.push(connection);
  writeConnections(current, file);
}

/** Returns whether an entry was removed. */
export function removeConnection(
  ref: Pick<StoredConnection, 'backend' | 'id'>, file: string = CONNECTIONS_FILE,
): boolean {
  const key = connectionKey(ref);
  const current = readConnections(file);
  const next = current.filter((entry) => connectionKey(entry) !== key);
  if (next.length === current.length) return false;
  writeConnections(next, file);
  return true;
}

/** The account a login, logout or status row names: Claude's own subscription is the default
 *  login, not an account. Null: the default. */
export function accountIdOf(connection: string | null | undefined): string | null {
  return connection && connection !== SUBSCRIPTION_CONNECTION ? connection : null;
}

/** A key as the UI and logs may show it: enough to recognise, never enough to use. */
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length < 12) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** The connection a gateway-era route name stands for: Claude's `plan` is its subscription and any
 *  other Claude route kept its name as a connection id; PI selections and a selection naming no
 *  route name no connection. */
export function connectionForLegacyMode(backend: unknown, mode: unknown): string | null {
  if (backend !== 'claude' || typeof mode !== 'string' || !mode) return null;
  return mode === LEGACY_SUBSCRIPTION_MODE ? SUBSCRIPTION_CONNECTION : mode;
}

/**
 * A stored selection in the current shape: one written before connections replaced gateway modes
 * names the connection its `mode` stood for. Anything else comes back as it is. The startup
 * migration converts what a home stores; read paths apply this too, so a home it does not convert
 * (a sealed one) still loads.
 */
export function withLegacyConnection<T>(selection: T): T {
  if (!isObject(selection) || !('mode' in selection) || 'connection' in selection) return selection;
  const { mode, ...rest } = selection;
  return { ...rest, connection: connectionForLegacyMode(rest.backend, mode) } as T;
}
