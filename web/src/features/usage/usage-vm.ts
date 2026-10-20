import type {
  ProviderRateLimitPolicyOverride,
  ProviderRateLimitWindowPolicyOverride,
  ProviderRateLimits,
  ProviderUsage,
  ResetProvider,
  ResetStatus,
  UsageBilling,
  UsageFreshness,
  UsageResetCredit,
  UsageWindow,
} from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';
import { fmt } from '@/i18n/fmt';
import { pickVocab } from '@/i18n/lang';
import type { Vocab } from '@/i18n/vocab';
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

/** Banked rate-limit resets the account can spend (OpenAI Codex, Claude). */
export interface UsageResetsView {
  /** The account a reset is spent on; null for a row that cannot spend one here. */
  provider: ResetProvider | null;
  available: number;
  /** Earliest-expiring spendable reset; null when only the count is known. */
  nextExpiresAt: number | null;
  nextExpiresIn: string | null;
  /** What the confirm step says before a reset is spent, one paragraph per line. */
  confirm: string[];
}

export interface UsageResetOutcomeView {
  label: keyof Vocab;
  tone: 'success' | 'info';
}

export interface ProviderSpendView {
  today: string;
  /** Rolling 30 days. */
  month: string;
  /** Null when the gateway reports no lifetime total. */
  all: string | null;
}

export interface ProviderUsageView {
  /** Unique per row: one provider can appear twice, once per billing kind. */
  key: string;
  provider: string;
  billing: UsageBilling | null;
  displayName: string;
  modes: string[];
  windows: UsageWindowView[];
  spend: ProviderSpendView | null;
  observedAt: number | null;
  observedAgo: string | null;
  quotaState: UsageQuotaState;
  legacyFallback: ProviderLegacyFallbackView | null;
  resets: UsageResetsView | null;
  note?: string;
  noteTone?: UsageNoteTone;
}

export interface UsageView {
  providers: ProviderUsageView[];
}

const WINDOW_LABEL_KEYS: Record<string, keyof Vocab> = {
  five_hour: 'usageWindowFiveHour',
  seven_day: 'usageWindowSevenDay',
  seven_day_overage_included: 'usageWindowSevenDayOverage',
  codex_primary: 'usageWindowCodexPrimary',
  codex_secondary: 'usageWindowCodexSecondary',
};

/**
 * Only pins the two providers that carry quota bars, so they stay at the top where the
 * user looks first. Everything else is discovered at runtime and ranked by the comparator
 * below — no provider may be listed here just to give it a fixed slot.
 */
const PROVIDER_ORDER: Record<string, number> = {
  anthropic: 0,
  'openai-codex': 1,
};

const RESET_OUTCOME_LABELS: Record<ResetStatus, keyof Vocab> = {
  reset: 'usageResetDone',
  nothing_to_reset: 'usageResetNothing',
  no_credit: 'usageResetNoCredit',
  already_redeemed: 'usageResetAlreadyUsed',
  cooldown: 'usageResetCooldown',
  ineligible: 'usageResetIneligible',
  signed_out: 'usageResetSignedOut',
};

const RESET_PROVIDERS: readonly string[] = ['openai-codex', 'anthropic'] satisfies ResetProvider[];

const WEEKLY_WINDOW_TYPES = new Set(['seven_day', 'seven_day_overage_included']);
const RENDERABLE_WINDOW_TYPES = new Set(Object.keys(WINDOW_LABEL_KEYS));

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

/** A label is part of a policy's identity only for a model-scoped window, as on the server. */
function policyLabel(window: Pick<UsageWindow, 'type' | 'label'>): string | undefined {
  return window.type === 'model_scoped' ? window.label : undefined;
}

