import { copyFileSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  anthropicModelDiscovery, anthropicModelIds, type DiscoveredAnthropicModel,
} from './anthropic-model-discovery.js';
import { atomicWriteSync } from './atomic-write.js';
import { ANTHROPIC_MODELS } from './anthropic-models.js';
import { claudeOwnsOAuthCredential, resolveAnthropicApiKey } from './claude-credentials.js';
import { createLogger } from './log.js';
import { AISTATUS_DIR, CONFIG_DIR } from './paths.js';
import { loadPiDefaultModels, loadPiSdk, piUserAuthPath, piUserModelsPath } from './pi-sdk.js';

const log = createLogger('gateway-generator');

// ─── Merge support types (DR: stop init clobbering hand-maintained gateway.yaml) ──

/** endpoint name → mode name → raw endpoint config object. */
export type EndpointMap = Record<string, Record<string, Record<string, unknown>>>;

/** Parsed existing gateway.yaml split into reserved top-level fields and the endpoint/mode tree. */
export interface ParsedGateway {
  /** Reserved top-level keys preserved verbatim, including max_body_size_mb. */
  top: Record<string, unknown>;
  endpoints: EndpointMap;
}

export interface MergeGatewayResult {
  endpoints: EndpointMap;
  top: Record<string, unknown>;
  /** Existing (endpoint, mode) pairs NOT produced by this discovery — kept verbatim. */
  preservedCustom: Array<{ endpoint: string; mode: string }>;
  /** Subset of preservedCustom that looks like it should have been rediscovered (i.e. not
   *  anthropic/plan|api) — surfaced as a warning so a failed `pi --list-models` is visible. */
  droppedFromDiscovery: Array<{ endpoint: string; mode: string }>;
}

export interface GatewayValidationIssue {
  model: string;
  mode: string;
  provider?: string;
  reason: string;
}

/** aistatus reserved top-level keys (mirror of node_modules/aistatus fromDict RESERVED_KEYS). */
const GATEWAY_RESERVED_KEYS = new Set([
  'host', 'port', 'mode', 'auth', 'status_check', 'max_body_size_mb', 'endpoint_modes', 'endpoints',
]);
const DEFAULT_MAX_BODY_SIZE_MB = 100;

/** Keys that, when present directly on an endpoint value, mark it as a "flat" (single-mode) config. */
const FLAT_ENDPOINT_KEYS = ['keys', 'base_url', 'auth_style', 'passthrough', 'fallbacks', 'model_fallbacks'];

/** Synthetic mode name used to hold a flat endpoint config (aistatus assigns these to mode "default"). */
const FLAT_MODE = 'default';

// ─── Types ────────────────────────────────────────────────────────

export interface DiscoveredEndpoint {
  /** Mode key in gateway.yaml (e.g. "plan", "deepseek", "openai-codex") */
  mode: string;
  /** Endpoint group name (e.g. "anthropic", "deepseek", "openai-codex") */
  endpoint: string;
  base_url: string;
  auth_style: string;
  keys: string[];
  passthrough: boolean;
  /** Model IDs known to be available for this endpoint */
  models: string[];
  /** Whether gateway.yaml should render an endpoint section for this entry. PI providers without a
   *  known upstream URL are surfaced as models but skipped in gateway.yaml. */
  gatewayManaged: boolean;
  /** The model this endpoint recommends when nothing is chosen — PI's per-provider default, or the
   *  newest Claude flagship. Always one of `models`; absent when the endpoint has no preference. */
  defaultModel?: string;
}

// ─── PI provider → upstream URL lookup (manually maintained) ────────────────

/**
 * Map a PI built-in provider name to its real upstream URL. Used by `generateGatewayYaml` so PI
 * traffic can be routed through the gateway. Entries are sourced from PI source / docs.
 *
 * Providers absent from this table are still surfaced as models, but no gateway endpoint
 * is generated for them (gatewayManaged=false). PI will then either fail (if the cortex spawn path
 * forces gateway routing) or direct-call the upstream (if the spawn path leaves models.json
 * untouched for that provider). Full provider plumbing remains future work.
 */
