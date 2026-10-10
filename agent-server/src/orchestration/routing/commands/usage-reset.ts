import { t } from '@core/i18n.js';
import type { MessageKey } from '@core/locales/en.js';
import { redeemUsageReset, type UsageResetResult } from '@domain/costs/account-reset.js';
import {
  isResetProvider, RESET_PROVIDERS, type ResetProvider, type ResetStatus,
} from '@domain/costs/reset-account.js';
import { usageService } from '@domain/costs/usage-service.js';
import { nextResetCredit, type ProviderUsage } from '@domain/costs/usage-store.js';
import type { ActionBinding, CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type { ActionContext, ActionElement } from '@platform/index.js';
import { filteredRecords, formatPercent, formatUsageReport, windowLabel } from './usage-format.js';

export type UsageResetRedeemer = (provider: ResetProvider, creditId?: string) => Promise<UsageResetResult>;

interface UsageStatusReader {
  getStatus(): Promise<ProviderUsage[]>;
}

/** Opens the confirm step for spending a banked reset; also carried by the throttle notice. */
export const USAGE_RESET_ACTION_ID = 'cmd:usage:reset';

/** Product names, shown as-is in every locale. */
const RESET_NAMES: Record<ResetProvider, string> = {
  'openai-codex': 'Codex',
  anthropic: 'Claude',
};

const CONFIRM_KEYS: Record<ResetProvider, MessageKey> = {
  'openai-codex': 'cmd.usage.resetConfirmCodex',
  anthropic: 'cmd.usage.resetConfirmClaude',
};

const RESET_STATUS_KEYS: Record<ResetStatus, MessageKey> = {
  reset: 'cmd.usage.resetDone',
  nothing_to_reset: 'cmd.usage.resetNothing',
  no_credit: 'cmd.usage.resetNoCredit',
  already_redeemed: 'cmd.usage.resetAlreadyRedeemed',
  cooldown: 'cmd.usage.resetCooldown',
  ineligible: 'cmd.usage.resetIneligible',
  signed_out: 'cmd.usage.resetSignedOut',
};

/** The provider's subscription row, the one that carries banked resets. */
function resetRow(records: ProviderUsage[], provider: string): ProviderUsage | undefined {
  return records.find((record) => record.provider === provider && record.billing !== 'api');
}

function hasResets(records: ProviderUsage[], provider: ResetProvider): boolean {
  return (resetRow(records, provider)?.resetCredits?.availableCount ?? 0) > 0;
}

export function usageResetButton(provider: ResetProvider): ActionElement {
  return {
    type: 'button',
    text: t('cmd.usage.resetButton', { name: RESET_NAMES[provider] }),
    actionId: USAGE_RESET_ACTION_ID,
    value: provider,
  };
}

/** One reset button per provider in the shown rows whose account holds a reset to spend. */
export function usageResetButtons(records: ProviderUsage[], provider?: string): ActionElement[] {
  const shown = filteredRecords(records, provider);
  return RESET_PROVIDERS
    .filter((candidate) => hasResets(shown, candidate))
    .map(usageResetButton);
}

/** A throttle notice's extra button, offered while the throttled account is known to hold a reset. */
export async function usageResetNoticeActions(
  provider: string,
  service: UsageStatusReader = usageService,
): Promise<ActionElement[]> {
  if (!isResetProvider(provider)) return [];
  return hasResets(await service.getStatus(), provider) ? [usageResetButton(provider)] : [];
}

function clearedWindows(row: ProviderUsage | undefined): string[] {
  const credit = row?.resetCredits ? nextResetCredit(row.resetCredits) : null;
  return credit?.clears ?? [];
}

/** Current use of the windows the reset clears, for a confirm sent while not at a limit. */
function notAtLimitLine(row: ProviderUsage, clears: string[]): string {
  const usage = row.windows
    .filter((window) => clears.length === 0 || clears.includes(window.type))
    .map((window) => `${windowLabel(window)} ${formatPercent(window.utilization)}`)
    .join(' · ');
  return t('cmd.usage.resetNotAtLimit', { usage: usage || t('cmd.usage.unavailable') });
}

export function usageResetConfirmText(provider: ResetProvider, records: ProviderUsage[]): string {
  const row = resetRow(records, provider);
  const clears = clearedWindows(row);
  const windows = clears.map((type) => windowLabel({ type })).join(', ') || t('cmd.usage.resetAllWindows');
  const lines = [t(CONFIRM_KEYS[provider], { windows })];
  if (row?.resetCredits?.atLimit === false) lines.push(notAtLimitLine(row, clears));
  return lines.join('\n');
}

/** Step one: a threaded confirm prompt, so a single click never spends a reset. */
async function postResetConfirm(
  router: CommandActionRouter,
  service: UsageStatusReader,
  ctx: ActionContext,
): Promise<void> {
  const adapter = router.getAdapter();
  if (!adapter || !isResetProvider(ctx.value)) return;
  const anchor = ctx.messageRef?.threadId ?? ctx.messageRef?.messageId;
  await adapter.postInteractive(
    { type: 'interactive-reply', conduit: ctx.messageRef?.conduit ?? ctx.channelId, sessionId: '' },
    {
      text: usageResetConfirmText(ctx.value, await service.getStatus()),
      actions: [
        { type: 'button', text: t('cmd.usage.resetConfirmButton'), actionId: 'cmd:usage:reset-confirm', value: ctx.value, style: 'danger' },
        { type: 'button', text: t('cmd.usage.resetCancelButton'), actionId: 'cmd:usage:reset-cancel', value: ctx.value },
      ],
    },
    anchor ? { threadId: anchor } : undefined,
  );
}

export async function usageResetOutcomeText(provider: ResetProvider, redeem: UsageResetRedeemer): Promise<string> {
  const name = RESET_NAMES[provider];
  try {
    const result = await redeem(provider);
    const line = t(RESET_STATUS_KEYS[result.status], { name });
    const row = result.status === 'reset' ? resetRow(result.usage, provider) : undefined;
    return row ? `${line}\n\n${formatUsageReport([row])}` : line;
  } catch (error) {
    return t('cmd.usage.resetFailed', { name, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Replace the prompt (and its buttons) with plain text. */
async function settlePrompt(router: CommandActionRouter, ctx: ActionContext, text: string): Promise<void> {
  const adapter = router.getAdapter();
  if (!adapter || !ctx.messageRef) return;
  await adapter.updateMessage(ctx.messageRef, { text, richBlocks: [{ type: 'section', text }] });
}

/** Step two: the buttons go first, so a second click finds nothing to press. */
async function runReset(router: CommandActionRouter, redeem: UsageResetRedeemer, ctx: ActionContext): Promise<void> {
  if (!isResetProvider(ctx.value)) return;
  const name = RESET_NAMES[ctx.value];
  await settlePrompt(router, ctx, t('cmd.usage.resetRunning', { name }));
  await settlePrompt(router, ctx, await usageResetOutcomeText(ctx.value, redeem));
}

export function usageResetActions(
  router: CommandActionRouter,
  service: UsageStatusReader,
  redeem: UsageResetRedeemer = redeemUsageReset,
): ActionBinding[] {
  return [
    { actionId: 'reset', handler: (ctx) => postResetConfirm(router, service, ctx) },
    { actionId: 'reset-confirm', handler: (ctx) => runReset(router, redeem, ctx) },
    { actionId: 'reset-cancel', handler: (ctx) => settlePrompt(router, ctx, t('cmd.usage.resetCancelled')) },
  ];
}
