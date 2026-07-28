// input:  persisted/live context snapshots and raw SSE payloads
// output: validated snapshot resolution plus usage labels and fractions
// pos:    shared context model; surfaces own their visibility policy
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SessionContextUsage } from '@cortex-agent/ui-contract';

export interface ContextUsageViewModel {
  compact: string;
  current: string;
  maximum: string;
  percentLabel: string;
  progress: number | null;
  estimated: boolean;
}

export function resolveContextUsage(
  live: SessionContextUsage | null,
  snapshot: SessionContextUsage | null | undefined,
): SessionContextUsage | null {
  return live ?? snapshot ?? null;
}

export function contextUsageFromLivePayload(payload: unknown): SessionContextUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const usedTokens = nullableNonNegative(value.usedTokens);
  const contextWindow = value.contextWindow;
  const percent = nullableNonNegative(value.percent);
  const accuracy = value.accuracy;
  const updatedAt = value.updatedAt;
  if (
    (value.usedTokens !== null && usedTokens === null) ||
    typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0 ||
    (value.percent !== null && percent === null) ||
    (accuracy !== 'exact' && accuracy !== 'estimate') ||
    typeof updatedAt !== 'string'
  ) return null;
  return { usedTokens, contextWindow, percent, accuracy, updatedAt };
}

export function contextUsageViewModel(usage: SessionContextUsage | null): ContextUsageViewModel {
  const used = usage?.usedTokens ?? null;
  const maximum = usage?.contextWindow ?? null;
  const percent = usage?.percent ?? null;
  return {
    compact: `${formatCompactTokens(used)} / ${formatCompactTokens(maximum)}`,
    current: formatInteger(used),
    maximum: formatInteger(maximum),
    percentLabel: percent === null ? '—' : `${formatDecimal(percent)}%`,
    progress: percent === null ? null : Math.min(100, Math.max(0, percent)),
    estimated: usage?.accuracy === 'estimate',
  };
}

function nullableNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatCompactTokens(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) return `${formatDecimal(value / 1_000_000)}m`;
  if (value >= 1_000) return `${formatDecimal(value / 1_000)}k`;
  return formatDecimal(value);
}

function formatInteger(value: number | null): string {
  if (value === null) return '—';
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDecimal(value: number): string {
  return Number(value.toFixed(1)).toString();
}