const PI_PROVIDER_UPSTREAM: Record<string, { url: string; auth_style: string }> = {
  // Anthropic-protocol providers (PI's `api: anthropic-messages`)
  anthropic: { url: 'https://api.anthropic.com', auth_style: 'bearer' },
  fireworks: { url: 'https://api.fireworks.ai/inference', auth_style: 'bearer' },
  'github-copilot': { url: 'https://api.individual.githubcopilot.com', auth_style: 'bearer' },
  'kimi-coding': { url: 'https://api.kimi.com/coding', auth_style: 'bearer' },
  minimax: { url: 'https://api.minimax.io/anthropic', auth_style: 'bearer' },
  'minimax-cn': { url: 'https://api.minimaxi.com/anthropic', auth_style: 'bearer' },
  opencode: { url: 'https://opencode.ai/zen', auth_style: 'bearer' },
  'vercel-ai-gateway': { url: 'https://ai-gateway.vercel.sh', auth_style: 'bearer' },

  // OpenAI-completions / OpenAI-responses providers
  cerebras: { url: 'https://api.cerebras.ai/v1', auth_style: 'bearer' },
  deepseek: { url: 'https://api.deepseek.com', auth_style: 'bearer' },
  groq: { url: 'https://api.groq.com/openai/v1', auth_style: 'bearer' },
  huggingface: { url: 'https://router.huggingface.co/v1', auth_style: 'bearer' },
  mistral: { url: 'https://api.mistral.ai', auth_style: 'bearer' },
  openai: { url: 'https://api.openai.com/v1', auth_style: 'bearer' },
  'opencode-go': { url: 'https://opencode.ai/zen/go/v1', auth_style: 'bearer' },
  openrouter: { url: 'https://openrouter.ai/api/v1', auth_style: 'bearer' },
  xai: { url: 'https://api.x.ai/v1', auth_style: 'bearer' },
  zai: { url: 'https://api.z.ai/api/coding/paas/v4', auth_style: 'bearer' },

  // OAuth subscription providers (PI manages OAuth refresh; gateway transparently passthrough)
  'openai-codex': { url: 'https://chatgpt.com/backend-api', auth_style: 'bearer' },
  'google-gemini-cli': { url: 'https://cloudcode-pa.googleapis.com', auth_style: 'bearer' },
  'google-antigravity': { url: 'https://daily-cloudcode-pa.sandbox.googleapis.com', auth_style: 'bearer' },

  // Other built-ins
  google: { url: 'https://generativelanguage.googleapis.com/v1beta', auth_style: 'bearer' },
  // amazon-bedrock / google-vertex / azure / cloudflare-workers-ai use
  // env-driven URLs (region / account ID / resource name) — not safely templated here.
  // Users wanting these through the gateway must edit gateway.yaml manually.
};

// ─── Scanning: PI via the bundled SDK model runtime ───────────────

export interface PiDiscoveredModel {
  provider: string;
  model: string;
  /** Thinking levels this specific model accepts, ascending. Empty means the model takes none (a
   *  non-reasoning model). Undefined means the scan could not tell — callers fall back to the
   *  backend-wide set rather than hiding levels PI would have honoured. */
  thinkingLevels?: string[];
}

/** The ascending thinking-level ladder PI's own selector walks. */
const PI_THINKING_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The two fields of a PI model that decide its thinking levels. Read structurally because the SDK
 *  re-exports neither the `Model` type's full shape nor the helper that consumes them. */
interface PiModelThinkingShape {
  reasoning?: unknown;
  thinkingLevelMap?: Record<string, unknown>;
}

/**
 * The thinking levels one PI model accepts.
 *
 * Mirrors pi-ai's own `getSupportedThinkingLevels`, which `@earendil-works/pi-coding-agent` does not
 * re-export: a non-reasoning model takes none; otherwise every ladder rung survives unless the
 * model's `thinkingLevelMap` maps it to null, and the top two rungs (`xhigh`, `max`) additionally
 * require an explicit mapping. Returns undefined when neither field is present, so the caller can
 * tell "no levels" from "could not tell".
 *
 * Re-check against pi-ai when the PI SDK is upgraded.
 */
function piModelThinkingLevels(model: unknown): string[] | undefined {
  const shape = model as PiModelThinkingShape | null;
  if (!shape || typeof shape !== 'object') return undefined;
  if (!('reasoning' in shape) && !('thinkingLevelMap' in shape)) return undefined;
  if (!shape.reasoning) return [];
  const map = shape.thinkingLevelMap;
  return PI_THINKING_LADDER.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
  });
}

