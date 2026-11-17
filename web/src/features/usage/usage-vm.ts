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
  /** The row's account (connection id); null: the provider's default login. */
  account: string | null;
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

/**
 * One kind of banked reset: the credits that clear the same windows. Claude holds full resets
 * beside model launch resets that leave the all-models weekly limit alone.
 */
export interface UsageResetKindView {
  /** The windows it clears, sorted and joined; '' when the provider does not say. */
  key: string;
  /** Kind name and count, e.g. `Full reset 1`. */
  summary: string;
  available: number;
  /** The credit a reset of this kind spends. Null while the account holds one kind only: the
   *  server then picks from its own live reading. */
  creditId: string | null;
  /** Earliest-expiring reset of the kind; null when only the count is known. */
  nextExpiresAt: number | null;
  nextExpiresIn: string | null;
  /** What the confirm step says before a reset is spent, one paragraph per line. */
  confirm: string[];
}

/** Banked rate-limit resets the account can spend (OpenAI Codex, Claude). */
export interface UsageResetsView {
  /** The account a reset is spent on; null for a row that cannot spend one here. */
  provider: ResetProvider | null;
  /** The provider's named account the row belongs to; null on its default login. */
  connection: string | null;
  kinds: UsageResetKindView[];
}

export interface UsageResetOutcomeView {
  label: keyof Vocab;
  tone: 'success' | 'info';
}

