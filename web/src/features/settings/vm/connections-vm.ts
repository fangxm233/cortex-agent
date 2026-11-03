import type {
  AuthStatusSnapshot,
  ConnectionView,
  CustomProviderApi,
  MutateArgs,
} from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

// Pure derivations shared by the desktop accounts panel and the mobile accounts view: the rows of
// the connections list, form state in and out of a ConnectionView, a client-side echo of the
// server's rules (domain/connections/editor.ts), and the mutation args. The server re-validates
// everything; this module only refuses earlier. A key never reaches the browser: rows show its hint.

export type ConnectionFormKind = 'claude' | 'pi-override' | 'pi-custom';
export type ClaudeAuthStyle = 'x-api-key' | 'bearer';

export const CONNECTION_KINDS: readonly ConnectionFormKind[] = ['claude', 'pi-override', 'pi-custom'];
export const CLAUDE_AUTH_STYLES: readonly ClaudeAuthStyle[] = ['x-api-key', 'bearer'];
export const CUSTOM_PROVIDER_API_OPTIONS: readonly CustomProviderApi[] = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
];

export const CONNECTION_KIND_VOCAB_KEYS = {
  claude: 'connKindClaude',
  'pi-override': 'connKindPiOverride',
  'pi-custom': 'connKindPiCustom',
} as const satisfies Record<ConnectionFormKind, keyof Vocab>;

/** What deleting a connection of each kind does to the runs that use it. */
export const CONNECTION_DELETE_RISK_VOCAB_KEYS = {
  claude: 'connDeleteRiskClaude',
  'pi-override': 'connDeleteRiskOverride',
  'pi-custom': 'connDeleteRiskCustom',
} as const satisfies Record<ConnectionFormKind, keyof Vocab>;

/** The id the Accounts API-key slot writes; its row is that slot's record. */
export const API_KEY_CONNECTION = 'api';
const SUBSCRIPTION_CONNECTION = 'subscription';
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

// ── List ────────────────────────────────────────────────────────────────────────────────────

export interface ConnectionRowVm {
  /** `backend:id` — a Claude connection and a PI provider may share a name. */
  key: string;
  backend: 'claude' | 'pi';
  id: string;
  kind: ConnectionFormKind;
  /** The Accounts API-key slot edits this same record. */
  apiKeySlot: boolean;
  /** Endpoint, protocol and models, joined for one metadata line. */
  meta: string;
  keyHint: string | null;
  view: ConnectionView;
}

export function connectionKey(ref: { backend: string; id: string }): string {
  return `${ref.backend}:${ref.id}`;
}

function formKind(view: ConnectionView): ConnectionFormKind {
  if (view.backend === 'claude') return 'claude';
  return view.kind === 'custom' ? 'pi-custom' : 'pi-override';
}

type MetaVocab = Pick<Vocab, 'connOfficialApi' | 'connAnthropicModels'>;

function rowMeta(view: ConnectionView, L: MetaVocab): string {
  const endpoint = view.baseUrl ?? L.connOfficialApi;
  const models = view.models?.join(', ');
  if (view.backend === 'claude') return [endpoint, models ?? L.connAnthropicModels].join('  ·  ');
  if (view.kind === 'custom') return [view.api ?? '—', endpoint, models ?? '—'].join('  ·  ');
  return endpoint;
}

/** Logins (the subscription, PI OAuth, named accounts) are the account rows above, not connections. */
const LOGIN_KINDS = new Set<ConnectionView['kind']>(['subscription', 'account']);

/** The connections Cortex stores and edits here. */
export function buildConnectionRows(views: readonly ConnectionView[], L: MetaVocab): ConnectionRowVm[] {
  return views.filter((view) => !LOGIN_KINDS.has(view.kind)).map((view) => ({
    key: connectionKey(view),
    backend: view.backend === 'claude' ? 'claude' : 'pi',
    id: view.id,
    kind: formKind(view),
    apiKeySlot: view.backend === 'claude' && view.id === API_KEY_CONNECTION,
    meta: rowMeta(view, L),
    keyHint: view.keyHint,
    view,
  }));
}

/** PI's own providers a base-URL override can redirect: not custom, not overridden yet. */
export function overridableProviders(
  status: AuthStatusSnapshot | undefined, views: readonly ConnectionView[],
): string[] {
  const stored = new Set(views.filter((view) => view.backend === 'pi').map((view) => view.id));
  const providers = (status?.accounts ?? []).filter((account) => account.backend === 'pi').map((account) => account.provider);
  return [...new Set(providers)].filter((provider) => !stored.has(provider)).sort();
}

