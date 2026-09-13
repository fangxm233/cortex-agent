// input:  ClaudeUsage object (from assistant.message.usage in jsonl) + model id string
// output: usageToCost { totalUsd, modelFamily, breakdown }, PRICING_TABLE, normalizeModelId
// pos:    Cost reconstruction for Claude TUI mode — jsonl has no total_cost_usd, so we reverse-derive from usage tokens
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Subset of Anthropic API's `usage` object as it appears in jsonl `assistant` entries.
 * Older sessions may lack `cache_creation` sub-object (only flat counts); newer ones split 5m vs 1h.
 */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  // Other fields (server_tool_use, service_tier, iterations, etc.) are ignored for cost.
}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheCreation5mPerMTok: number;
  cacheCreation1hPerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * Pricing table per Anthropic public rates (USD per 1M tokens). Keyed by model **family**
 * (sonnet-4 / opus-4 / haiku-4), not specific revisions — revisions within a family share rates.
 *
 * If Anthropic publishes a price change, update here and bump the comment block date.
 * Last verified: 2026-05-15.
 *
 * Rate references (Anthropic public pricing, Claude 4 family):
 *   sonnet-4: $3 input, $15 output, $3.75 cache-write-5m, $6 cache-write-1h, $0.30 cache-read
 *   opus-4:   $15 input, $75 output, $18.75 cache-write-5m, $30 cache-write-1h, $1.50 cache-read
 *   haiku-4:  $1 input, $5 output, $1.25 cache-write-5m, $2 cache-write-1h, $0.10 cache-read
 */
export const PRICING_TABLE: Record<string, ModelPricing> = {
  'sonnet-4': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheCreation5mPerMTok: 3.75,
    cacheCreation1hPerMTok: 6.0,
    cacheReadPerMTok: 0.30,
  },
  'opus-4': {
    inputPerMTok: 15.0,
    outputPerMTok: 75.0,
    cacheCreation5mPerMTok: 18.75,
    cacheCreation1hPerMTok: 30.0,
    cacheReadPerMTok: 1.50,
  },
  'haiku-4': {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheCreation5mPerMTok: 1.25,
    cacheCreation1hPerMTok: 2.0,
    cacheReadPerMTok: 0.10,
  },
};

/**
 * Map a full Anthropic API model id (e.g. "claude-sonnet-4-5-20250929") to a pricing family key.
 * Returns null for unrecognized strings — caller treats null as "cost unknown" rather than zero.
 */
export function normalizeModelId(modelId: string | null | undefined): string | null {
  if (!modelId || typeof modelId !== 'string') return null;
  if (modelId.includes('sonnet-4')) return 'sonnet-4';
  if (modelId.includes('opus-4')) return 'opus-4';
  if (modelId.includes('haiku-4')) return 'haiku-4';
  return null;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheRead: number;
}

export interface CostResult {
  totalUsd: number;
  modelFamily: string;
  breakdown: CostBreakdown;
}

/**
 * Reverse-derive USD cost from a Claude `usage` object and the model id used for that message.
 * Returns null when the model family is unknown — callers must handle null explicitly (do not
 * silently fall through to zero, which would understate spend).
 *
 * Cache creation rule: prefer `cache_creation.ephemeral_{5m,1h}_input_tokens` split; if absent,
 * fall back to treating the flat `cache_creation_input_tokens` count as 5m (conservative lower bound).
 */
export function usageToCost(usage: ClaudeUsage | null | undefined, modelId: string | null | undefined): CostResult | null {
  const family = normalizeModelId(modelId);
  if (!family) return null;
  const pricing = PRICING_TABLE[family];
  if (!pricing) return null;
  const u = usage || {};

  const inputTok = u.input_tokens ?? 0;
  const outputTok = u.output_tokens ?? 0;
  const cacheCreationTotal = u.cache_creation_input_tokens ?? 0;
  const cacheReadTok = u.cache_read_input_tokens ?? 0;

  // Split cache_creation into 5m vs 1h when sub-object is present; otherwise assume 5m.
  let cacheCreate5mTok: number;
  let cacheCreate1hTok: number;
  if (u.cache_creation && (typeof u.cache_creation.ephemeral_5m_input_tokens === 'number' || typeof u.cache_creation.ephemeral_1h_input_tokens === 'number')) {
    cacheCreate5mTok = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
    cacheCreate1hTok = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
  } else {
    cacheCreate5mTok = cacheCreationTotal;
    cacheCreate1hTok = 0;
  }

  const breakdown: CostBreakdown = {
    input: (inputTok * pricing.inputPerMTok) / 1_000_000,
    output: (outputTok * pricing.outputPerMTok) / 1_000_000,
    cacheCreation5m: (cacheCreate5mTok * pricing.cacheCreation5mPerMTok) / 1_000_000,
    cacheCreation1h: (cacheCreate1hTok * pricing.cacheCreation1hPerMTok) / 1_000_000,
    cacheRead: (cacheReadTok * pricing.cacheReadPerMTok) / 1_000_000,
  };
  const totalUsd = breakdown.input + breakdown.output + breakdown.cacheCreation5m + breakdown.cacheCreation1h + breakdown.cacheRead;

  return { totalUsd, modelFamily: family, breakdown };
}
