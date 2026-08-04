// input:  CustomProviderView DTO and the auth.upsertCustomProvider arg type
// output: custom provider form state, validation and mutation args
// pos:    Shared view model for the custom PI provider editor
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type {
  AuthUpsertCustomProviderArgs,
  CustomProviderApi,
  CustomProviderView,
} from '@cortex-agent/ui-contract';

// Pure derivations shared by the desktop accounts panel and the mobile accounts view: form state in
// and out of the read DTO, a client-side echo of the server's rules (validateCustomProvider), and
// the mutation args. The server re-validates everything; this module only refuses earlier.

export const CUSTOM_PROVIDER_API_OPTIONS: readonly CustomProviderApi[] = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
];

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export interface CustomProviderFormState {
  name: string;
  api: CustomProviderApi;
  upstreamUrl: string;
  /** Upstream key. Empty keeps whatever the gateway route already stores. */
  apiKey: string;
  /** Model ids, one per line — the editor's plain-text shape for `models[]`. */
  models: string;
}

export function emptyCustomProviderForm(): CustomProviderFormState {
  return { name: '', api: 'anthropic-messages', upstreamUrl: '', apiKey: '', models: '' };
}

/** The stored key is never returned by the server, so the field opens empty on an edit. */
export function formStateFromCustomProvider(view: CustomProviderView): CustomProviderFormState {
  return {
    name: view.name,
    api: view.api,
    upstreamUrl: view.upstreamUrl ?? '',
    apiKey: '',
    models: view.models.map((model) => model.id).join('\n'),
  };
}

export function parseModelIds(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

export type CustomProviderFieldError =
  | 'name-required'
  | 'name-charset'
  | 'name-taken'
  | 'upstream-required'
  | 'upstream-scheme'
  | 'models-required'
  | 'model-id-duplicate';

export interface CustomProviderFormErrors {
  name?: CustomProviderFieldError;
  upstreamUrl?: CustomProviderFieldError;
  models?: CustomProviderFieldError;
}

export interface CustomProviderFormValidationOptions {
  mode: 'create' | 'update';
  /** Provider names already defined — a create may not collide with one. */
  existingNames: readonly string[];
}

export function validateCustomProviderForm(
  form: CustomProviderFormState,
  options: CustomProviderFormValidationOptions,
): CustomProviderFormErrors {
  const errors: CustomProviderFormErrors = {};

  const name = form.name.trim();
  if (name === '') errors.name = 'name-required';
  else if (!SAFE_NAME_RE.test(name)) errors.name = 'name-charset';
  else if (options.mode === 'create' && options.existingNames.includes(name)) errors.name = 'name-taken';

  const upstream = form.upstreamUrl.trim();
  if (upstream === '') errors.upstreamUrl = 'upstream-required';
  else if (!/^https?:\/\/\S+$/i.test(upstream)) errors.upstreamUrl = 'upstream-scheme';

  const ids = parseModelIds(form.models);
  if (ids.length === 0) errors.models = 'models-required';
  else if (new Set(ids).size !== ids.length) errors.models = 'model-id-duplicate';

  return errors;
}

export function isCustomProviderFormValid(errors: CustomProviderFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * An empty key field is OMITTED rather than sent empty: the server reads `undefined` as "keep the
 * stored upstream key", which is what an edit form that never displays the key must mean.
 */
export function buildCustomProviderArgs(
  form: CustomProviderFormState,
): AuthUpsertCustomProviderArgs {
  const args: AuthUpsertCustomProviderArgs = {
    name: form.name.trim(),
    api: form.api,
    upstreamUrl: form.upstreamUrl.trim(),
    models: parseModelIds(form.models).map((id) => ({ id })),
  };
  const apiKey = form.apiKey.trim();
  if (apiKey !== '') args.apiKey = apiKey;
  return args;
}