function matchingWindowPolicy(
  policy: ProviderRateLimitPolicyOverride | undefined,
  window: UsageWindow,
): ProviderRateLimitWindowPolicyOverride | undefined {
  return policy?.windows?.find(
    (item: ProviderRateLimitWindowPolicyOverride) => item.type === window.type
      && (window.type !== 'model_scoped' || item.label === window.label),
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
    target: target(provider, window.type, policyLabel(window)),
    enabled: windowPolicy.enabled,
    thresholdPercent: typeof windowPolicy.threshold === 'number' ? percentFromRatio(windowPolicy.threshold) : fallbackDefault,
    defaultThresholdPercent: fallbackDefault,
    usesLegacyFallback: false,
  };
  if (!hasLegacyFallback(providerPolicy)) return {
    target: target(provider, window.type, policyLabel(window)),
    enabled: true,
    thresholdPercent: fallbackDefault,
    defaultThresholdPercent: fallbackDefault,
    usesLegacyFallback: false,
  };
  return {
    target: target(provider, window.type, policyLabel(window)),
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
  const L = pickVocab(lang);
  const d = `${days}${L.timeUnitD}`, h = `${hours}${L.timeUnitH}`, m = `${minutes}${L.timeUnitM}`;
  if (days > 0) return hours > 0 ? fmt(L.timePrecise, { major: d, minor: h }) : d;
  if (hours > 0) return minutes > 0 ? fmt(L.timePrecise, { major: h, minor: m }) : h;
  return m;
}

function windowLabel(window: Pick<UsageWindow, 'type' | 'label'>, lang: Lang): string {
  if (window.label && window.type === 'seven_day_overage_included') {
    return fmt(pickVocab(lang).usageWindowSevenDayModel, { model: window.label });
  }
  if (window.label) return window.label;
  const key = Object.hasOwn(WINDOW_LABEL_KEYS, window.type) ? WINDOW_LABEL_KEYS[window.type] : undefined;
  return key ? pickVocab(lang)[key] : window.type.replaceAll('_', ' ');
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

function resetProvider(record: ProviderUsage): ResetProvider | null {
  return record.billing !== 'api' && RESET_PROVIDERS.includes(record.provider)
    ? record.provider as ResetProvider
    : null;
}

/** Current use of the windows a reset clears (all shown windows when it does not say). */
function clearedWindowUse(record: ProviderUsage, clears: string[], lang: Lang): string {
  return record.windows
    .filter((window) => isRenderableWindow(window) && (clears.length === 0 || clears.includes(window.type)))
    .map((window) => `${windowLabel(window, lang)} ${utilizationLabel(window.utilization) ?? '—'}`)
    .join(' · ');
}

/** Claude names the windows a reset clears; while not at a limit the confirm shows current use. */
function resetConfirm(record: ProviderUsage, next: UsageResetCredit | null, lang: Lang): string[] {
  const L = pickVocab(lang);
  if (record.provider !== 'anthropic') return [L.usageResetConfirmBody];
  const clears = next?.clears ?? [];
  const windows = clears.map((type) => windowLabel({ type }, lang)).join(', ') || L.usageResetAllLimits;
  const lines = [fmt(L.usageResetConfirmBodyClaude, { windows })];
  const usage = clearedWindowUse(record, clears, lang);
  if (record.resetCredits?.atLimit === false && usage) lines.push(fmt(L.usageResetNotAtLimit, { usage }));
  return lines;
}

/** Expired credits drop out locally, so a row read days ago does not offer a reset that lapsed. */
function buildResets(record: ProviderUsage, nowSec: number, lang: Lang): UsageResetsView | null {
  const credits = record.resetCredits;
  if (!credits) return null;
  const live = credits.credits.filter((credit) => credit.expiresAt === null || credit.expiresAt > nowSec);
  const nextExpiresAt = live[0]?.expiresAt ?? null;
  const next = live.find((credit) => credit.id === credits.nextCreditId) ?? live[0] ?? null;
  return {
    provider: resetProvider(record),
    available: credits.credits.length > 0
      ? live.reduce((sum, credit) => sum + (credit.count ?? 1), 0)
      : credits.availableCount,
    nextExpiresAt,
    nextExpiresIn: nextExpiresAt === null ? null : formatUsageDuration(nextExpiresAt - nowSec, lang),
    confirm: resetConfirm(record, next, lang),
  };
}

export function resetOutcomeView(status: ResetStatus): UsageResetOutcomeView {
  return { label: RESET_OUTCOME_LABELS[status], tone: status === 'reset' ? 'success' : 'info' };
}

function quotaState(freshness: UsageFreshness): UsageQuotaState {
  if (freshness === 'unsupported') return 'unsupported';
  if (freshness === 'never') return 'never';
  return 'available';
}

function noteTone(note: string): UsageNoteTone {
  return /fail(?:ed|ure)|error|失败/i.test(note) ? 'error' : 'info';
}

function spendView(spend: NonNullable<ProviderUsage['spend']>): ProviderSpendView {
  return {
    today: formatUsd(spend.today),
    month: formatUsd(spend.month),
    all: spend.all === undefined ? null : formatUsd(spend.all),
  };
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
    key: usageRowKey(record),
    provider: record.provider,
    billing: record.billing ?? null,
    displayName: record.displayName,
    modes: [...record.modes],
    windows: windows.map((window: UsageWindow) => buildWindow(record.provider, window, showPolicy, providerRateLimits, nowSec, lang)),
    spend: record.spend ? spendView(record.spend) : null,
    observedAt: record.observedAt,
    observedAgo: record.observedAt === null ? null : formatUsageDuration(nowSec - record.observedAt, lang),
    quotaState: status,
    legacyFallback: showPolicy ? legacyFallbackView(record.provider, windows, providerRateLimits) : null,
    resets: buildResets(record, nowSec, lang),
    ...(record.note ? { note: record.note, noteTone: noteTone(record.note) } : {}),
  };
}

export function usageRowKey(record: Pick<ProviderUsage, 'provider' | 'billing'>): string {
  return record.billing ? `${record.provider}::${record.billing}` : record.provider;
}

/**
 * Ranks rows by how much attention they deserve, because the provider list is discovered at
 * runtime and can hold anything: pinned quota providers, then rows that actually show a quota
 * bar, then subscription rows, then metered rows by monthly spend. Names only break ties.
 */
function providerCompare(a: ProviderUsage, b: ProviderUsage): number {
  const pinned = (PROVIDER_ORDER[a.provider] ?? 100) - (PROVIDER_ORDER[b.provider] ?? 100);
  const quota = Number(b.windows.length > 0) - Number(a.windows.length > 0);
  const subscription = Number(a.billing === 'api') - Number(b.billing === 'api');
  const spend = (b.spend?.month ?? 0) - (a.spend?.month ?? 0);
  return pinned || quota || subscription || spend
    || a.displayName.localeCompare(b.displayName)
    || usageRowKey(a).localeCompare(usageRowKey(b));
}

export function buildUsageView(
  status: ProviderUsage[] | null | undefined,
  providerRateLimits: ProviderRateLimits | null,
  nowSec: number,
  lang: Lang,
): UsageView {
  return {
    providers: [...(status ?? [])]
      .sort(providerCompare)
      .map((record) => buildProvider(record, providerRateLimits, nowSec, lang)),
  };
}
