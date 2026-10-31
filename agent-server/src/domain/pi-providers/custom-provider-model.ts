/** PI request protocols a custom provider may speak (PI docs/models.md §Supported APIs). */
export const CUSTOM_PROVIDER_APIS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
] as const;

export type CustomProviderApi = typeof CUSTOM_PROVIDER_APIS[number];

export interface CustomProviderModelSpec {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface CustomProviderInput {
  name: string;
  api: CustomProviderApi;
  /** The endpoint PI calls. */
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
  | 'api-invalid'
  | 'upstream-required'
  | 'upstream-scheme'
  | 'models-required'
  | 'model-id-required'
  | 'model-id-duplicate';

/** Safe provider names used by the model selection and connection ids. */
export const CUSTOM_PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function validateCustomProvider(input: CustomProviderInput): CustomProviderIssue[] {
  const issues: CustomProviderIssue[] = [];

  const name = input.name?.trim() ?? '';
  if (!name) issues.push('name-required');
  else if (!CUSTOM_PROVIDER_NAME_RE.test(name)) issues.push('name-charset');

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