/**
 * List the PI models whose provider has usable auth, exactly as `pi --list-models` would report
 * them: a fresh ModelRuntime over PI's own ~/.pi/agent/{auth,models}.json (never Cortex's private
 * PI agent dir), builtin catalog only, no network refresh. PI is the authoritative source of model
 * metadata — cortex does not maintain a whitelist. Rejects when the SDK cannot be loaded or the
 * runtime fails to initialize.
 */
export async function scanPiAvailableModels(): Promise<PiDiscoveredModel[]> {
  const { ModelRuntime } = await loadPiSdk();
  const runtime = await ModelRuntime.create({
    authPath: piUserAuthPath(),
    modelsPath: piUserModelsPath(),
    allowModelNetwork: false,
  });
  const models = await runtime.getAvailable();
  return models.map((model) => {
    const thinkingLevels = piModelThinkingLevels(model);
    // Omitted rather than set to undefined: "the scan could not tell" is the absence of the field.
    return { provider: model.provider, model: model.id, ...(thinkingLevels ? { thinkingLevels } : {}) };
  });
}

/** Endpoint discovery treats any PI scan failure as "no PI providers" and logs the reason. */
async function scanPiForEndpoints(): Promise<PiDiscoveredModel[]> {
  try {
    return await scanPiAvailableModels();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.info(`PI model scan failed — skipping PI provider discovery: ${message}`);
    return [];
  }
}

// ─── Discovery ─────────────────────────────────────────────────────

export interface DiscoverEndpointsOptions {
  /** The Anthropic models this account can reach. Injected by tests so endpoint discovery never
   *  depends on a live credential; defaults to the host's cached model discovery. */
  anthropicModels?: () => Promise<DiscoveredAnthropicModel[]>;
  /** Whether Claude Code holds a subscription (OAuth) login here. Defaults to probing its stores. */
  claudeSubscription?: () => boolean;
  /** PI's provider → default model table. Defaults to the table shipped with the PI SDK. */
  piDefaultModels?: () => Promise<Readonly<Record<string, string>>>;
}

/**
 * Scan Claude Code and PI configurations and return the endpoints this host can reach right now.
 *
 * @param backends - Optional filter: when provided, only discover endpoints for the listed backends
 *   (e.g. `['claude']`, `['pi']`, `['claude', 'pi']`). When omitted, all backends are discovered.
 *
 * Claude endpoints come first, then PI providers in PI's order; model recommendations follow that order.
 * - Claude Code plan mode: only when Claude Code holds a subscription login.
 * - Claude Code api mode: only when a real ANTHROPIC_API_KEY is available.
 * - PI providers: those PI reports usable auth for. Each provider becomes one endpoint with
 *   `mode = endpoint = provider name`. `gatewayManaged` is true only if the provider has a known
 *   upstream URL in PI_PROVIDER_UPSTREAM (otherwise the model is discovered but gateway.yaml entry is
 *   skipped).
 */
export async function discoverEndpoints(
  backends?: string[],
  options: DiscoverEndpointsOptions = {},
): Promise<DiscoveredEndpoint[]> {
  const includes = (backend: string) => !backends || backends.includes(backend);
  const claude = includes('claude') ? await discoverClaudeEndpoints(options) : [];
  const pi = includes('pi') ? await discoverPiEndpoints(options) : [];
  return [...claude, ...pi];
}

