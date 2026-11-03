import { readFileSync } from 'fs';

/**
 * Sign in with ChatGPT on PI's `openai` provider sends the user's ChatGPT access token straight to
 * the OpenAI Responses API, which then accepts only a subset of input items and request fields: a
 * `configuration_update` item fails with `subscription_sharing_unsupported_capability`, and
 * `prompt_cache_retention` is an unsupported parameter. PI drops both itself only while the model
 * keeps its real `https://api.openai.com/v1` base URL. When a connection overrides that URL, the
 * sign-in is hidden from PI and Cortex turns the two capabilities off in the catalog.
 */
export const CHATGPT_SIGN_IN_PROVIDER = 'openai';

/** Compat flags that keep PI from sending what Sign in with ChatGPT rejects. */
export const CHATGPT_SIGN_IN_COMPAT: Readonly<Record<string, boolean>> = Object.freeze({
  supportsMidConvoEffort: false,
  supportsLongCacheRetention: false,
});

type StoredAuthType = 'api_key' | 'oauth';

/** Each provider's credential type in an auth.json; empty when the file is missing or unreadable. */
function storedAuthTypes(authPath: string): Map<string, StoredAuthType> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    return new Map();
  }
  if (!data || typeof data !== 'object') return new Map();
  const types = new Map<string, StoredAuthType>();
  for (const [name, credential] of Object.entries(data as Record<string, { type?: unknown } | null>)) {
    if (credential?.type === 'oauth' || credential?.type === 'api_key') types.set(name, credential.type);
  }
  return types;
}

/** Providers whose auth.json credential is an OAuth login; empty when the file is missing or unreadable. */
export function readOAuthProviders(authPath: string): Set<string> {
  return new Set([...storedAuthTypes(authPath)].filter(([, type]) => type === 'oauth').map(([name]) => name));
}

/** The type of the credential an auth.json stores for one provider; null when it stores none. */
export function storedAuthType(authPath: string, provider: string): StoredAuthType | null {
  return storedAuthTypes(authPath).get(provider) ?? null;
}
