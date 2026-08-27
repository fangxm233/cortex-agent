// input:  ProviderUsage snapshots, policy config, language, epoch, and shared USD formatting
// output: known-bucket quota, spend, freshness, severity, timing, row policy, and legacy fallback views
// pos:    Shared desktop/mobile usage presentation model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type {
  ProviderRateLimitPolicyOverride,
  ProviderRateLimitWindowPolicyOverride,
  ProviderRateLimits,
  ProviderUsage,
  UsageFreshness,
  UsageWindow,
} from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';
import { formatUsd } from '@/lib/format';

export type UsageQuotaState = 'available' | 'never' | 'unsupported';
export type UsageSeverity = 'normal' | 'warning' | 'danger';
export type UsageNoteTone = 'info' | 'error';

export const USAGE_WARNING_UTILIZATION = 0.7;
export const USAGE_DANGER_UTILIZATION = 0.9;

export interface UsagePolicyTarget {
  provider: string;
  windowType: string | null;
  windowLabel: string | null;
}

export interface UsageWindowPolicyView {
  target: UsagePolicyTarget;
  enabled: boolean;
  thresholdPercent: number;
  defaultThresholdPercent: number;
  usesLegacyFallback: boolean;
}

export interface ProviderLegacyFallbackView {
  target: UsagePolicyTarget;
  enabled: boolean;
  thresholdPercent: number;
}

export interface UsageWindowView {
  type: string;
  label: string;
  utilization: number | null;
  utilizationLabel: string | null;
  utilizationWidth: string;
  severity: UsageSeverity;
  resetsAt: number | null;
  resetIn: string | null;
  resetElapsed: boolean;
  policy: UsageWindowPolicyView | null;
}

export interface ProviderSpendView {
  today: string;
  month: string;
}

export interface ProviderUsageView {
  provider: string;
  displayName: string;
  modes: string[];
  windows: UsageWindowView[];
  spend: ProviderSpendView | null;
  observedAt: number | null;
  observedAgo: string | null;
  freshness: UsageFreshness;
  quotaState: UsageQuotaState;
  legacyFallback: ProviderLegacyFallbackView | null;
  note?: string;
  noteTone?: UsageNoteTone;
}

export interface UsageView {
  providers: ProviderUsageView[];
}

const WINDOW_LABELS: Record<Lang, Record<string, string>> = {
  en: {
    five_hour: '5 hours',
    seven_day: '7 days',
    seven_day_overage_included: '7 days (incl. overage)',
    codex_primary: 'Primary',
    codex_secondary: 'Secondary',
  },
  zh: {
    five_hour: '5 小时',
    seven_day: '7 天',
    seven_day_overage_included: '7 天（含超额）',
    codex_primary: '主窗口',
    codex_secondary: '次窗口',
  },
};

const PROVIDER_ORDER: Record<string, number> = {
  anthropic: 0,
  'openai-codex': 1,
  deepseek: 2,
  'qwen-ksu': 3,
};

const WEEKLY_WINDOW_TYPES = new Set(['seven_day', 'seven_day_overage_included']);
const RENDERABLE_WINDOW_TYPES = new Set(Object.keys(WINDOW_LABELS.en));

function target(provider: string, windowType?: string | null, windowLabel?: string | null): UsagePolicyTarget {
  return { provider, windowType: windowType ?? null, windowLabel: windowLabel ?? null };
}

export function usagePolicyTargetKey(value: UsagePolicyTarget): string {
  return [value.provider, value.windowType ?? '', value.windowLabel ?? ''].join('::');
}

function percentFromRatio(value: number): number {
  return Math.round(value * 10_000) / 100;
}

function defaultThresholdPercent(windowType: string): number {
  return WEEKLY_WINDOW_TYPES.has(windowType) ? 95 : 90;
}

function hasLegacyFallback(policy: ProviderRateLimitPolicyOverride | undefined): boolean {
  return policy?.enabled === false || typeof policy?.threshold === 'number';
}

function matchingWindowPolicy(
  policy: ProviderRateLimitPolicyOverride | undefined,
  window: UsageWindow,
): ProviderRateLimitWindowPolicyOverride | undefined {
  return policy?.windows?.find(
    (item: ProviderRateLimitWindowPolicyOverride) => item.type === window.type && item.label === window.label,
  );
}

function effectiveWindowPolicy(
  provider: string, window: UsageWindow, providerRateLimits: ProviderRateLimits | null,
): UsageWindowPolicyView | null {
  if (providerRateLimits === null) return null;
  const fallbackDefault = defaultThresholdPercent(window.type);
  const providerPolicy = providerRateLimits[provider];
  const windowPolicy = matchingWindowPolicy(providerPolicy, window);
  if (windowPolicy) return {
    target: target(provider, window.type, window.label),
    enabled: windowPolicy.enabled,
    thresholdPercent: typeof windowPolicy.threshold === 'number' ? percentFromRatio(windowPolicy.threshold) : fallbackDefault,
    defaultThresholdPercent: fallbackDefault,
    usesLegacyFallback: false,
  };
  if (!hasLegacyFallback(providerPolicy)) return {
    target: target(provider, window.type, window.label),
    enabled: true,
    thresholdPercent: fallbackDefault,
    defaultThresholdPercent: fallbackDefault,
    usesLegacyFallback: false,
  };
  return {
    target: target(provider, window.type, window.label),
    enabled: providerPolicy?.enabled ?? true,
    thresholdPercent: typeof providerPolicy?.threshold === 'number' ? percentFromRatio(providerPolicy.threshold) : fallbackDefault,
    defaultThresholdPercent: fallbackDefault,
    usesLegacyFallback: true,
  };
}