function anthropicEndpoint(
  mode: 'plan' | 'api',
  models: string[],
  defaultModel: string | undefined,
): DiscoveredEndpoint {
  const api = mode === 'api';
  return {
    mode,
    endpoint: 'anthropic',
    base_url: 'https://api.anthropic.com',
    auth_style: api ? 'anthropic' : 'bearer',
    keys: api ? ['$ANTHROPIC_API_KEY'] : [],
    passthrough: true,
    models: [...models],
    gatewayManaged: true,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

/**
 * Claude Code's endpoints, each present only when its credential is: an endpoint nobody logged
 * into would otherwise become the default selection and lock the user out of the one they did log
 * into (merges never overwrite an existing plan/execute).
 */
async function discoverClaudeEndpoints(options: DiscoverEndpointsOptions): Promise<DiscoveredEndpoint[]> {
  const subscription = (options.claudeSubscription ?? (() => claudeOwnsOAuthCredential()))();
  // The gateway-managed placeholder exists solely to satisfy Claude Code's startup credential
  // check; it is not a key, and resolveAnthropicApiKey ignores it.
  const apiKey = resolveAnthropicApiKey() !== null;
  if (!subscription && !apiKey) return [];
  // The status checker reads this list to decide which models to probe for degradation; routing
  // does not consult it, so a model missing here still answers. Discovery therefore only widens
  // what gets watched, and a host whose model fetch fails keeps the shipped table.
  const readAnthropicModels = options.anthropicModels ?? (() => anthropicModelDiscovery.ensure());
  const models = anthropicModelIds(await readAnthropicModels());
  // The shipped table is ordered newest flagship first; the API list is newest release first.
  const defaultModel = ANTHROPIC_MODELS.find(id => models.includes(id)) ?? models[0];
  const endpoints: DiscoveredEndpoint[] = [];
  if (subscription) endpoints.push(anthropicEndpoint('plan', models, defaultModel));
  if (apiKey) endpoints.push(anthropicEndpoint('api', models, defaultModel));
  return endpoints;
}

function piEndpoint(provider: string, models: string[], defaultModel: string | undefined): DiscoveredEndpoint {
  const upstream = PI_PROVIDER_UPSTREAM[provider];
  return {
    mode: provider,
    endpoint: provider,
    base_url: upstream?.url ?? '',
    auth_style: upstream?.auth_style ?? 'bearer',
    keys: [],
    passthrough: true,
    models,
    gatewayManaged: !!upstream,
    ...(defaultModel && models.includes(defaultModel) ? { defaultModel } : {}),
  };
}

/** One endpoint per PI provider with usable auth, in the order PI reports them. */
async function discoverPiEndpoints(options: DiscoverEndpointsOptions): Promise<DiscoveredEndpoint[]> {
  const byProvider = new Map<string, string[]>();
  for (const { provider, model } of await scanPiForEndpoints()) {
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(model);
  }
  // anthropic is covered by the Claude Code path (with the user's OAuth subscription tier). If PI
  // also reports anthropic, skip — the Claude path is authoritative for plan mode.
  byProvider.delete('anthropic');
  if (byProvider.size === 0) return [];
  const defaults = await (options.piDefaultModels ?? (() => loadPiDefaultModels()))();
  return [...byProvider].map(([provider, models]) => piEndpoint(provider, models, defaults[provider]));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── YAML Generation ───────────────────────────────────────────────

/**
 * Generate gateway.yaml content from discovered endpoints.
 * Outputs a formatted YAML string with comments explaining each mode.
 *
 * Endpoints with gatewayManaged=false are skipped (their models still exist in models.json,
 * but gateway.yaml has no entry for them — PI traffic to those providers is currently direct).
 */
export function generateGatewayYaml(endpoints: DiscoveredEndpoint[], defaultMode?: string): string {
  const renderable = endpoints.filter(e => e.gatewayManaged !== false);

  // Group renderable endpoints by endpoint name (e.g., "anthropic", "deepseek")
  const byEndpoint: Record<string, DiscoveredEndpoint[]> = {};
  for (const ep of renderable) {
    (byEndpoint[ep.endpoint] ||= []).push(ep);
  }

  const lines: string[] = [];
  lines.push('# aistatus gateway — auto-generated by cortex init');
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('#');
  lines.push('# Per-mode routing: each mode maps to an endpoint + auth config.');
  lines.push('# Managed keys are used first (with round-robin on 429/5xx),');
  lines.push('# then passthrough of the caller\'s own key when passthrough: true.');
  lines.push('#');
  lines.push('# Docs: https://aistatus.cc/docs');
  lines.push('');

  // Determine default mode (first renderable endpoint, falling back to all endpoints)
  const activeMode = defaultMode || renderable[0]?.mode || endpoints[0]?.mode || 'api';

  // Collect all renderable modes for the comment
  const allModes = renderable.map(e => e.mode).filter((v, i, a) => a.indexOf(v) === i);
  lines.push(`port: 9880`);
  lines.push(`mode: ${activeMode}${allModes.length > 0 ? `  # active billing mode: ${allModes.join(' | ')}` : ''}`);
  lines.push(`status_check: true`);
  lines.push(`max_body_size_mb: ${DEFAULT_MAX_BODY_SIZE_MB}  # buffered request limit in MiB`);

  for (const [epName, eps] of Object.entries(byEndpoint)) {
    lines.push('');
    lines.push(`${epName}:`);
    for (const ep of eps) {
      // Determine provider label for the comment
      const providerLabel = ep.mode === 'plan' ? 'Anthropic Claude (OAuth passthrough, billed via subscription)' :
        ep.mode === 'api' ? 'Anthropic Claude (API key, billed via API credits)' :
        `${capitalize(ep.mode)} (PI-managed auth, routed through gateway)`;
      lines.push(`  # ── ${providerLabel} ──`);
      lines.push(`  ${ep.mode}:`);
      lines.push(`    base_url: ${ep.base_url}`);
      lines.push(`    auth_style: ${ep.auth_style}`);

      if (ep.keys.length > 0) {
        lines.push(`    keys:`);
        for (const key of ep.keys) {
          lines.push(`      - ${key}`);
        }
      } else {
        lines.push(`    # No managed keys — ${ep.passthrough ? 'caller key passthrough' : 'waiting for key configuration'}`);
      }
      if (ep.passthrough && ep.keys.length > 0) {
        lines.push(`    passthrough: true`);
      }
    }
  }

  // Footer: list any PI providers we discovered but couldn't route (gatewayManaged=false)
  const skipped = endpoints.filter(e => e.gatewayManaged === false);
  if (skipped.length > 0) {
    lines.push('');
    lines.push('# Skipped (no known upstream URL in PI_PROVIDER_UPSTREAM):');
    for (const s of skipped) {
      lines.push(`#   ${s.mode} (${s.models.length} model${s.models.length === 1 ? '' : 's'})`);
    }
    lines.push('# These providers appear in models.json but are not routed through this gateway.');
  }

  lines.push('');
  return lines.join('\n');
}

// ─── Merge-aware generation (preserve hand-maintained modes) ──────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isFlatEndpointConfig(v: Record<string, unknown>): boolean {
  return FLAT_ENDPOINT_KEYS.some((k) => k in v);
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Parse an existing gateway.yaml into reserved top-level fields + the endpoint/mode tree.
 * Returns null if the file is absent or unparseable (caller degrades to full generation).
 */
export function readGatewayYaml(filePath: string): ParsedGateway | null {
  if (!existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = yamlParse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    log.warn(`Failed to parse existing gateway.yaml (${filePath}): ${(e as Error).message} — regenerating from scratch`);
    return null;
  }
  if (!isPlainObject(raw)) return null;

  const top: Record<string, unknown> = {};
  const endpoints: EndpointMap = {};
  for (const [key, val] of Object.entries(raw)) {
    if (GATEWAY_RESERVED_KEYS.has(key)) {
      top[key] = val;
      continue;
    }
    if (!isPlainObject(val)) continue; // ignore stray scalars
    if (isFlatEndpointConfig(val)) {
      endpoints[key] ??= {};
      endpoints[key][FLAT_MODE] = val;
      continue;
    }
    for (const [modeName, modeVal] of Object.entries(val)) {
      if (!isPlainObject(modeVal)) continue;
      endpoints[key] ??= {};
      endpoints[key][modeName] = modeVal;
    }
  }
  return { top, endpoints };
}

/** Build an endpoint/mode tree from freshly discovered endpoints (gatewayManaged only). */
export function discoveredToEndpointMap(endpoints: DiscoveredEndpoint[]): EndpointMap {
  const map: EndpointMap = {};
  for (const ep of endpoints) {
    if (ep.gatewayManaged === false) continue;
    const cfg: Record<string, unknown> = { base_url: ep.base_url, auth_style: ep.auth_style };
    if (ep.keys.length > 0) {
      cfg.keys = [...ep.keys];
      if (ep.passthrough) cfg.passthrough = true;
    }
    map[ep.endpoint] ??= {};
    map[ep.endpoint][ep.mode] = cfg;
  }
  return map;
}

/**
 * Merge freshly discovered endpoints over an existing gateway config.
 *
 * Add-only at the (endpoint, mode) PAIR level (preserving existing operator choices): a pair
 * absent from the existing file is added from discovery; any pair that already exists is preserved
 * verbatim — its base_url, auth_style and (critically) managed keys are never clobbered. This both
 * fixes the original bug (a missing mode gets added) and protects hand-customized routes, e.g. a
 * `deepseek` mode pointed at a private relay with a secret key, even though `pi --list-models`
 * reports the canonical upstream for that provider. A failed/empty discovery therefore can never
 * drop or alter previously-configured modes. To intentionally update an existing route's URL/keys,
 * edit gateway.yaml directly.
 */
export function mergeGatewayConfig(
  discovered: DiscoveredEndpoint[],
  existing: ParsedGateway | null,
  defaultMode?: string,
): MergeGatewayResult {
  const disc = discoveredToEndpointMap(discovered);
  const merged: EndpointMap = existing ? deepCopy(existing.endpoints) : {};

  const preservedCustom: Array<{ endpoint: string; mode: string }> = [];
  const droppedFromDiscovery: Array<{ endpoint: string; mode: string }> = [];

  // Classify existing pairs against the fresh discovery set (for reporting only — nothing is
  // overwritten). A pair not present in this discovery is "custom"; if it also isn't a Claude
  // builtin (anthropic/plan|api), surface it as droppedFromDiscovery so a failed/under-reporting
  // `pi --list-models` is visible rather than silently keeping stale routes.
  for (const [endpoint, modes] of Object.entries(merged)) {
    for (const mode of Object.keys(modes)) {
      const isDiscoveryOwned = !!disc[endpoint]?.[mode];
      if (!isDiscoveryOwned) {
        preservedCustom.push({ endpoint, mode });
        const isClaudeBuiltin = endpoint === 'anthropic' && (mode === 'plan' || mode === 'api');
        if (!isClaudeBuiltin) droppedFromDiscovery.push({ endpoint, mode });
      }
    }
  }

  // Add-only: fill in pairs discovery found that aren't already present. Existing pairs (incl. their
  // keys/base_url) are left untouched.
  for (const [endpoint, modes] of Object.entries(disc)) {
    merged[endpoint] ??= {};
    for (const [mode, cfg] of Object.entries(modes)) {
      if (!merged[endpoint][mode]) merged[endpoint][mode] = cfg;
    }
  }

  // Resolve active billing mode: explicit override → existing-still-valid → first discovered → 'api'.
  const availableModes = new Set<string>();
  for (const modes of Object.values(merged)) for (const m of Object.keys(modes)) availableModes.add(m);
  const existingMode = typeof existing?.top.mode === 'string' ? (existing.top.mode as string) : undefined;
  const firstDiscovered = discovered.find((e) => e.gatewayManaged !== false)?.mode;
  const activeMode = defaultMode && availableModes.has(defaultMode)
    ? defaultMode
    : existingMode && availableModes.has(existingMode)
      ? existingMode
      : firstDiscovered && availableModes.has(firstDiscovered)
        ? firstDiscovered
        : (availableModes.values().next().value ?? 'api');

  const top: Record<string, unknown> = existing ? deepCopy(existing.top) : {};
  top.port = top.port ?? 9880;
  top.mode = activeMode;
  top.status_check = top.status_check ?? true;
  top.max_body_size_mb = top.max_body_size_mb ?? DEFAULT_MAX_BODY_SIZE_MB;

  return { endpoints: merged, top, preservedCustom, droppedFromDiscovery };
}

/** Serialize a merged gateway config back to YAML (re-serializes; inline comments in custom blocks are not retained). */
export function serializeGatewayYaml(result: MergeGatewayResult): string {
  const obj: Record<string, unknown> = {};
  // Ordered, well-known top-level fields first.
  obj.port = result.top.port ?? 9880;
  obj.mode = result.top.mode;
  obj.status_check = result.top.status_check ?? true;
  obj.max_body_size_mb = result.top.max_body_size_mb ?? DEFAULT_MAX_BODY_SIZE_MB;
  if (result.top.host !== undefined) obj.host = result.top.host;
  if (result.top.auth !== undefined) obj.auth = result.top.auth;
  if (result.top.endpoint_modes !== undefined) obj.endpoint_modes = result.top.endpoint_modes;
  if (result.top.endpoints !== undefined) obj.endpoints = result.top.endpoints;

  for (const [endpoint, modes] of Object.entries(result.endpoints)) {
    const modeNames = Object.keys(modes);
    // Flat endpoint: only the synthetic `default` mode → emit config directly under the endpoint.
    if (modeNames.length === 1 && modeNames[0] === FLAT_MODE) {
      obj[endpoint] = modes[FLAT_MODE];
    } else {
      obj[endpoint] = modes;
    }
  }

  const header = [
    '# aistatus gateway — managed by cortex (merge mode).',
    `# Generated: ${new Date().toISOString()}`,
    '#',
    '# `cortex init` / `cortex setup-gateway` ADD newly discovered modes; existing modes and their',
    '# keys are preserved as-is (never overwritten). Edit a route here to change its URL/keys.',
    '# NOTE: inline comments inside existing blocks are not retained across regeneration.',
    '#',
    '# Docs: https://aistatus.cc/docs',
    '',
  ].join('\n');

  return header + yamlStringify(obj, { lineWidth: 0 });
}

/**
 * Read existing gateway.yaml, merge discovery over it, and write the result. Always backs up an
 * existing file to .bak first (including when outputDir is given, since merge now touches real data).
 */
export function writeMergedGatewayYaml(
  discovered: DiscoveredEndpoint[],
  outputDir?: string,
  defaultMode?: string,
): { path: string; result: MergeGatewayResult } {
  const configPath = path.join(outputDir || AISTATUS_DIR, 'gateway.yaml');

  const existing = readGatewayYaml(configPath);
  const result = mergeGatewayConfig(discovered, existing, defaultMode);
  const content = serializeGatewayYaml(result);

  if (existsSync(configPath)) {
    try {
      copyFileSync(configPath, configPath + '.bak');
      log.info(`Backed up existing gateway.yaml to ${configPath}.bak`);
    } catch (e) {
      log.warn(`Failed to backup existing gateway.yaml: ${(e as Error).message}`);
    }
  }

  atomicWriteSync(configPath, content);
  log.info(`Written merged gateway.yaml to ${configPath}`);

  return { path: configPath, result };
}

/**
 * Check the default's selected route and whether each favorite has an available endpoint route.
 */
export function validateModelsAgainstGateway(
  mergedEndpoints: EndpointMap,
  configDir: string = CONFIG_DIR,
): GatewayValidationIssue[] {
  const file = path.join(configDir, 'models.json');
  let parsed: unknown;
  try {
    if (!existsSync(file)) return [];
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    log.warn(`Failed to read models.json for validation: ${(error as Error).message}`);
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const entries = [parsed.default, ...(Array.isArray(parsed.favorites) ? parsed.favorites : [])];
  return entries.filter(isPlainObject).flatMap(entry => validateModelRoute(entry, mergedEndpoints));
}

function validateModelRoute(entry: Record<string, unknown>, endpoints: EndpointMap): GatewayValidationIssue[] {
  const provider = typeof entry.provider === 'string' ? entry.provider : undefined;
  const endpoint = entry.backend === 'claude' ? 'anthropic' : provider;
  const mode = typeof entry.mode === 'string' ? entry.mode : '';
  const model = String(entry.model ?? '(unknown)');
  if (!endpoint) return [{ model, mode, reason: 'PI model is missing a provider (cannot resolve gateway endpoint)' }];
  const routes = endpoints[endpoint] ?? {};
  const available = mode ? !!routes[mode] : Object.keys(routes).length > 0;
  if (available) return [];
  return [{ model, mode, provider, reason: `endpoint "${endpoint}" has no configured ${mode ? `mode "${mode}"` : 'route'} in gateway.yaml` }];
}

/**
 * Run discovery and return the YAML string (without writing to disk).
 * Useful for dry-run / preview.
 */
export async function dryRunGatewayYaml(): Promise<string> {
  const endpoints = await discoverEndpoints();
  if (endpoints.length === 0) {
    return '# No backends discovered. Log into Claude Code and/or PI first.\n';
  }
  return generateGatewayYaml(endpoints);
}
