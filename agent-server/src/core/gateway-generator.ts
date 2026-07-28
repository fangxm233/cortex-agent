// input:  Filesystem, YAML, and PI model discovery output
// output: Gateway discovery, merge, serialization, and validation helpers
// pos:    Generates gateway config from Claude and PI model sources
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { writeFileSync, copyFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { parse as parseDotenv } from 'dotenv';
import { createLogger } from './log.js';
import { CONFIG_DIR, GATEWAY_MANAGED_KEY_PLACEHOLDER } from './utils.js';

const log = createLogger('gateway-generator');

/**
 * Resolve the real Anthropic API key for endpoint discovery: process.env first (ignoring the
 * gateway-managed placeholder), then CONFIG_DIR/.env — the canonical key location
 * (docs/configuration.md). CLI processes (cortex init / setup-gateway) never run
 * dotenv.config, so discovery must read the file itself.
 */
function resolveAnthropicApiKey(): string | undefined {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey && envKey !== GATEWAY_MANAGED_KEY_PLACEHOLDER) return envKey;
  try {
    const fileKey = parseDotenv(readFileSync(path.join(CONFIG_DIR, '.env'), 'utf8')).ANTHROPIC_API_KEY?.trim();
    if (fileKey && fileKey !== GATEWAY_MANAGED_KEY_PLACEHOLDER) return fileKey;
  } catch { /* no .env file — fall through */ }
  return undefined;
}

// ─── Merge support types (DR: stop init clobbering hand-maintained gateway.yaml) ──

/** endpoint name → mode name → raw endpoint config object. */
export type EndpointMap = Record<string, Record<string, Record<string, unknown>>>;

/** Parsed existing gateway.yaml split into reserved top-level fields and the endpoint/mode tree. */
export interface ParsedGateway {
  /** Reserved top-level keys preserved verbatim: port, mode, status_check, auth, host, endpoint_modes, endpoints. */
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
  profile: string;
  mode: string;
  provider?: string;
  reason: string;
}

/** aistatus reserved top-level keys (mirror of node_modules/aistatus fromDict RESERVED_KEYS). */
const GATEWAY_RESERVED_KEYS = new Set(['host', 'port', 'mode', 'auth', 'status_check', 'endpoint_modes', 'endpoints']);

/** Keys that, when present directly on an endpoint value, mark it as a "flat" (single-mode) config. */
const FLAT_ENDPOINT_KEYS = ['keys', 'base_url', 'auth_style', 'passthrough', 'fallbacks', 'model_fallbacks'];

/** Synthetic mode name used to hold a flat endpoint config (aistatus assigns these to mode "default"). */
const FLAT_MODE = 'default';

// ─── Types ────────────────────────────────────────────────────────

export interface DiscoveredEndpoint {
  /** Mode key in gateway.yaml + cortex profile (e.g. "plan", "deepseek", "openai-codex") */
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
   *  known upstream URL are surfaced as profiles but skipped in gateway.yaml. */
  gatewayManaged: boolean;
}

// ─── Anthropic models (default tier) ─────────────────────────────

// Each 1M-capable model also exposes a "[1m]" variant — Claude Code's context-window suffix that
// opts the session into the 1M-token window. Haiku 4.5 is 200K-only, so it has no [1m] variant.
const ANTHROPIC_MODELS = [
  'claude-fable-5', 'claude-fable-5[1m]',
  'claude-opus-4-8', 'claude-opus-4-8[1m]',
  'claude-opus-4-7', 'claude-opus-4-7[1m]',
  'claude-opus-4-6', 'claude-opus-4-6[1m]',
  'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5',
];

// ─── PI provider → upstream URL lookup (manually maintained) ────────────────

/**
 * Map a PI built-in provider name to its real upstream URL. Used by `generateGatewayYaml` so PI
 * traffic can be routed through the gateway. Entries are sourced from PI source / docs.
 *
 * Providers absent from this table are still surfaced as cortex profiles, but no gateway endpoint
 * is generated for them (gatewayManaged=false). PI will then either fail (if the cortex spawn path
 * forces gateway routing) or direct-call the upstream (if the spawn path leaves models.json
 * untouched for that provider). See `/home/fangxin/.cortex/plan/generic-wibbling-pine.md` stage E
 * for the eventual full plumbing.
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
  // amazon-bedrock / google-vertex / azure-openai-responses / cloudflare-workers-ai use
  // env-driven URLs (region / account ID / resource name) — not safely templated here.
  // Users wanting these through the gateway must edit gateway.yaml manually.
};

// ─── Scanning: PI via `pi --list-models` ──────────────────────────

export interface PiDiscoveredModel {
  provider: string;
  model: string;
}

/**
 * Parse the table output of `pi --list-models` into structured entries.
 * Skips header row, blank lines, and the "No models available" fallback message.
 *
 * Example input:
 *   provider   model                       context  max-out  thinking  images
 *   anthropic  claude-3-5-haiku-20241022   200K     8.2K     no        yes
 *   deepseek   deepseek-v4-pro             1M       384K     yes       no
 */