// ── Form ────────────────────────────────────────────────────────────────────────────────────

export interface ConnectionFormState {
  kind: ConnectionFormKind;
  /** Claude: the connection id. PI: the provider. */
  name: string;
  api: CustomProviderApi;
  baseUrl: string;
  authStyle: ClaudeAuthStyle;
  /** Empty keeps the stored key. */
  key: string;
  /** Model ids, one per line. */
  models: string;
}

export function emptyConnectionForm(kind: ConnectionFormKind = 'claude'): ConnectionFormState {
  return { kind, name: '', api: 'anthropic-messages', baseUrl: '', authStyle: 'x-api-key', key: '', models: '' };
}

/** The stored key is never returned by the server, so the field opens empty on an edit. */
export function formStateFromConnection(view: ConnectionView): ConnectionFormState {
  return {
    kind: formKind(view),
    name: view.id,
    api: (view.api as CustomProviderApi | undefined) ?? 'anthropic-messages',
    baseUrl: view.baseUrl ?? '',
    authStyle: view.authStyle ?? 'x-api-key',
    key: '',
    models: (view.models ?? []).join('\n'),
  };
}

export function parseModelIds(raw: string): string[] {
  return raw.split(/[\n,]/).map((id) => id.trim()).filter((id) => id !== '');
}

// ── Which fields a kind shows ───────────────────────────────────────────────────────────────

type HintKey = 'connClaudeUrlHint' | 'connOverrideUrlHint' | 'connKeyHint' | 'connOverrideKeyHint'
  | 'connClaudeModelsHint' | 'connModelsHint';

export interface ConnectionFieldSpec {
  /** The kind is picked once, on create. */
  kindSelect: boolean;
  /** A new override picks one of PI's own providers. */
  nameSelect: boolean;
  nameLabel: 'connFieldName' | 'connFieldProvider';
  api: boolean;
  authStyle: boolean;
  models: boolean;
  urlHint: HintKey | null;
  keyHint: HintKey | null;
  modelsHint: HintKey;
}

type KindFields = Pick<ConnectionFieldSpec, 'nameLabel' | 'api' | 'authStyle' | 'models' | 'urlHint' | 'modelsHint'>;

const KIND_FIELDS: Record<ConnectionFormKind, KindFields> = {
  claude: { nameLabel: 'connFieldName', api: false, authStyle: true, models: true, urlHint: 'connClaudeUrlHint', modelsHint: 'connClaudeModelsHint' },
  'pi-override': { nameLabel: 'connFieldProvider', api: false, authStyle: false, models: false, urlHint: 'connOverrideUrlHint', modelsHint: 'connModelsHint' },
  'pi-custom': { nameLabel: 'connFieldProvider', api: true, authStyle: false, models: true, urlHint: null, modelsHint: 'connModelsHint' },
};

function keyHint(kind: ConnectionFormKind, creating: boolean): HintKey | null {
  if (kind === 'pi-override') return 'connOverrideKeyHint';
  return creating ? null : 'connKeyHint';
}

