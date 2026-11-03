// The providers PI knows and how each signs in, as the runtime over the default login reports them.

import type { AuthType } from './auth-status.js';
import { loadPiRuntime, type PiProvider } from './pi-runtime.js';

export interface PiProviderInfo {
  id: string;
  capabilities: AuthType[];
}

export function providerCapabilities(provider: PiProvider): AuthType[] {
  const capabilities: AuthType[] = [];
  if (typeof provider.auth.apiKey?.login === 'function') capabilities.push('api_key');
  if (typeof provider.auth.oauth?.login === 'function') capabilities.push('oauth');
  return capabilities;
}

/** Empty when the runtime cannot load: nothing is known, and a login will say why. */
export async function loadPiProviders(): Promise<PiProviderInfo[]> {
  try {
    const loaded = await loadPiRuntime();
    if (!loaded.available) return [];
    return loaded.runtime.getProviders().map((provider) => ({ id: provider.id, capabilities: providerCapabilities(provider) }));
  } catch {
    return [];
  }
}
