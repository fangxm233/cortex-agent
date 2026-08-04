// input:  user-supplied custom provider definitions
// output: validation issues, gateway auth styles, PI catalog entries
// pos:    Shape and rules of a user-defined PI provider
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/** PI request protocols a custom provider may speak (PI docs/models.md §Supported APIs). */
export const CUSTOM_PROVIDER_APIS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
] as const;

export type CustomProviderApi = typeof CUSTOM_PROVIDER_APIS[number];

/** aistatus auth styles (node_modules/aistatus AUTH_STYLES): how the gateway presents the key. */
export type GatewayAuthStyle = 'anthropic' | 'openai' | 'google';

export interface CustomProviderModelSpec {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface CustomProviderInput {
  name: string;
  api: CustomProviderApi;
  /** Real upstream endpoint. Stored in gateway.yaml, never in the PI catalog. */
  upstreamUrl: string;
  /** Upstream key. `undefined` keeps whatever is already stored; `''` clears it. */
  apiKey?: string;
  models: CustomProviderModelSpec[];
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export type CustomProviderIssue =
  | 'name-required'
  | 'name-charset'
  | 'name-reserved'
  | 'api-invalid'
  | 'upstream-required'
  | 'upstream-scheme'
  | 'models-required'
  | 'model-id-required'
  | 'model-id-duplicate';

/** Same charset the profile loader enforces on a PI provider name (domain/agents/profile-manager). */
export const CUSTOM_PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Written as the PI-side `apiKey` so PI counts the provider as authenticated and lists its models.
 * The real upstream secret lives in the gateway route; the gateway does not check inbound keys.
 */
export const GATEWAY_PLACEHOLDER_KEY = 'cortex-gateway';

const AUTH_STYLE_BY_API: Record<CustomProviderApi, GatewayAuthStyle> = {
  'anthropic-messages': 'anthropic',
  'openai-completions': 'openai',
  'openai-responses': 'openai',
  'google-generative-ai': 'google',
};

export function gatewayAuthStyle(api: CustomProviderApi): GatewayAuthStyle {
  return AUTH_STYLE_BY_API[api];
}

/**
 * PI's baseUrl for a custom provider: the gateway's mode route, so every call is accounted and
 * throttled like any other route. Endpoint segment and mode both carry the provider name, matching
 * `buildPiGatewaySubPath(mode, provider)` for a profile whose mode equals its provider.
 */
export function customProviderBaseUrl(gatewayUrl: string, name: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/m/${name}/${name}`;
}

export interface ValidateCustomProviderOpts {
  /** Provider ids PI already owns — a custom definition may not shadow one. */
  reservedNames?: string[];
}

export function validateCustomProvider(
  input: CustomProviderInput,
  opts: ValidateCustomProviderOpts = {},
): CustomProviderIssue[] {
  const issues: CustomProviderIssue[] = [];

  const name = input.name?.trim() ?? '';
  if (!name) issues.push('name-required');
  else if (!CUSTOM_PROVIDER_NAME_RE.test(name)) issues.push('name-charset');
  else if (opts.reservedNames?.includes(name)) issues.push('name-reserved');

  if (!CUSTOM_PROVIDER_APIS.includes(input.api)) issues.push('api-invalid');

  const upstream = input.upstreamUrl?.trim() ?? '';
  if (!upstream) issues.push('upstream-required');
  else if (!/^https?:\/\/\S+$/i.test(upstream)) issues.push('upstream-scheme');

  const models = input.models ?? [];
  if (models.length === 0) {
    issues.push('models-required');
  } else {
    const ids = models.map((m) => m.id?.trim() ?? '');
    if (ids.some((id) => !id)) issues.push('model-id-required');
    else if (new Set(ids).size !== ids.length) issues.push('model-id-duplicate');
  }

  return issues;
}

/** Normalize free-form input: trim strings, drop empty optional maps, keep declared model fields. */
export function normalizeCustomProvider(input: CustomProviderInput): CustomProviderInput {
  return {
    ...input,
    name: input.name?.trim() ?? '',
    upstreamUrl: input.upstreamUrl?.trim() ?? '',
    models: (input.models ?? []).map((model) => ({
      ...model,
      id: model.id?.trim() ?? '',
    })),
  };
}

/** The `providers.<name>` object written into PI's models.json. Carries no upstream secret. */
export function buildModelsJsonEntry(
  input: CustomProviderInput,
  gatewayUrl: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    baseUrl: customProviderBaseUrl(gatewayUrl, input.name),
    api: input.api,
    apiKey: GATEWAY_PLACEHOLDER_KEY,
    models: input.models.map((model) => {
      const spec: Record<string, unknown> = { id: model.id };
      if (model.contextWindow !== undefined) spec.contextWindow = model.contextWindow;
      if (model.maxTokens !== undefined) spec.maxTokens = model.maxTokens;
      if (model.reasoning !== undefined) spec.reasoning = model.reasoning;
      return spec;
    }),
  };
  if (input.headers && Object.keys(input.headers).length > 0) entry.headers = input.headers;
  if (input.compat && Object.keys(input.compat).length > 0) entry.compat = input.compat;
  return entry;
}

export function readEntryModels(entry: Record<string, unknown>): CustomProviderModelSpec[] {
  const models = Array.isArray(entry.models) ? entry.models : [];
  return models
    .filter((model): model is Record<string, unknown> => !!model && typeof model === 'object')
    .map((model) => {
      const spec: CustomProviderModelSpec = { id: String(model.id ?? '') };
      if (typeof model.contextWindow === 'number') spec.contextWindow = model.contextWindow;
      if (typeof model.maxTokens === 'number') spec.maxTokens = model.maxTokens;
      if (typeof model.reasoning === 'boolean') spec.reasoning = model.reasoning;
      return spec;
    });
}