export function parsePiListModelsOutput(stdout: string): PiDiscoveredModel[] {
  const lines = stdout.split('\n');
  const result: PiDiscoveredModel[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('No models available')) return [];
    // PI uses 2+ spaces between columns for alignment
    const parts = line.split(/\s{2,}/);
    if (parts.length < 2) continue;
    const [provider, model] = parts;
    if (provider === 'provider' && model === 'model') continue; // header row
    result.push({ provider, model });
  }
  return result;
}

/**
 * Discover PI providers and models by shelling out to `pi --list-models`.
 * PI is the authoritative source of model metadata — cortex does not maintain a whitelist.
 *
 * Returns an empty array on any failure (PI not installed, timeout, parse error). The init flow
 * should warn the user and tell them to `pi /login` first.
 */
function scanPIViaListModels(): PiDiscoveredModel[] {
  try {
    // PI writes the table to stderr (not stdout) — merge via `2>&1` so we can parse it.
    // Intentionally do NOT set PI_CODING_AGENT_DIR: discovery reads the user's real ~/.pi/agent/.
    const stdout = execSync('pi --list-models 2>&1', {
      timeout: 10_000,
      encoding: 'utf-8',
    });
    return parsePiListModelsOutput(stdout);
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    if (err.code === 'ENOENT') {
      log.info('PI is not installed — skipping PI provider discovery');
    } else {
      log.info(`pi --list-models failed (code=${err.code ?? err.status}): ${err.message ?? 'unknown error'}`);
    }
    return [];
  }
}

// ─── Discovery ─────────────────────────────────────────────────────

/**
 * Scan Claude Code and PI configurations and return discovered endpoints.
 *
 * @param backends - Optional filter: when provided, only discover endpoints for the listed backends
 *   (e.g. `['claude']`, `['pi']`, `['claude', 'pi']`). When omitted, all backends are discovered.
 *
 * - Claude Code plan mode: generated when 'claude' is in backends (or backends is omitted).
 * - Claude Code api mode: generated only if ANTHROPIC_API_KEY env var is set and 'claude' is included.
 * - PI providers: discovered via `pi --list-models` when 'pi' is in backends (or backends is omitted).
 *   Each provider becomes one endpoint with `mode = endpoint = provider name`. `gatewayManaged`
 *   is true only if the provider has a known upstream URL in PI_PROVIDER_UPSTREAM (otherwise profile
 *   is generated but gateway.yaml entry is skipped).
 */
export function discoverEndpoints(backends?: string[]): DiscoveredEndpoint[] {
  const endpoints: DiscoveredEndpoint[] = [];

  // ── Claude Code → Anthropic plan mode ──
  // Skip if backends filter is provided and 'claude' is not included.
  const includeClaude = !backends || backends.includes('claude');
  if (includeClaude) {
    endpoints.push({
      mode: 'plan',
      endpoint: 'anthropic',
      base_url: 'https://api.anthropic.com',
      auth_style: 'bearer',
      keys: [],
      passthrough: true,
      models: ANTHROPIC_MODELS,
      gatewayManaged: true,
    });

    // api mode — only if a REAL ANTHROPIC_API_KEY is available (the gateway-managed placeholder
    // exists solely to satisfy Claude Code's startup credential check; it is not a key)
    if (resolveAnthropicApiKey()) {
      endpoints.push({
        mode: 'api',
        endpoint: 'anthropic',
        base_url: 'https://api.anthropic.com',
        auth_style: 'anthropic',
        keys: ['$ANTHROPIC_API_KEY'],
        passthrough: true,
        models: ANTHROPIC_MODELS,
        gatewayManaged: true,
      });
    }
  }

  // ── PI → per-provider endpoints (one mode per provider) ──
  const includePi = !backends || backends.includes('pi');
  const piModels = includePi ? scanPIViaListModels() : [];
  // Group models by provider name
  const byProvider = new Map<string, string[]>();
  for (const { provider, model } of piModels) {
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(model);
  }

  for (const [provider, models] of byProvider) {
    const upstream = PI_PROVIDER_UPSTREAM[provider];
    // anthropic is already covered by the Claude Code path above (with the user's OAuth subscription
    // tier). If PI also reports anthropic, skip — Claude path is authoritative for plan mode.
    if (provider === 'anthropic') continue;

    endpoints.push({
      mode: provider,
      endpoint: provider,
      base_url: upstream?.url ?? '',
      auth_style: upstream?.auth_style ?? 'bearer',
      keys: [],
      passthrough: true,
      models,
      gatewayManaged: !!upstream,
    });
  }

  return endpoints;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── YAML Generation ───────────────────────────────────────────────

/**
 * Generate gateway.yaml content from discovered endpoints.
 * Outputs a formatted YAML string with comments explaining each mode.
 *
 * Endpoints with gatewayManaged=false are skipped (their profile still exists in profiles.json,
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
    lines.push('# These providers appear in profiles.json but are not routed through this gateway.');
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write gateway.yaml to the specified path or ~/.aistatus/gateway.yaml.
 * If file already exists and outputDir is not specified, backs it up as gateway.yaml.bak before overwriting.
 * When outputDir is provided, writes to <outputDir>/gateway.yaml without backup.
 *
 * @deprecated Use writeMergedGatewayYaml — full overwrite drops hand-maintained custom modes.
 */
export function writeGatewayYaml(yamlContent: string, outputDir?: string): string {
  const configDir = outputDir || path.join(os.homedir(), '.aistatus');
  const configPath = path.join(configDir, 'gateway.yaml');

  // Backup existing file (only for default path)
  if (!outputDir && existsSync(configPath)) {
    const backupPath = configPath + '.bak';
    try {
      copyFileSync(configPath, backupPath);
      log.info(`Backed up existing gateway.yaml to ${backupPath}`);
    } catch (e) {
      log.warn(`Failed to backup existing gateway.yaml: ${(e as Error).message}`);
    }
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, yamlContent, 'utf-8');
  log.info(`Written gateway.yaml to ${configPath}`);

  return configPath;
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
 * Add-only at the (endpoint, mode) PAIR level (mirrors mergeProfilesJson overwrite=false): a pair
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

  return { endpoints: merged, top, preservedCustom, droppedFromDiscovery };
}

/** Serialize a merged gateway config back to YAML (re-serializes; inline comments in custom blocks are not retained). */
export function serializeGatewayYaml(result: MergeGatewayResult): string {
  const obj: Record<string, unknown> = {};
  // Ordered, well-known top-level fields first.
  obj.port = result.top.port ?? 9880;
  obj.mode = result.top.mode;
  obj.status_check = result.top.status_check ?? true;
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
  const configDir = outputDir || path.join(os.homedir(), '.aistatus');
  const configPath = path.join(configDir, 'gateway.yaml');

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

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, content, 'utf-8');
  log.info(`Written merged gateway.yaml to ${configPath}`);

  return { path: configPath, result };
}

