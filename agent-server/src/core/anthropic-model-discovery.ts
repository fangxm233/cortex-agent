// input:  the Anthropic Models API (`GET /v1/models`), reached with whatever credential
//         `claude-credentials` resolves, through ANTHROPIC_BASE_URL when one is set
// output: the model ids this account can actually reach — including the "[1m]" variants — plus
//         the per-model effort ladder, cached with a TTL and a failure backoff
// pos:    core — the discovered half of the Anthropic model table. `anthropic-models.ts` stays the
//         shipped floor: every answer here is UNIONED with it, so a host with no credential, no
//         network, or a changed API keeps exactly the list it had before discovery existed.

import { ANTHROPIC_MODELS } from './anthropic-models.js';
import { CachedScan } from './cached-scan.js';
import { resolveClaudeCredential, type ClaudeCredentialDeps } from './claude-credentials.js';
import { createLogger } from './log.js';

const log = createLogger('anthropic-models');

/** Models move on the scale of weeks; a stale list costs nothing but a missing new id. */
export const ANTHROPIC_MODEL_CACHE_TTL_MS = 30 * 60_000;
/** A failed fetch — no credential, no network, 401 — is not retried for this long. */
export const ANTHROPIC_MODEL_RETRY_MS = 5 * 60_000;
/** How long a caller that needs the list (a model picker) waits for a cold fetch. */
export const ANTHROPIC_MODEL_ENSURE_TIMEOUT_MS = 8_000;
const HTTP_TIMEOUT_MS = 10_000;
/** The API pages at 20 by default; the whole first-party catalog fits well inside one page. */
const PAGE_LIMIT = 1000;
/** `max_input_tokens` at or above this earns Claude Code's "[1m]" context-window suffix. */
const MILLION_TOKEN_WINDOW = 1_000_000;
/** Claude Code's context-window suffix — an id decoration, not a model of its own. */
const LONG_CONTEXT_SUFFIX = '[1m]';
/** The effort ladder the Models API reports per model, in the order a picker should show it. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface DiscoveredAnthropicModel {
  id: string;
  displayName: string | null;
  maxInputTokens: number | null;
  /** The effort levels the API vouches for, or null when it did not say — never a narrowed guess. */
  effortLevels: string[] | null;
}

export interface FetchAnthropicModelsOptions extends ClaudeCredentialDeps {
  fetchImpl?: typeof fetch;
  /** Overrides ANTHROPIC_BASE_URL; the gateway route when the daemon has one, else direct. */
  baseUrl?: string;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The endpoint this host reaches Anthropic through: the gateway route when one is configured
 *  (same URL every turn bills to), else the API directly. */
function resolveBaseUrl(options: FetchAnthropicModelsOptions): string {
  const env = options.env ?? process.env;
  const configured = options.baseUrl?.trim() || env.ANTHROPIC_BASE_URL?.trim();
  return (configured || 'https://api.anthropic.com').replace(/\/+$/, '');
}

/** The five levels the API marked supported, or null when the model carries no effort capability
 *  at all — absent means "the backend's whole ladder", which is the honest answer for a model the
 *  API says nothing about. */
function effortLevelsOf(capabilities: unknown): string[] | null {
  if (!isRecord(capabilities)) return null;
  const effort = capabilities.effort;
  if (!isRecord(effort) || effort.supported !== true) return null;
  const levels = EFFORT_LEVELS.filter((level) => {
    const entry = effort[level];
    return isRecord(entry) && entry.supported === true;
  });
  return levels.length > 0 ? [...levels] : null;
}

function parseModel(entry: unknown): DiscoveredAnthropicModel | null {
  if (!isRecord(entry)) return null;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;
  const displayName = typeof entry.display_name === 'string' ? entry.display_name.trim() : '';
  const maxInput = entry.max_input_tokens;
  return {
    id,
    displayName: displayName || null,
    maxInputTokens: typeof maxInput === 'number' && Number.isFinite(maxInput) ? maxInput : null,
    effortLevels: effortLevelsOf(entry.capabilities),
  };
}

/**
 * One call to `GET /v1/models`. Throws on every failure — no credential, transport, non-2xx,
 * unparseable body — so the cache applies its backoff rather than pinning an empty list for a TTL.
 */
export async function fetchAnthropicModels(
  options: FetchAnthropicModelsOptions = {},
): Promise<DiscoveredAnthropicModel[]> {
  const credential = resolveClaudeCredential(options);
  if (!credential) throw new Error('no Anthropic credential available to the daemon');
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${resolveBaseUrl(options)}/v1/models?limit=${PAGE_LIMIT}`;
  const response = await doFetch(url, {
    method: 'GET',
    headers: credential.headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models request failed: HTTP ${response.status}`);
  const body: unknown = await response.json();
  const data = isRecord(body) ? body.data : null;
  if (!Array.isArray(data)) throw new Error('models response carried no data array');
  const models: DiscoveredAnthropicModel[] = [];
  for (const entry of data) {
    const model = parseModel(entry);
    if (model) models.push(model);
  }
  log.debug(`discovered ${models.length} Anthropic models via ${credential.source}`);
  return models;
}

