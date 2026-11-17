import { t } from '@core/i18n.js';
import type { MessageKey } from '@core/locales/en.js';
import { isFullResetKind, resetCreditKinds, type ResetCreditKind } from '@domain/costs/reset-kinds.js';
import type { ProviderUsage, UsageFreshness, UsageWindow } from '@domain/costs/usage-store.js';

const WINDOW_LABEL_KEYS = {
  five_hour: 'cmd.usage.window.fiveHour',
  seven_day: 'cmd.usage.window.sevenDay',
  seven_day_opus: 'cmd.usage.window.sevenDayOpus',
  seven_day_overage_included: 'cmd.usage.window.sevenDayOverage',
  codex_primary: 'cmd.usage.window.codexPrimary',
  codex_secondary: 'cmd.usage.window.codexSecondary',
} as const;

const FRESHNESS_KEYS: Record<UsageFreshness, MessageKey> = {
  live: 'cmd.usage.freshness.live',
  stale: 'cmd.usage.freshness.stale',
  never: 'cmd.usage.freshness.never',
  unsupported: 'cmd.usage.freshness.unsupported',
};

export function formatPercent(value: number | null): string {
  if (value === null) return t('cmd.usage.unavailable');
  return `${Number((value * 100).toFixed(1))}%`;
}

function formatEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

export function windowLabel(window: Pick<UsageWindow, 'type' | 'label'>): string {
  if (window.type === 'model_scoped' && window.label) return window.label;
  if (window.type === 'seven_day_overage_included' && window.label) {
    return t('cmd.usage.window.sevenDayModel', { model: window.label });
  }
  const key = WINDOW_LABEL_KEYS[window.type as keyof typeof WINDOW_LABEL_KEYS];
  return key ? t(key) : window.label ?? window.type;
}

function formatWindow(window: UsageWindow): string {
  const reset = window.resetsAt === null
    ? ''
    : t('cmd.usage.resetSuffix', { time: formatEpoch(window.resetsAt) });
  return t('cmd.usage.windowLine', {
    label: windowLabel(window),
    utilization: formatPercent(window.utilization),
    reset,
  });
}

function formatSpend(record: ProviderUsage): string | null {
  if (!record.spend) return null;
  return t('cmd.usage.spendLine', {
    today: record.spend.today.toFixed(2),
    month: record.spend.month.toFixed(2),
  });
}

function earliestExpiry(record: ProviderUsage): number | null {
  const expiries = (record.resetCredits?.credits ?? [])
    .flatMap((credit) => (credit.expiresAt === null ? [] : [credit.expiresAt]));
  return expiries.length > 0 ? Math.min(...expiries) : null;
}

function expirySuffix(expiresAt: number | null): string {
  return expiresAt === null ? '' : t('cmd.usage.resetExpirySuffix', { time: formatEpoch(expiresAt) });
}

/** A window a reset clears, named after the row's own window of that type (e.g. `7 day (Fable)`). */
export function clearedWindowLabel(record: ProviderUsage | undefined, type: string): string {
  const labeled = record?.windows.find((window) => window.type === type && window.label);
  return windowLabel(labeled ?? { type });
}

/** A reset kind's name: full, or the model whose weekly it clears. Null when the provider names no
 *  windows, so every reset of the account is alike. */
export function resetKindName(record: ProviderUsage | undefined, clears: string[]): string | null {
  if (clears.length === 0) return null;
  if (isFullResetKind({ clears })) return t('cmd.usage.resetKindFull');
  const model = record?.windows.find((window) => clears.includes(window.type) && window.label)?.label;
  const name = model ?? clears.map((type) => clearedWindowLabel(record, type)).join(', ');
  return t('cmd.usage.resetKindModel', { model: name });
}

function formatResetKind(record: ProviderUsage, kind: ResetCreditKind): string {
  const name = resetKindName(record, kind.clears);
  const expiry = expirySuffix(kind.expiresAt);
  return name === null
    ? t('cmd.usage.resetCreditsLine', { count: kind.count, expiry })
    : t('cmd.usage.resetKindLine', { kind: name, count: kind.count, expiry });
}

/** One line per reset kind; one count line when the provider does not tell kinds apart. */
function formatResetCredits(record: ProviderUsage): string[] {
  if (!record.resetCredits) return [];
  const kinds = resetCreditKinds(record.resetCredits);
  if (kinds.every((kind) => kind.clears.length === 0)) {
    return [t('cmd.usage.resetCreditsLine', { count: record.resetCredits.availableCount, expiry: expirySuffix(earliestExpiry(record)) })];
  }
  return kinds.map((kind) => formatResetKind(record, kind));
}

function formatProvider(record: ProviderUsage): string[] {
  const lines = [t('cmd.usage.providerLine', {
    name: record.displayName,
    provider: record.provider,
    freshness: t(FRESHNESS_KEYS[record.freshness]),
  })];
  lines.push(...record.windows.map(formatWindow));
  lines.push(...formatResetCredits(record));
  const spend = formatSpend(record);
  if (spend) lines.push(spend);
  if (record.observedAt !== null) lines.push(t('cmd.usage.observedLine', { time: formatEpoch(record.observedAt) }));
  if (record.note) lines.push(t('cmd.usage.noteLine', { note: record.note }));
  return lines;
}

/** A provider name matches all its rows; an account's id or label matches that account's row. */
function matchesProvider(record: ProviderUsage, provider: string): boolean {
  const normalized = provider.toLowerCase();
  return [record.provider, record.displayName, record.route, record.label]
    .some((name) => name?.toLowerCase() === normalized);
}

export function filteredRecords(records: ProviderUsage[], provider?: string): ProviderUsage[] {
  if (!provider) return records;
  return records.filter((record) => matchesProvider(record, provider));
}

export function formatUsageReport(records: ProviderUsage[], provider?: string): string {
  const selected = filteredRecords(records, provider);
  if (selected.length === 0) {
    const available = records.map((record) => record.provider).join(', ') || t('cmd.usage.noneAvailable');
    return provider
      ? t('cmd.usage.unknownProvider', { provider, available })
      : [t('cmd.usage.header'), t('cmd.usage.empty')].join('\n');
  }
  const lines = [t('cmd.usage.header')];
  selected.forEach((record, index) => {
    if (index > 0) lines.push('');
    lines.push(...formatProvider(record));
  });
  return lines.join('\n');
}