export interface ProviderSpendView {
  today: string;
  /** Rolling 30 days. */
  month: string;
  /** The last 90 days; null on a row stored before that total was read. */
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
/** The weekly window only a full Claude reset clears. */
const ALL_MODELS_WEEKLY = 'seven_day';
const RENDERABLE_WINDOW_TYPES = new Set(Object.keys(WINDOW_LABEL_KEYS));

/** The server files a default login's window policies under this account key. */
const DEFAULT_POLICY_ACCOUNT = 'subscription';

function target(
  provider: string, account: string | null, windowType?: string | null, windowLabel?: string | null,
): UsagePolicyTarget {
  return { provider, account, windowType: windowType ?? null, windowLabel: windowLabel ?? null };
}

export function usagePolicyTargetKey(value: UsagePolicyTarget): string {
  const owner = value.account ? `${value.provider}@${value.account}` : value.provider;
  return [owner, value.windowType ?? '', value.windowLabel ?? ''].join('::');
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

/** The account's own entry for the window, else the provider-wide one — as the server resolves it. */
function matchingWindowPolicy(
  policy: ProviderRateLimitPolicyOverride | undefined,
  account: string | null,
  window: UsageWindow,
): ProviderRateLimitWindowPolicyOverride | undefined {
  const matches = (item: ProviderRateLimitWindowPolicyOverride) => item.type === window.type
    && (window.type !== 'model_scoped' || item.label === window.label);
  return policy?.accounts?.[account ?? DEFAULT_POLICY_ACCOUNT]?.windows.find(matches)
    ?? policy?.windows?.find(matches);
}

function effectiveWindowPolicy(
  provider: string, account: string | null, window: UsageWindow, providerRateLimits: ProviderRateLimits | null,
): UsageWindowPolicyView | null {
  if (providerRateLimits === null) return null;
  const fallbackDefault = defaultThresholdPercent(window.type);
  const providerPolicy = providerRateLimits[provider];
  const windowPolicy = matchingWindowPolicy(providerPolicy, account, window);
  if (windowPolicy) return {
    target: target(provider, account, window.type, policyLabel(window)),
    enabled: windowPolicy.enabled,
    thresholdPercent: typeof windowPolicy.threshold === 'number' ? percentFromRatio(windowPolicy.threshold) : fallbackDefault,
    defaultThresholdPercent: fallbackDefault,
    usesLegacyFallback: false,
  };
  if (!hasLegacyFallback(providerPolicy)) return {
    target: target(provider, account, window.type, policyLabel(window)),
    enabled: true,
    thresholdPercent: fallbackDefault,
    defaultThresholdPercent: fallbackDefault,
    usesLegacyFallback: false,
  };
  return {
    target: target(provider, account, window.type, policyLabel(window)),
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
    target: target(provider, null),
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
  account: string | null,
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
    policy: showPolicy ? effectiveWindowPolicy(provider, account, window, providerRateLimits) : null,
  };
}

function resetProvider(record: ProviderUsage): ResetProvider | null {
  return record.billing !== 'api' && RESET_PROVIDERS.includes(record.provider)
    ? record.provider as ResetProvider
    : null;
}

/** A window a reset clears, named after the row's own window of that type (e.g. `7 days (Fable)`). */
function clearedWindowLabel(record: ProviderUsage, type: string, lang: Lang): string {
  const labeled = record.windows.find((window) => window.type === type && window.label);
  return windowLabel(labeled ?? { type }, lang);
}

/** Current use of the windows a reset clears (all shown windows when it does not say). */
function clearedWindowUse(record: ProviderUsage, clears: string[], lang: Lang): string {
  return record.windows
    .filter((window) => isRenderableWindow(window) && (clears.length === 0 || clears.includes(window.type)))
    .map((window) => `${windowLabel(window, lang)} ${utilizationLabel(window.utilization) ?? '—'}`)
    .join(' · ');
}

/** Claude names the windows a reset clears; while not at a limit the confirm shows current use. */
function resetConfirm(record: ProviderUsage, clears: string[], lang: Lang): string[] {
  const L = pickVocab(lang);
  if (record.provider !== 'anthropic') return [L.usageResetConfirmBody];
  const windows = clears.map((type) => clearedWindowLabel(record, type, lang)).join(', ') || L.usageResetAllLimits;
  const lines = [fmt(L.usageResetConfirmBodyClaude, { windows })];
  const usage = clearedWindowUse(record, clears, lang);
  if (record.resetCredits?.atLimit === false && usage) lines.push(fmt(L.usageResetNotAtLimit, { usage }));
  return lines;
}

/** Full, or named after the model whose weekly limit it clears. */
function kindSummary(record: ProviderUsage, clears: string[], n: number, lang: Lang): string {
  const L = pickVocab(lang);
  if (clears.length === 0) return fmt(L.usageResets, { n });
  if (clears.includes(ALL_MODELS_WEEKLY)) return fmt(L.usageResetKindFull, { n });
  const model = record.windows.find((window) => clears.includes(window.type) && window.label)?.label
    ?? clears.map((type) => clearedWindowLabel(record, type, lang)).join(', ');
  return fmt(L.usageResetKindModel, { model, n });
}

function sortedClears(credit: UsageResetCredit): string[] {
  return [...(credit.clears ?? [])].sort();
}

function expiryOrder(a: UsageResetCredit, b: UsageResetCredit): number {
  return (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY);
}

/** Credits grouped by the windows they clear, in order of each group's first credit. */
function groupByClears(credits: UsageResetCredit[]): UsageResetCredit[][] {
  const groups = new Map<string, UsageResetCredit[]>();
  for (const credit of credits) {
    const key = sortedClears(credit).join(',');
    groups.set(key, [...(groups.get(key) ?? []), credit]);
  }
  return [...groups.values()];
}

interface ResetKindContext {
  record: ProviderUsage;
  /** Several kinds are held, so each names the credit it spends. */
  pinCredit: boolean;
  nowSec: number;
  lang: Lang;
}

function kindView(group: UsageResetCredit[], ctx: ResetKindContext): UsageResetKindView {
  const byExpiry = [...group].sort(expiryOrder);
  const next = group.find((credit) => credit.id === ctx.record.resetCredits?.nextCreditId) ?? byExpiry[0];
  const clears = sortedClears(group[0]);
  const available = group.reduce((sum, credit) => sum + (credit.count ?? 1), 0);
  const nextExpiresAt = byExpiry[0].expiresAt;
  return {
    key: clears.join(','),
    summary: kindSummary(ctx.record, clears, available, ctx.lang),
    available,
    creditId: ctx.pinCredit ? next.id : null,
    nextExpiresAt,
    nextExpiresIn: nextExpiresAt === null ? null : formatUsageDuration(nextExpiresAt - ctx.nowSec, ctx.lang),
    confirm: resetConfirm(ctx.record, clears, ctx.lang),
  };
}

/** A count without spendable credits listed: one unnamed kind. */
function countOnlyKind(record: ProviderUsage, available: number, lang: Lang): UsageResetKindView {
  return {
    key: '', summary: kindSummary(record, [], available, lang), available, creditId: null,
    nextExpiresAt: null, nextExpiresIn: null, confirm: resetConfirm(record, [], lang),
  };
}

/** Expired credits drop out locally, so a row read days ago does not offer a reset that lapsed. */
function buildResets(record: ProviderUsage, nowSec: number, lang: Lang): UsageResetsView | null {
  const credits = record.resetCredits;
  if (!credits) return null;
  const live = credits.credits.filter((credit) => credit.expiresAt === null || credit.expiresAt > nowSec);
  const groups = groupByClears(live);
  const ctx: ResetKindContext = { record, pinCredit: groups.length > 1, nowSec, lang };
  const kinds = groups.length > 0
    ? groups.map((group) => kindView(group, ctx))
    : [countOnlyKind(record, credits.credits.length > 0 ? 0 : credits.availableCount, lang)];
  return { provider: resetProvider(record), connection: record.route ?? null, kinds };
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
    windows: windows.map((window: UsageWindow) => buildWindow(record.provider, record.route ?? null, window, showPolicy, providerRateLimits, nowSec, lang)),
    spend: record.spend ? spendView(record.spend) : null,
    observedAt: record.observedAt,
    observedAgo: record.observedAt === null ? null : formatUsageDuration(nowSec - record.observedAt, lang),
    quotaState: status,
    legacyFallback: showPolicy ? legacyFallbackView(record.provider, windows, providerRateLimits) : null,
    resets: buildResets(record, nowSec, lang),
    ...(record.note ? { note: record.note, noteTone: noteTone(record.note) } : {}),
  };
}

/** The server's row identity: one row per provider, billing kind and account. */
export function usageRowKey(record: Pick<ProviderUsage, 'provider' | 'billing' | 'route'>): string {
  if (!record.billing) return record.provider;
  const base = `${record.provider}::${record.billing}`;
  return record.route ? `${base}::${record.route}` : base;
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

/** A row with no quota source, spend, reset or note has nothing to show, e.g. a subscription
 *  whose provider exposes no usage at all. */
function hasContent(view: ProviderUsageView): boolean {
  return view.quotaState !== 'unsupported' || view.windows.length > 0 || view.spend !== null
    || view.resets !== null || view.note !== undefined;
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
      .map((record) => buildProvider(record, providerRateLimits, nowSec, lang))
      .filter(hasContent),
  };
}
