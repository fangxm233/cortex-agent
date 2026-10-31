import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import * as path from 'path';
import { isCustomProviderEntry } from './custom-catalog.js';
import { CHATGPT_SIGN_IN_COMPAT, CHATGPT_SIGN_IN_PROVIDER } from './chatgpt-signin.js';
import { piModelsPath } from './defaults.js';

/**
 * The provider catalog a PI agent dir runs with, as the host hands it over. PI's built-in
 * providers that appear nowhere here keep their own URLs and credentials; a block naming a
 * built-in provider without `api` overrides only its base URL (PI docs/models.md §Overriding
 * Built-in Providers), and a block with `api` and `models` defines a provider PI does not know.
 */
export interface PiProviderCatalog {
  providers: Record<string, Record<string, unknown>>;
  /** Keys that must win over PI's own credential store for the same provider. */
  runtimeKeys: Record<string, string>;
}

/** Beside models.json: the per-provider keys every runtime over this agent dir installs first. */
const RUNTIME_KEYS_FILE = 'runtime-keys.json';

/**
 * Compat flags PI can no longer detect once a built-in provider's base URL is not the vendor's:
 * DeepSeek's developer-role and max-tokens handling are keyed on its official host. Provider-level
 * compat overlays both built-in and refreshed model catalogs, so a later models-store refresh
 * cannot drop them.
 */
const PROVIDER_COMPAT_OVERRIDES: Record<string, Record<string, unknown>> = {
  deepseek: {
    supportsDeveloperRole: false,
    maxTokensField: 'max_completion_tokens',
  },
};

/**
 * A base-URL override hides the vendor's host from PI, so PI cannot apply what it keys on that host:
 * the fixed per-provider flags above, and — for Sign in with ChatGPT on `openai` — the two request
 * capabilities that login rejects. A full definition already says what it needs.
 */
function withOverrideCompat(
  name: string,
  block: Record<string, unknown>,
  oauthProviders: ReadonlySet<string>,
): Record<string, unknown> {
  const definition: boolean = isCustomProviderEntry(block);
  if (definition) return block;
  const signIn = name === CHATGPT_SIGN_IN_PROVIDER && oauthProviders.has(name) ? CHATGPT_SIGN_IN_COMPAT : {};
  const own = block.compat && typeof block.compat === 'object' ? block.compat as Record<string, unknown> : {};
  const compat = { ...PROVIDER_COMPAT_OVERRIDES[name], ...own, ...signIn };
  return Object.keys(compat).length > 0 ? { ...block, compat } : block;
}

/** The `providers` block written for `catalog`, with the compat flags each override needs. */
export function catalogProviderBlocks(
  catalog: PiProviderCatalog,
  oauthProviders: ReadonlySet<string>,
): Record<string, Record<string, unknown>> {
  const blocks: Record<string, Record<string, unknown>> = {};
  for (const [name, block] of Object.entries(catalog.providers)) {
    blocks[name] = withOverrideCompat(name, block, oauthProviders);
  }
  return blocks;
}

/** Owner-only atomic write: both files may carry provider keys. */
function writeOwnerOnly(targetPath: string, content: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, targetPath);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Write the agent dir's models.json and runtime keys from `catalog`. Always written, even empty:
 * a catalog left from an earlier run would keep routing a provider the host no longer configures.
 */
export function writeProviderCatalog(
  catalog: PiProviderCatalog,
  opts: { agentDir: string; oauthProviders: ReadonlySet<string> },
): void {
  const providers = catalogProviderBlocks(catalog, opts.oauthProviders);
  writeOwnerOnly(piModelsPath(opts.agentDir), `${JSON.stringify({ providers }, null, 2)}\n`);
  writeOwnerOnly(path.join(opts.agentDir, RUNTIME_KEYS_FILE), `${JSON.stringify(catalog.runtimeKeys, null, 2)}\n`);
}

/** The runtime keys written beside the agent dir's catalog; empty when there are none. */
export function readRuntimeKeys(agentDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(agentDir, RUNTIME_KEYS_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, key]) => typeof key === 'string' && key.length > 0),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

interface RuntimeKeySink {
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
}

/** Install the agent dir's runtime keys on a freshly created model runtime. */
export async function applyRuntimeKeys(runtime: RuntimeKeySink, agentDir: string): Promise<void> {
  for (const [provider, key] of Object.entries(readRuntimeKeys(agentDir))) {
    await runtime.setRuntimeApiKey(provider, key);
  }
}