/**
 * Validate that every profile (and its fallback chain) in profiles.json references a gateway mode
 * that actually exists in the merged endpoint map. Pure + non-fatal — returns the list of problems
 * so the caller can warn loudly. This is what catches the `400 Unknown mode: <x>` class of bug.
 */
export function validateProfilesAgainstGateway(
  mergedEndpoints: EndpointMap,
  profilesConfigDir?: string,
): GatewayValidationIssue[] {
  const profilesPath = profilesConfigDir
    ? path.join(profilesConfigDir, 'profiles.json')
    : path.join(os.homedir(), '.cortex', 'config', 'profiles.json');

  let parsed: unknown;
  try {
    if (!existsSync(profilesPath)) return [];
    parsed = JSON.parse(readFileSync(profilesPath, 'utf-8'));
  } catch (e) {
    log.warn(`Failed to read profiles.json for validation: ${(e as Error).message}`);
    return [];
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.profiles)) return [];

  const modeExistsAnywhere = (mode: string): boolean =>
    Object.values(mergedEndpoints).some((modes) => mode in modes);

  const issues: GatewayValidationIssue[] = [];

  const checkEntry = (entry: Record<string, unknown>, label: string): void => {
    const backend = typeof entry.backend === 'string' ? entry.backend : undefined;
    const mode = typeof entry.mode === 'string' ? entry.mode : undefined;
    const provider = typeof entry.provider === 'string' ? entry.provider : undefined;

    // No mode → PI uses direct /<provider> routing (no gateway mode indirection); nothing to check.
    if (!mode) return;

    let endpoint: string | undefined;
    if (backend === 'claude') endpoint = 'anthropic';
    else if (backend === 'pi') endpoint = provider;
    else return; // Unknown backends do not route through gateway modes here.

    if (backend === 'pi' && !provider) {
      issues.push({ profile: label, mode, reason: `pi profile is missing a provider (cannot resolve gateway endpoint)` });
      return;
    }

    if (!endpoint || !mergedEndpoints[endpoint]?.[mode]) {
      const reason = !modeExistsAnywhere(mode)
        ? `mode "${mode}" is not configured in gateway.yaml`
        : `endpoint "${endpoint}" is not configured under mode "${mode}"`;
      issues.push({ profile: label, mode, provider, reason });
    }
  };

  for (const [name, profileVal] of Object.entries(parsed.profiles as Record<string, unknown>)) {
    if (!isPlainObject(profileVal)) continue;
    checkEntry(profileVal, name);
    const fallback = profileVal.fallback;
    if (Array.isArray(fallback)) {
      fallback.forEach((fb, i) => {
        if (isPlainObject(fb)) checkEntry(fb, `${name} (fallback #${i + 1})`);
      });
    }
  }

  return issues;
}

/**
 * Run discovery and return the YAML string (without writing to disk).
 * Useful for dry-run / preview.
 */
export function dryRunGatewayYaml(): string {
  const endpoints = discoverEndpoints();
  if (endpoints.length === 0) {
    return '# No backends discovered. Log into Claude Code and/or PI first.\n';
  }
  return generateGatewayYaml(endpoints);
}