function baseId(id: string): string {
  return id.endsWith(LONG_CONTEXT_SUFFIX) ? id.slice(0, -LONG_CONTEXT_SUFFIX.length) : id;
}

/** A dated snapshot of a shipped alias — `claude-haiku-4-5-20251001` for `claude-haiku-4-5`. */
function isSnapshotOf(candidate: string, alias: string): boolean {
  return candidate.startsWith(`${alias}-`) && /^\d{8}$/.test(candidate.slice(alias.length + 1));
}

/**
 * The picker's list: every discovered id in API order (newest first), each 1M-capable one followed
 * by its `[1m]` variant, then the shipped ids the discovery did not cover.
 *
 * The union is the point — it keeps a friendly alias the API does not list (`claude-haiku-4-5`),
 * and it keeps the whole list alive when discovery returns nothing. A shipped id is considered
 * covered by a dated snapshot of itself, so the same model never appears twice under two names.
 */
export function anthropicModelIds(
  discovered: readonly DiscoveredAnthropicModel[],
  shipped: readonly string[] = ANTHROPIC_MODELS,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const model of discovered) {
    add(model.id);
    if ((model.maxInputTokens ?? 0) >= MILLION_TOKEN_WINDOW) add(`${model.id}${LONG_CONTEXT_SUFFIX}`);
  }
  for (const id of shipped) {
    const base = baseId(id);
    const covered = discovered.some((model) => model.id === base || isSnapshotOf(model.id, base));
    if (!covered) add(id);
  }
  return ids;
}

/** model id → the effort levels the API vouched for. A model the API said nothing about is absent,
 *  which the catalog contract reads as "the backend's whole ladder". `[1m]` variants inherit their
 *  base model's entry. */
export function anthropicModelThinking(
  discovered: readonly DiscoveredAnthropicModel[],
): Record<string, string[]> {
  const thinking: Record<string, string[]> = {};
  for (const model of discovered) {
    if (!model.effortLevels) continue;
    thinking[model.id] = [...model.effortLevels];
    thinking[`${model.id}${LONG_CONTEXT_SUFFIX}`] = [...model.effortLevels];
  }
  return thinking;
}

export interface AnthropicModelDiscovery {
  /** The cached list with no fetch kicked at all. */
  peek(): DiscoveredAnthropicModel[];
  /**
   * The cached list, plus a BACKGROUND fetch when it has gone stale — the answer is whatever is
   * cached right now, never a wait. This is what decorating callers use: unlike PI, whose scan
   * loads a ~100 MB SDK, warming this cache costs one HTTP call, so the first spawn of a daemon's
   * life pays the shipped table and every later one gets the discovered list.
   */
  get(): DiscoveredAnthropicModel[];
  /** The list, waiting out a cold fetch (bounded), for callers whose purpose IS the list. */
  ensure(timeoutMs?: number): Promise<DiscoveredAnthropicModel[]>;
  refresh(): void;
}

export interface AnthropicModelDiscoveryOptions {
  fetchModels?: () => Promise<DiscoveredAnthropicModel[]>;
  now?: () => number;
  cacheTtlMs?: number;
  retryMs?: number;
}

export function createAnthropicModelDiscovery(
  options: AnthropicModelDiscoveryOptions = {},
): AnthropicModelDiscovery {
  const cache = new CachedScan<DiscoveredAnthropicModel>({
    scan: options.fetchModels ?? (() => fetchAnthropicModels()),
    now: options.now,
    cacheTtlMs: options.cacheTtlMs ?? ANTHROPIC_MODEL_CACHE_TTL_MS,
    retryMs: options.retryMs ?? ANTHROPIC_MODEL_RETRY_MS,
    key: (model) => model.id,
    clone: (model) => ({ ...model, effortLevels: model.effortLevels ? [...model.effortLevels] : null }),
    logFailure: (message) => log.info(`Anthropic model discovery failed: ${message}`),
  });
  return {
    peek: () => cache.peek(),
    get: () => cache.get(),
    ensure: (timeoutMs = ANTHROPIC_MODEL_ENSURE_TIMEOUT_MS) => cache.ensure(timeoutMs),
    refresh: () => cache.refresh(),
  };
}

export const anthropicModelDiscovery = createAnthropicModelDiscovery();
