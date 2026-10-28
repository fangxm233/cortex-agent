import { readFileSync } from 'fs';
import type { ProviderOverride } from './providers-config.js';

/**
 * Sign in with ChatGPT on PI's `openai` provider sends the user's ChatGPT access token straight to
 * the OpenAI Responses API, which then accepts only a subset of input items and request fields: a
 * `configuration_update` item fails with `subscription_sharing_unsupported_capability`, and
 * `prompt_cache_retention` is an unsupported parameter. PI drops both itself only while the model
 * keeps its real `https://api.openai.com/v1` base URL. Cortex replaces that URL with the gateway,
 * so the sign-in is hidden from PI and Cortex turns the two capabilities off in the catalog.
 */
const CHATGPT_SIGN_IN_PROVIDER = 'openai';

/** Compat flags that keep PI from sending what Sign in with ChatGPT rejects. */
export const CHATGPT_SIGN_IN_COMPAT: Readonly<Record<string, boolean>> = Object.freeze({
  supportsMidConvoEffort: false,
  supportsLongCacheRetention: false,
});

/** Providers whose auth.json credential is an OAuth login; empty when the file is missing or unreadable. */
export function readOAuthProviders(authPath: string): Set<string> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    return new Set();
  }
  if (!data || typeof data !== 'object') return new Set();
  const entries = Object.entries(data as Record<string, { type?: unknown } | null>);
  return new Set(entries.filter(([, credential]) => credential?.type === 'oauth').map(([name]) => name));
}

/** Attach the ChatGPT sign-in compat flags to the `openai` override when it is signed in with OAuth. */
export function withChatgptSignInCompat(
  overrides: ProviderOverride[],
  oauthProviders: ReadonlySet<string>,
): ProviderOverride[] {
  if (!oauthProviders.has(CHATGPT_SIGN_IN_PROVIDER)) return overrides;
  return overrides.map((override) => (override.name === CHATGPT_SIGN_IN_PROVIDER
    ? { ...override, compat: { ...override.compat, ...CHATGPT_SIGN_IN_COMPAT } }
    : override));
}