function legacyFallbackView(
  provider: string,
  windows: UsageWindow[],
  providerRateLimits: ProviderRateLimits | null,
): ProviderLegacyFallbackView | null {
  if (providerRateLimits === null) return null;
  const policy = providerRateLimits[provider];
  if (!hasLegacyFallback(policy)) return null;
  return {
    target: target(provider),
    enabled: policy?.enabled ?? true,
    thresholdPercent: typeof policy?.threshold === 'number'
      ? percentFromRatio(policy.threshold)
      : defaultThresholdPercent(windows[0]?.type ?? ''),
  };
}

function isRenderableWindow(window: UsageWindow): boolean {
  if (window.type === 'model_scoped') return Boolean(window.label);
  return RENDERABLE_WINDOW_TYPES.has(window.type);
}

function durationParts(seconds: number): [number, number, number] {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
}

export function formatUsageDuration(seconds: number, lang: Lang): string {
  const [days, hours, minutes] = durationParts(seconds);
  const units = lang === 'zh' ? ['天', '小时', '分钟'] : ['d', 'h', 'm'];
  if (days > 0) return hours > 0 ? `${days}${units[0]} ${hours}${units[1]}` : `${days}${units[0]}`;
  if (hours > 0) return minutes > 0 ? `${hours}${units[1]} ${minutes}${units[2]}` : `${hours}${units[1]}`;
  return `${minutes}${units[2]}`;
}

function windowLabel(window: UsageWindow, lang: Lang): string {
  if (window.label) return window.label;
  return WINDOW_LABELS[lang][window.type] ?? window.type.replaceAll('_', ' ');
}

function utilizationLabel(utilization: number | null): string | null {
  if (utilization === null) return null;
  const percentage = Math.round(utilization * 1000) / 10;
  return `${percentage.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

export function utilizationSeverity(utilization: number | null): UsageSeverity {
  if (utilization === null || utilization < USAGE_WARNING_UTILIZATION) return 'normal';
  return utilization < USAGE_DANGER_UTILIZATION ? 'warning' : 'danger';
}

function buildWindow(
  provider: string,
  window: UsageWindow,
  showPolicy: boolean,
  providerRateLimits: ProviderRateLimits | null,
  nowSec: number,
  lang: Lang,
): UsageWindowView {
  const resetElapsed = window.resetsAt !== null && window.resetsAt <= nowSec;
  return {
    type: window.type,
    label: windowLabel(window, lang),
    utilization: window.utilization,
    utilizationLabel: utilizationLabel(window.utilization),
    utilizationWidth: window.utilization === null ? '0%' : `${window.utilization * 100}%`,
    severity: utilizationSeverity(window.utilization),
    resetsAt: window.resetsAt,
    resetIn: window.resetsAt === null || resetElapsed ? null : formatUsageDuration(window.resetsAt - nowSec, lang),
    resetElapsed,
    policy: showPolicy ? effectiveWindowPolicy(provider, window, providerRateLimits) : null,
  };
}

function quotaState(freshness: UsageFreshness): UsageQuotaState {
  if (freshness === 'unsupported') return 'unsupported';
  if (freshness === 'never') return 'never';
  return 'available';
}

function noteTone(note: string): UsageNoteTone {
  return /fail(?:ed|ure)|error|失败/i.test(note) ? 'error' : 'info';
}

function buildProvider(
  record: ProviderUsage,
  providerRateLimits: ProviderRateLimits | null,
  nowSec: number,
  lang: Lang,
): ProviderUsageView {
  const status = quotaState(record.freshness);
  const windows = record.windows.filter(isRenderableWindow);
  const showPolicy = status !== 'unsupported';
  return {
    provider: record.provider,
    displayName: record.displayName,
    modes: [...record.modes],
    windows: windows.map((window: UsageWindow) => buildWindow(record.provider, window, showPolicy, providerRateLimits, nowSec, lang)),
    spend: record.spend ? { today: formatUsd(record.spend.today), month: formatUsd(record.spend.month) } : null,
    observedAt: record.observedAt,
    observedAgo: record.observedAt === null ? null : formatUsageDuration(nowSec - record.observedAt, lang),
    freshness: record.freshness,
    quotaState: status,
    legacyFallback: showPolicy ? legacyFallbackView(record.provider, windows, providerRateLimits) : null,
    ...(record.note ? { note: record.note, noteTone: noteTone(record.note) } : {}),
  };
}

function providerCompare(a: ProviderUsageView, b: ProviderUsageView): number {
  const rank = (PROVIDER_ORDER[a.provider] ?? 100) - (PROVIDER_ORDER[b.provider] ?? 100);
  return rank || a.displayName.localeCompare(b.displayName) || a.provider.localeCompare(b.provider);
}

export function buildUsageView(
  status: ProviderUsage[] | null | undefined,
  providerRateLimits: ProviderRateLimits | null,
  nowSec: number,
  lang: Lang,
): UsageView {
  return {
    providers: (status ?? [])
      .map((record) => buildProvider(record, providerRateLimits, nowSec, lang))
      .sort(providerCompare),
  };
}
