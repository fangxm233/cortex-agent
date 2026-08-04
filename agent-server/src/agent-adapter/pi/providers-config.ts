// input:  provider override set, gateway base URL, explicit models.json path
// output: an atomically written multi-provider PI models.json
// pos:    Ambient-free PI provider catalog writer
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import * as path from 'path';

/**
 * One provider entry to write into the cortex-controlled `models.json`. cortex uses PI's
 * "Override Built-in Providers" mechanism (docs/models.md §Overriding Built-in Providers):
 * specifying only `baseUrl` redirects all of that provider's traffic to our gateway while
 * keeping PI's built-in model catalog and OAuth/API-key auth resolution from auth.json intact.
 */
export interface ProviderOverride {
  /** PI provider name (e.g. "anthropic", "deepseek", "openai-codex"). */
  name: string;
  /**
   * Path segment appended to the gateway URL. Defaults to `/${name}`.
   * An explicit empty string keeps the gateway URL exact; other values select a non-standard path
   * (e.g. deepseek's anthropic-compat endpoint: `/deepseek/anthropic`).
   */
  basePath?: string;
  /**
   * Per-spawn PI compat flags to write into this provider's models.json entry.
   * Merged ON TOP of PROVIDER_COMPAT_OVERRIDES (explicit wins). Normally unset —
   * the static table covers the known cases.
   */
  compat?: Record<string, unknown>;
  /**
   * Complete provider block for a user-defined provider, written verbatim. PI knows nothing about
   * such a provider, so a `baseUrl`-only override would strip the protocol (`api`) and the model
   * list and leave PI unable to call it. When set, `basePath`/`compat` are ignored — the definition
   * already carries its own gateway `baseUrl`.
   */
  entry?: Record<string, unknown>;
}

/**
 * PI compat flags that PI auto-detects from the provider's *real* endpoint URL but loses once
 * cortex rewrites `baseUrl` to the gateway. PI's `detectCompat()` keys `supportsDeveloperRole`
 * off `baseUrl.includes("deepseek.com")` ONLY (not the provider name), so routing DeepSeek
 * through `http://127.0.0.1:9880/deepseek` makes PI wrongly assume the endpoint accepts the
 * OpenAI `developer` system-prompt role — DeepSeek's API rejects it with HTTP 400 (empty output).
 * We re-assert the lost flags here, keyed by PI provider name (the override preserves the name).
 * Add a row here if another gateway-routed provider exhibits the same URL-detection loss.
 */
const PROVIDER_COMPAT_OVERRIDES: Record<string, Record<string, unknown>> = {
  deepseek: { supportsDeveloperRole: false },
};

export interface WriteProvidersOpts {
  /** Target file path. Required: an implicit host default is exactly the ambient reach §13 A3
   *  forbids, so every caller states where the catalog lands. */
  modelsPath: string;
}

/**
 * Atomic-write models.json with multi-provider baseUrl overrides. Each provider entry has a
 * `baseUrl` pointing to `<gatewayUrl><basePath>`; no apiKey is written so PI resolves credentials
 * from auth.json (or environment variables) per PI's auth resolution order.
 *
 * Called by PIAdapter.spawn() — sole writer of this file, no other code path touches it.
 */
export function writeProvidersConfig(
  providers: ProviderOverride[],
  gatewayUrl: string,
  opts: WriteProvidersOpts,
): void {
  const targetPath = opts.modelsPath;

  const providersBlock: Record<string, Record<string, unknown>> = {};
  for (const p of providers) {
    if (p.entry) {
      providersBlock[p.name] = p.entry;
      continue;
    }
    const basePath = p.basePath ?? `/${p.name}`;
    const entry: { baseUrl: string; compat?: Record<string, unknown> } = {
      baseUrl: `${gatewayUrl}${basePath}`,
    };
    // Re-assert compat flags PI can no longer auto-detect now that baseUrl is the gateway.
    // Static table first, then per-override compat (explicit wins).
    const compat = { ...PROVIDER_COMPAT_OVERRIDES[p.name], ...p.compat };
    if (Object.keys(compat).length > 0) entry.compat = compat;
    providersBlock[p.name] = entry;
  }

  const data = { providers: providersBlock };
  const content = JSON.stringify(data, null, 2) + '\n';

  mkdirSync(path.dirname(targetPath), { recursive: true });

  // Atomic write: tmp + rename
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of orphan tmp file (rename failure case)
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Compute the set of PI providers whose baseUrl should be overridden to the gateway for a spawn.
 *
 * Design: "route through gateway" and "PI has credentials" are independent concerns. Discovery
 * (`pi --list-models`) only reports providers the user is authenticated to, but a profile may
 * legitimately route a provider through the gateway even without direct PI credentials (the
 * gateway injects managed keys). So the override set is the union of:
 *   - `discovered`        — providers PI reports creds for (credential passthrough via auth.json)
 *   - `currentProvider`   — the provider THIS spawn uses (`--provider`); it MUST be routed, always
 *
 * `gatewayPath`, when set, becomes the current provider's `basePath` (decouples the gateway route
 * from the provider name — e.g. provider "anthropic" landing on "/deepseek-anthropic"). It wins
 * over the default `/<name>` even if the current provider was also discovered.
 */
export function buildProviderOverrides(
  discovered: string[],
  currentProvider: string | null,
  gatewayPath?: string | null,
): ProviderOverride[] {
  const byName = new Map<string, ProviderOverride>();
  for (const name of discovered) {
    if (!byName.has(name)) byName.set(name, { name });
  }
  if (currentProvider) {
    byName.set(currentProvider, {
      name: currentProvider,
      ...(gatewayPath !== undefined && gatewayPath !== null ? { basePath: gatewayPath } : {}),
    });
  }
  return Array.from(byName.values());
}

/**
 * Attach user-defined provider definitions to the overrides that name them, so the catalog carries
 * a complete block for each one. Overrides without a definition (PI built-ins) are untouched.
 */
export function withCustomEntries(
  overrides: ProviderOverride[],
  definitions: Record<string, Record<string, unknown>>,
): ProviderOverride[] {
  return overrides.map((override) => {
    const entry = definitions[override.name];
    return entry ? { ...override, entry } : override;
  });
}
