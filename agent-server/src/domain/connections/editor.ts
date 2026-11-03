// Editing the connections file from Settings: one create/update/remove for every connection kind
// Cortex stores — a Claude key or relay, a base-URL override of one of PI's built-in providers, and
// a custom PI provider. Keys go in and never come out: results are inventory views (keyHint only).
// The Claude API key slot in Accounts is the `api` entry here, so both surfaces edit one record.

import { createLogger } from '@core/log.js';
import {
  CONNECTIONS_FILE, CONNECTION_ID_RE, SUBSCRIPTION_CONNECTION, isAccountConnection, isPiCustomConnection,
  readConnections, removeConnection, upsertConnection, type AccountConnection, type ClaudeAuthStyle,
  type ClaudeKeyConnection, type ConnectionBilling, type PiOverrideConnection, type StoredConnection,
} from '@core/connections-file.js';
import { removeAnthropicApiKey, API_KEY_CONNECTION } from '../auth/anthropic-env.js';
import {
  removeCustomProvider, upsertCustomProvider, type CustomProviderApi, type CustomProviderFailure,
} from '../pi-providers/index.js';
import { createCredentialInventory, type ConnectionView } from './inventory.js';

const log = createLogger('connections-editor');

export interface ClaudeConnectionInput {
  kind: 'claude';
  id: string;
  label?: string;
  /** Empty: the official Anthropic API. Omitted keeps the stored one. */
  baseUrl?: string;
  authStyle?: ClaudeAuthStyle;
  billing?: ConnectionBilling;
  /** Empty: the Anthropic catalog. Omitted keeps the stored list. */
  models?: string[];
  /** Omitted keeps the stored key. A Claude connection always needs one. */
  key?: string;
}

export interface PiOverrideInput {
  kind: 'pi-override';
  provider: string;
  baseUrl: string;
  /** Omitted keeps the stored key; empty clears it (PI's own login is used again). */
  key?: string;
}

export interface PiCustomInput {
  kind: 'pi-custom';
  provider: string;
  api: CustomProviderApi;
  baseUrl: string;
  models: string[];
  /** Omitted keeps the stored key; empty clears it. */
  key?: string;
}

export type ConnectionInput = (ClaudeConnectionInput | PiOverrideInput | PiCustomInput) & {
  /** A create refuses an id already in use instead of replacing it. */
  create?: boolean;
};

export type ConnectionIssue = CustomProviderFailure
  | 'name-reserved' | 'name-taken' | 'key-required' | 'not-found' | 'write-failed';

export type ConnectionWrite =
  | { ok: true; connection: ConnectionView | null }
  | { ok: false; errors: ConnectionIssue[] };

export interface ConnectionEditorDeps {
  file?: string;
  /** After a change, so caches built from connections (the PI scan) refresh. */
  onChanged?: (backend: 'claude' | 'pi') => void;
}

const URL_RE = /^https?:\/\/\S+$/i;

function stored(deps: ConnectionEditorDeps): StoredConnection[] {
  return readConnections(deps.file ?? CONNECTIONS_FILE);
}

type EditableConnection = Exclude<StoredConnection, AccountConnection>;

/** Accounts are added and removed with their login (domain/auth/accounts), never edited here. */
function findStored(deps: ConnectionEditorDeps, backend: 'claude' | 'pi', id: string): EditableConnection | null {
  const found = stored(deps).find((entry) => entry.backend === backend && entry.id === id);
  return found && !isAccountConnection(found) ? found : null;
}

function isAccountId(deps: ConnectionEditorDeps, backend: 'claude' | 'pi', id: string): boolean {
  return stored(deps).some((entry) => entry.backend === backend && entry.id === id && isAccountConnection(entry));
}

function viewFor(deps: ConnectionEditorDeps, backend: 'claude' | 'pi', id: string): ConnectionView | null {
  const inventory = createCredentialInventory({ file: deps.file });
  return backend === 'claude' ? inventory.findClaude(id) : inventory.findPi(id);
}

function write(deps: ConnectionEditorDeps, connection: StoredConnection): ConnectionWrite {
  try {
    upsertConnection(connection, deps.file ?? CONNECTIONS_FILE);
  } catch (error) {
    log.warn(`Failed to save connection '${connection.id}': ${(error as Error).message}`);
    return { ok: false, errors: ['write-failed'] };
  }
  deps.onChanged?.(connection.backend);
  return { ok: true, connection: viewFor(deps, connection.backend, connection.id) };
}

function nameIssues(id: string, taken: boolean, create: boolean | undefined): ConnectionIssue[] {
  if (!id) return ['name-required'];
  if (!CONNECTION_ID_RE.test(id)) return ['name-charset'];
  return create && taken ? ['name-taken'] : [];
}

// ── Claude ──────────────────────────────────────────────────────────────────────────────────

function claudeIssues(input: ClaudeConnectionInput & { create?: boolean }, previous: ClaudeKeyConnection | null): ConnectionIssue[] {
  if (input.id === SUBSCRIPTION_CONNECTION) return ['name-reserved'];
  const issues = nameIssues(input.id, previous !== null, input.create);
  const baseUrl = input.baseUrl?.trim();
  if (baseUrl && !URL_RE.test(baseUrl)) issues.push('upstream-scheme');
  const key = input.key === undefined ? previous?.key : input.key.trim();
  if (!key) issues.push('key-required');
  return issues;
}

