import { t } from '@core/i18n.js';
import { CODEX_PROVIDER } from '@core/codex-quota.js';
import type { MessageKey } from '@core/locales/en.js';
import { redeemCodexReset, type CodexResetResult, type CodexResetStatus } from '@domain/costs/codex-reset.js';
import { usageService } from '@domain/costs/usage-service.js';
import type { ProviderUsage, UsageFreshness, UsageWindow } from '@domain/costs/usage-store.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type { ActionContext, ActionElement, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';

export interface UsageCommandService {
  getStatus(): Promise<ProviderUsage[]>;
  refresh(): Promise<ProviderUsage[]>;
}

export type CodexResetRedeemer = (creditId?: string) => Promise<CodexResetResult>;

/** Opens the confirm step for spending a banked Codex reset; also carried by the throttle notice. */
export const USAGE_RESET_ACTION_ID = 'cmd:usage:reset';

const RESET_STATUS_KEYS: Record<CodexResetStatus, MessageKey> = {
  reset: 'cmd.usage.resetDone',
  nothing_to_reset: 'cmd.usage.resetNothing',
  no_credit: 'cmd.usage.resetNoCredit',
  already_redeemed: 'cmd.usage.resetAlreadyRedeemed',
  unavailable: 'cmd.usage.resetUnavailable',
};

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

function formatResetCredits(record: ProviderUsage): string | null {
  if (!record.resetCredits) return null;
  const earliest = record.resetCredits.credits[0]?.expiresAt ?? null;
  const expiry = earliest === null ? '' : t('cmd.usage.resetExpirySuffix', { time: formatEpoch(earliest) });
  return t('cmd.usage.resetCreditsLine', { count: record.resetCredits.availableCount, expiry });
}

function formatProvider(record: ProviderUsage): string[] {
  const lines = [t('cmd.usage.providerLine', {
    name: record.displayName,
    provider: record.provider,
    freshness: t(FRESHNESS_KEYS[record.freshness]),
  })];
  lines.push(...record.windows.map(formatWindow));
  const resets = formatResetCredits(record);
  if (resets) lines.push(resets);
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

function refreshButton(provider?: string): ActionElement {
  return {
    type: 'button' as const,
    text: t('cmd.usage.refreshButton'),
    actionId: 'cmd:usage:refresh',
    value: provider ?? '',
  };
}

/** True when the cached Codex row says the account holds a reset to spend. */
export function hasCodexResets(records: ProviderUsage[]): boolean {
  return records.some((record) => record.provider === CODEX_PROVIDER
    && (record.resetCredits?.availableCount ?? 0) > 0);
}

export function codexResetButton(): ActionElement {
  return { type: 'button', text: t('cmd.usage.resetButton'), actionId: USAGE_RESET_ACTION_ID, value: '' };
}

/** The Codex throttle notice's extra button, offered while the account is known to hold a reset. */
export async function codexResetNoticeActions(
  provider: string,
  service: Pick<UsageCommandService, 'getStatus'> = usageService,
): Promise<ActionElement[]> {
  if (provider !== CODEX_PROVIDER) return [];
  return hasCodexResets(await service.getStatus()) ? [codexResetButton()] : [];
}

function usageActions(records: ProviderUsage[], provider?: string): ActionElement[] {
  const actions = [refreshButton(provider)];
  if (hasCodexResets(filteredRecords(records, provider))) actions.push(codexResetButton());
  return actions;
}

async function updateUsageMessage(
  router: CommandActionRouter,
  service: UsageCommandService,
  ctx: ActionContext,
): Promise<void> {
  const adapter = router.getAdapter();
  if (!adapter || !ctx.messageRef) return;
  const provider = ctx.value || undefined;
  const records = await service.refresh();
  const text = formatUsageReport(records, provider);
  await adapter.updateMessage(ctx.messageRef, {
    text,
    richBlocks: [
      { type: 'section', text },
      { type: 'actions', elements: usageActions(records, provider) },
    ],
  });
}

/** Step one: a threaded confirm prompt, so a single click never spends a reset. */
async function postResetConfirm(router: CommandActionRouter, ctx: ActionContext): Promise<void> {
  const adapter = router.getAdapter();
  if (!adapter) return;
  const anchor = ctx.messageRef?.threadId ?? ctx.messageRef?.messageId;
  await adapter.postInteractive(
    { type: 'interactive-reply', conduit: ctx.messageRef?.conduit ?? ctx.channelId, sessionId: '' },
    {
      text: t('cmd.usage.resetConfirm'),
      actions: [
        { type: 'button', text: t('cmd.usage.resetConfirmButton'), actionId: 'cmd:usage:reset-confirm', value: '', style: 'danger' },
        { type: 'button', text: t('cmd.usage.resetCancelButton'), actionId: 'cmd:usage:reset-cancel', value: '' },
      ],
    },
    anchor ? { threadId: anchor } : undefined,
  );
}

function codexReport(records: ProviderUsage[]): string | null {
  return records.some((record) => record.provider === CODEX_PROVIDER)
    ? formatUsageReport(records, CODEX_PROVIDER)
    : null;
}

export async function codexResetOutcomeText(redeem: CodexResetRedeemer): Promise<string> {
  try {
    const result = await redeem();
    const line = t(RESET_STATUS_KEYS[result.status]);
    const report = result.status === 'reset' ? codexReport(result.usage) : null;
    return report ? `${line}\n\n${report}` : line;
  } catch (error) {
    return t('cmd.usage.resetFailed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Replace the prompt (and its buttons) with plain text. */
async function settlePrompt(router: CommandActionRouter, ctx: ActionContext, text: string): Promise<void> {
  const adapter = router.getAdapter();
  if (!adapter || !ctx.messageRef) return;
  await adapter.updateMessage(ctx.messageRef, { text, richBlocks: [{ type: 'section', text }] });
}

/** Step two: the buttons go first, so a second click finds nothing to press. */
async function runReset(router: CommandActionRouter, redeem: CodexResetRedeemer, ctx: ActionContext): Promise<void> {
  await settlePrompt(router, ctx, t('cmd.usage.resetRunning'));
  await settlePrompt(router, ctx, await codexResetOutcomeText(redeem));
}

function registerUsageActions(
  router: CommandActionRouter,
  service: UsageCommandService,
  redeem: CodexResetRedeemer,
): void {
  router.registerCommand('usage', {
    actions: [
      { actionId: 'refresh', handler: (ctx) => updateUsageMessage(router, service, ctx) },
      { actionId: 'reset', handler: (ctx) => postResetConfirm(router, ctx) },
      { actionId: 'reset-confirm', handler: (ctx) => runReset(router, redeem, ctx) },
      { actionId: 'reset-cancel', handler: (ctx) => settlePrompt(router, ctx, t('cmd.usage.resetCancelled')) },
    ],
  });
}

export function createUsageHandler(
  router?: CommandActionRouter,
  service: UsageCommandService = usageService,
  redeem: CodexResetRedeemer = redeemCodexReset,
) {
  if (router) registerUsageActions(router, service, redeem);
  return async function handleUsageCmd(
    _channel: string,
    _adapter: PlatformAdapter,
    message: string,
  ): Promise<CommandResult> {
    const provider = providerArgument(message);
    const records = await service.getStatus();
    const text = formatUsageReport(records, provider);
    if (!router) return { text };
    return {
      text,
      richBlocks: [{ type: 'section', text }],
      actions: usageActions(records, provider),
    };
  };
}
