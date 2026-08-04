// input:  a PI models.json path
// output: the provider blocks it declares, and which of them are user-defined
// pos:    Reader for PI's provider catalog file format
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { existsSync, readFileSync } from 'fs';

/**
 * A models.json provider block is a *definition* (a user-defined provider) when it declares both a
 * protocol and its own models. A bare `baseUrl` (optionally with `compat`) is the override cortex
 * writes to route a PI built-in through the gateway — PI already knows those providers.
 */
export function isCustomProviderEntry(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  return typeof record.api === 'string' && Array.isArray(record.models);
}

/** Every `providers.*` block in the catalog, or an empty map when the file is absent or broken. */
export function readProvidersBlock(modelsPath: string): Record<string, unknown> {
  if (!existsSync(modelsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(modelsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const providers = (parsed as Record<string, unknown>).providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {};
    return providers as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Only the user-defined providers, keyed by name. */
export function readCustomProviderEntries(
  modelsPath: string,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(readProvidersBlock(modelsPath))) {
    if (isCustomProviderEntry(entry)) result[name] = entry;
  }
  return result;
}
