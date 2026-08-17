// input:  canonical usage service, provider usage records, command router
// output: !usage handler, text formatter and forced refresh action
// pos:    Platform-neutral provider quota and spend command
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { t } from '@core/i18n.js';
import type { MessageKey } from '@core/locales/en.js';
import { usageService } from '@domain/costs/usage-service.js';
import type { ProviderUsage, UsageFreshness, UsageWindow } from '@domain/costs/usage-store.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type { PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';

export interface UsageCommandService {
  getStatus(): Promise<ProviderUsage[]>;
  refresh(): Promise<ProviderUsage[]>;
}

const WINDOW_LABEL_KEYS = {
  five_hour: 'cmd.usage.window.fiveHour',
  seven_day: 'cmd.usage.window.sevenDay',
  seven_day_opus: 'cmd.usage.window.sevenDayOpus',
  codex_primary: 'cmd.usage.window.codexPrimary',
  codex_secondary: 'cmd.usage.window.codexSecondary',
} as const;

const FRESHNESS_KEYS: Record<UsageFreshness, MessageKey> = {
  live: 'cmd.usage.freshness.live',
  stale: 'cmd.usage.freshness.stale',
  never: 'cmd.usage.freshness.never',
  unsupported: 'cmd.usage.freshness.unsupported',
};

function formatPercent(value: number | null): string {
  if (value === null) return t('cmd.usage.unavailable');
  return `${Number((value * 100).toFixed(1))}%`;
}

function formatEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function windowLabel(window: UsageWindow): string {
  if (window.type === 'model_scoped' && window.label) return window.label;
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

function formatProvider(record: ProviderUsage): string[] {
  const lines = [t('cmd.usage.providerLine', {
    name: record.displayName,
    provider: record.provider,
    freshness: t(FRESHNESS_KEYS[record.freshness]),
  })];
  lines.push(...record.windows.map(formatWindow));
  const spend = formatSpend(record);
  if (spend) lines.push(spend);
  if (record.observedAt !== null) lines.push(t('cmd.usage.observedLine', { time: formatEpoch(record.observedAt) }));
  if (record.note) lines.push(t('cmd.usage.noteLine', { note: record.note }));
  return lines;
}

function matchesProvider(record: ProviderUsage, provider: string): boolean {
  const normalized = provider.toLowerCase();
  return record.provider.toLowerCase() === normalized
    || record.displayName.toLowerCase() === normalized;
}

function filteredRecords(records: ProviderUsage[], provider?: string): ProviderUsage[] {
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

function providerArgument(message: string): string | undefined {
  const provider = message.split(/\s+/).slice(1).join(' ').trim();
  return provider || undefined;
}

function refreshButton(provider?: string) {
  return {
    type: 'button' as const,
    text: t('cmd.usage.refreshButton'),
    actionId: 'cmd:usage:refresh',
    value: provider ?? '',
  };
}

async function updateUsageMessage(
  router: CommandActionRouter,
  service: UsageCommandService,
  ctx: import('@platform/index.js').ActionContext,
): Promise<void> {
  const adapter = router.getAdapter();
  if (!adapter || !ctx.messageRef) return;
  const provider = ctx.value || undefined;
  const text = formatUsageReport(await service.refresh(), provider);
  await adapter.updateMessage(ctx.messageRef, {
    text,
    richBlocks: [
      { type: 'section', text },
      { type: 'actions', elements: [refreshButton(provider)] },
    ],
  });
}

function registerUsageRefresh(router: CommandActionRouter, service: UsageCommandService): void {
  router.registerCommand('usage', {
    actions: [{
      actionId: 'refresh',
      handler: (ctx) => updateUsageMessage(router, service, ctx),
    }],
  });
}

export function createUsageHandler(
  router?: CommandActionRouter,
  service: UsageCommandService = usageService,
) {
  if (router) registerUsageRefresh(router, service);
  return async function handleUsageCmd(
    _channel: string,
    _adapter: PlatformAdapter,
    message: string,
  ): Promise<CommandResult> {
    const provider = providerArgument(message);
    const text = formatUsageReport(await service.getStatus(), provider);
    if (!router) return { text };
    return {
      text,
      richBlocks: [{ type: 'section', text }],
      actions: [refreshButton(provider)],
    };
  };
}
