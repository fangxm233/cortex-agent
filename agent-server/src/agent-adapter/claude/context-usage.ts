// input:  Claude print stream/result events and configured model name
// output: exact current-context snapshots with reconciled window size
// pos:    Stateful provider-call usage tracker for Claude print sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ContextUsage } from '@core/types/agent-types.js';

const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' ? value as JsonRecord : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalToken(usage: JsonRecord, key: string): number | null {
  if (usage[key] === undefined) return 0;
  return nonNegative(usage[key]);
}

function inputTotal(value: unknown): number | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const input = nonNegative(usage.input_tokens);
  const created = optionalToken(usage, 'cache_creation_input_tokens');
  const read = optionalToken(usage, 'cache_read_input_tokens');
  if (input === null || created === null || read === null) return null;
  return nonNegative(input + created + read);
}

function finalTotal(value: unknown): number | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const input = inputTotal(usage);
  const output = nonNegative(usage.output_tokens);
  return input === null || output === null ? null : nonNegative(input + output);
}

function lastIteration(result: JsonRecord): unknown {
  const usage = asRecord(result.usage);
  const iterations = usage?.iterations;
  return Array.isArray(iterations) && iterations.length > 0 ? iterations.at(-1) : null;
}

function validWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function canonicalModel(entry: unknown): string | null {
  const model = asRecord(entry)?.canonicalModel;
  return typeof model === 'string' ? model : null;
}

function configuredCanonical(model: string | null): string | null {
  return model?.replace(/\[1m\]$/, '') ?? null;
}

type ModelUsageEntry = [string, unknown];

function matchCanonical(entries: ModelUsageEntry[], model: string | null): unknown {
  if (!model) return null;
  return entries.find(([, entry]) => canonicalModel(entry) === model)?.[1] ?? null;
}

function matchRaw(entries: ModelUsageEntry[], model: string | null): unknown {
  if (!model) return null;
  return entries.find(([key]) => key === model)?.[1] ?? null;
}

function matchActive(entries: ModelUsageEntry[], model: string | null): unknown {
  return matchCanonical(entries, model) ?? matchRaw(entries, model);
}

function matchConfigured(entries: ModelUsageEntry[], model: string | null): unknown {
  return matchRaw(entries, model) ?? matchCanonical(entries, configuredCanonical(model));
}

function selectModelUsage(
  value: unknown,
  activeModel: string | null,
  configuredModel: string | null,
): unknown {
  const usage = asRecord(value);
  if (!usage) return null;
  const entries = Object.entries(usage);
  return matchActive(entries, activeModel)
    ?? matchConfigured(entries, configuredModel)
    ?? (entries.length === 1 ? entries[0][1] : null);
}

function actualContextWindow(
  result: JsonRecord,
  activeModel: string | null,
  configuredModel: string | null,
): number | null {
  const selected = asRecord(selectModelUsage(result.modelUsage, activeModel, configuredModel));
  return validWindow(selected?.contextWindow);
}

/** Infer the initial Claude context window from the configured model-name contract. */
export function inferClaudeContextWindow(model: string | null | undefined): number {
  return model?.endsWith('[1m]') ? LARGE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Tracks the latest provider call rather than aggregating a Cortex turn. The configured-model
 * suffix supplies the first-turn default; result.modelUsage replaces it with the runtime window.
 */
export class ClaudeContextUsageTracker {
  private readonly configuredModel: string | null;
  private contextWindow: number;
  private currentInput: number | null = null;
  private currentUsed: number | null = null;
  private activeModel: string | null = null;
  private resultFallbackAllowed = true;
  private lastSnapshotKey: string | null = null;

  constructor(configuredModel?: string | null) {
    this.configuredModel = configuredModel ?? null;
    this.contextWindow = inferClaudeContextWindow(configuredModel);
  }

  observe(value: unknown): ContextUsage | null {
    const data = asRecord(value);
    if (!data) return null;
    if (data.type === 'stream_event') return this.observeStream(asRecord(data.event));
    if (data.type === 'system' && data.subtype === 'compact_boundary') return this.observeCompaction();
    if (data.type === 'result') return this.observeResult(data);
    return null;
  }

  private observeStream(event: JsonRecord | null): ContextUsage | null {
    if (event?.type === 'message_start') return this.observeMessageStart(asRecord(event.message));
    if (event?.type === 'message_delta') return this.observeMessageDelta(asRecord(event.usage));
    return null;
  }

  private observeMessageStart(message: JsonRecord | null): ContextUsage | null {
    this.currentInput = null;
    this.currentUsed = null;
    this.resultFallbackAllowed = true;
    this.activeModel = typeof message?.model === 'string' ? message.model : null;
    const input = inputTotal(message?.usage);
    if (input === null) return null;
    this.currentInput = input;
    this.currentUsed = input;
    return this.snapshot(input);
  }

  private observeMessageDelta(usage: JsonRecord | null): ContextUsage | null {
    const output = nonNegative(usage?.output_tokens);
    if (this.currentInput === null || output === null) return null;
    this.currentUsed = nonNegative(this.currentInput + output);
    return this.currentUsed === null ? null : this.snapshot(this.currentUsed);
  }

  private observeCompaction(): null {
    this.currentInput = null;
    this.currentUsed = null;
    this.activeModel = null;
    this.resultFallbackAllowed = false;
    return null;
  }

  private observeResult(result: JsonRecord): ContextUsage | null {
    const actual = actualContextWindow(result, this.activeModel, this.configuredModel);
    if (actual !== null) this.contextWindow = actual;
    const finalUsed = this.resultFallbackAllowed
      ? finalTotal(lastIteration(result)) ?? this.currentUsed
      : null;
    if (finalUsed === null) return null;
    this.currentUsed = finalUsed;
    return this.snapshot(finalUsed);
  }

  private snapshot(usedTokens: number): ContextUsage | null {
    const key = `${usedTokens}/${this.contextWindow}`;
    if (key === this.lastSnapshotKey) return null;
    this.lastSnapshotKey = key;
    return {
      usedTokens,
      contextWindow: this.contextWindow,
      percent: usedTokens / this.contextWindow * 100,
      accuracy: 'exact',
    };
  }
}