export function connectionFieldSpec(kind: ConnectionFormKind, creating: boolean): ConnectionFieldSpec {
  return {
    ...KIND_FIELDS[kind], kindSelect: creating, nameSelect: creating && kind === 'pi-override',
    keyHint: keyHint(kind, creating),
  };
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────

export type ConnectionFieldError =
  | 'name-required' | 'name-charset' | 'name-taken' | 'name-reserved'
  | 'url-required' | 'url-scheme' | 'key-required'
  | 'models-required' | 'model-id-duplicate';

export const CONNECTION_FIELD_ERROR_VOCAB_KEYS = {
  'name-required': 'connErrNameRequired',
  'name-charset': 'connErrNameCharset',
  'name-taken': 'connErrNameTaken',
  'name-reserved': 'connErrNameReserved',
  'url-required': 'connErrUrlRequired',
  'url-scheme': 'connErrUrlScheme',
  'key-required': 'connErrKeyRequired',
  'models-required': 'connErrModelsRequired',
  'model-id-duplicate': 'connErrModelsDuplicate',
} as const satisfies Record<ConnectionFieldError, keyof Vocab>;

type FieldErrorVocab = Pick<Vocab, (typeof CONNECTION_FIELD_ERROR_VOCAB_KEYS)[ConnectionFieldError]>;

/** Resolves shared validation copy without duplicating the code-to-vocabulary map in each view. */
export function connectionFieldErrorCopy(error: ConnectionFieldError | undefined, vocab: FieldErrorVocab): string | undefined {
  return error ? vocab[CONNECTION_FIELD_ERROR_VOCAB_KEYS[error]] : undefined;
}

export interface ConnectionFormErrors {
  name?: ConnectionFieldError;
  baseUrl?: ConnectionFieldError;
  key?: ConnectionFieldError;
  models?: ConnectionFieldError;
}

export interface ConnectionFormValidationOptions {
  mode: 'create' | 'update';
  /** Rows already stored — a create may not reuse a name on the same backend. */
  existing: readonly Pick<ConnectionRowVm, 'backend' | 'id'>[];
}

function backendOf(kind: ConnectionFormKind): 'claude' | 'pi' {
  return kind === 'claude' ? 'claude' : 'pi';
}

function nameError(form: ConnectionFormState, options: ConnectionFormValidationOptions): ConnectionFieldError | undefined {
  const name = form.name.trim();
  if (name === '') return 'name-required';
  if (!SAFE_NAME_RE.test(name)) return 'name-charset';
  if (form.kind === 'claude' && name === SUBSCRIPTION_CONNECTION) return 'name-reserved';
  const taken = options.existing.some((row) => row.backend === backendOf(form.kind) && row.id === name);
  return options.mode === 'create' && taken ? 'name-taken' : undefined;
}

/** Claude's endpoint may stay empty (the Anthropic API); a PI connection exists to set one. */
function urlError(form: ConnectionFormState): ConnectionFieldError | undefined {
  const url = form.baseUrl.trim();
  if (url === '') return form.kind === 'claude' ? undefined : 'url-required';
  return URL_RE.test(url) ? undefined : 'url-scheme';
}

function modelsError(form: ConnectionFormState): ConnectionFieldError | undefined {
  const ids = parseModelIds(form.models);
  if (ids.length === 0) return form.kind === 'pi-custom' ? 'models-required' : undefined;
  return new Set(ids).size === ids.length ? undefined : 'model-id-duplicate';
}

export function validateConnectionForm(
  form: ConnectionFormState, options: ConnectionFormValidationOptions,
): ConnectionFormErrors {
  const keyMissing = form.kind === 'claude' && options.mode === 'create' && form.key.trim() === '';
  const errors: ConnectionFormErrors = {
    name: nameError(form, options),
    baseUrl: urlError(form),
    key: keyMissing ? 'key-required' : undefined,
    models: modelsError(form),
  };
  return Object.fromEntries(Object.entries(errors).filter(([, error]) => error)) as ConnectionFormErrors;
}

export function isConnectionFormValid(errors: ConnectionFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

// ── Mutation args ───────────────────────────────────────────────────────────────────────────

export type ConnectionUpsertArgs = MutateArgs<'connections.upsert'>;

/** An empty Claude endpoint or model list means the Anthropic API and catalog. */
function claudeArgs(form: ConnectionFormState): ConnectionUpsertArgs {
  return {
    kind: 'claude', id: form.name.trim(), baseUrl: form.baseUrl.trim(),
    authStyle: form.authStyle, models: parseModelIds(form.models),
  };
}

function piArgs(form: ConnectionFormState): ConnectionUpsertArgs {
  const base = { provider: form.name.trim(), baseUrl: form.baseUrl.trim() };
  if (form.kind === 'pi-override') return { kind: 'pi-override', ...base };
  return { kind: 'pi-custom', ...base, api: form.api, models: parseModelIds(form.models) };
}

/**
 * An empty key field is OMITTED rather than sent empty: the server reads `undefined` as "keep the
 * stored key", which is what an edit form that never displays the key must mean.
 */
export function buildConnectionArgs(form: ConnectionFormState, mode: 'create' | 'update'): ConnectionUpsertArgs {
  const args = form.kind === 'claude' ? claudeArgs(form) : piArgs(form);
  const key = form.key.trim();
  return { ...args, ...(key !== '' ? { key } : {}), ...(mode === 'create' ? { create: true } : {}) };
}