function claudeConnection(input: ClaudeConnectionInput, previous: ClaudeKeyConnection | null): ClaudeKeyConnection {
  const connection: ClaudeKeyConnection = {
    id: input.id, backend: 'claude', label: input.label?.trim() || previous?.label || input.id,
    authStyle: input.authStyle ?? previous?.authStyle ?? 'x-api-key',
    key: input.key === undefined ? previous!.key : input.key.trim(),
    billing: input.billing ?? previous?.billing ?? 'metered',
  };
  const baseUrl = input.baseUrl === undefined ? previous?.baseUrl : input.baseUrl.trim();
  if (baseUrl) connection.baseUrl = baseUrl;
  const models = (input.models === undefined ? previous?.models : input.models)?.map((id) => id.trim()).filter(Boolean);
  if (models && models.length > 0) connection.models = [...new Set(models)];
  return connection;
}

function upsertClaude(input: ClaudeConnectionInput & { create?: boolean }, deps: ConnectionEditorDeps): ConnectionWrite {
  if (isAccountId(deps, 'claude', input.id)) return { ok: false, errors: ['name-taken'] };
  const found = findStored(deps, 'claude', input.id);
  const previous = found?.backend === 'claude' ? found : null;
  const issues = claudeIssues(input, previous);
  return issues.length > 0 ? { ok: false, errors: issues } : write(deps, claudeConnection(input, previous));
}

// ── PI ──────────────────────────────────────────────────────────────────────────────────────

function upsertOverride(input: PiOverrideInput & { create?: boolean }, deps: ConnectionEditorDeps): ConnectionWrite {
  const provider = input.provider.trim();
  const found = findStored(deps, 'pi', provider);
  if (isAccountId(deps, 'pi', provider)) return { ok: false, errors: ['name-taken'] };
  if (found?.backend === 'pi' && isPiCustomConnection(found)) return { ok: false, errors: ['name-taken'] };
  const previous = found?.backend === 'pi' ? found as PiOverrideConnection : null;
  const issues = nameIssues(provider, previous !== null, input.create);
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) issues.push('upstream-required');
  else if (!URL_RE.test(baseUrl)) issues.push('upstream-scheme');
  if (issues.length > 0) return { ok: false, errors: issues };
  const connection: PiOverrideConnection = { id: provider, backend: 'pi', provider, baseUrl };
  if (previous?.label) connection.label = previous.label;
  const key = input.key === undefined ? previous?.key : input.key.trim();
  if (key) connection.key = key;
  return write(deps, connection);
}

function upsertCustom(input: PiCustomInput & { create?: boolean }, deps: ConnectionEditorDeps): ConnectionWrite {
  const provider = input.provider.trim();
  const found = findStored(deps, 'pi', provider);
  if (isAccountId(deps, 'pi', provider)) return { ok: false, errors: ['name-taken'] };
  if (found && (input.create || !(found.backend === 'pi' && isPiCustomConnection(found)))) {
    return { ok: false, errors: ['name-taken'] };
  }
  const stores = { connectionsPath: deps.file ?? CONNECTIONS_FILE, onChanged: () => deps.onChanged?.('pi') };
  const result = upsertCustomProvider(stores, {
    name: provider, api: input.api, upstreamUrl: input.baseUrl,
    models: input.models.map((id) => ({ id })), apiKey: input.key,
  });
  if (result.ok === false) return { ok: false, errors: result.errors };
  return { ok: true, connection: viewFor(deps, 'pi', provider) };
}

/** Create or update one connection. Validation failures name every issue at once. */
export function upsertConnectionFrom(input: ConnectionInput, deps: ConnectionEditorDeps = {}): ConnectionWrite {
  if (input.kind === 'claude') return upsertClaude(input, deps);
  if (input.kind === 'pi-override') return upsertOverride(input, deps);
  return upsertCustom(input, deps);
}

/** Delete a stored connection; the Claude `api` key also leaves a pre-connections `.env`. */
async function deleteStored(found: EditableConnection, deps: ConnectionEditorDeps): Promise<ConnectionIssue[]> {
  const file = deps.file ?? CONNECTIONS_FILE;
  if (found.backend === 'pi' && isPiCustomConnection(found)) {
    const removed = removeCustomProvider({ connectionsPath: file }, found.id);
    return removed.ok === false ? removed.errors : [];
  }
  if (found.backend === 'claude' && found.id === API_KEY_CONNECTION && !deps.file) await removeAnthropicApiKey();
  else removeConnection({ backend: found.backend, id: found.id }, file);
  return [];
}

/**
 * Remove one stored connection. The Claude `api` entry goes the way the Accounts API-key slot
 * removes it; the subscription is not stored here and is removed by logging out.
 */
export async function removeConnectionBy(
  ref: { backend: 'claude' | 'pi'; id: string }, deps: ConnectionEditorDeps = {},
): Promise<ConnectionWrite> {
  const found = findStored(deps, ref.backend, ref.id);
  if (!found) return { ok: false, errors: ['not-found'] };
  let errors: ConnectionIssue[];
  try {
    errors = await deleteStored(found, deps);
  } catch (error) {
    log.warn(`Failed to remove connection '${ref.id}': ${(error as Error).message}`);
    errors = ['write-failed'];
  }
  if (errors.length > 0) return { ok: false, errors };
  deps.onChanged?.(ref.backend);
  return { ok: true, connection: null };
}
