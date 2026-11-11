import { t } from '@core/i18n.js';
import type { MessageKey } from '@core/locales/en.js';
import { redeemUsageReset, type UsageResetResult } from '@domain/costs/account-reset.js';
import {
  isResetProvider, RESET_PROVIDERS, type ResetProvider, type ResetStatus,
} from '@domain/costs/reset-account.js';
import { kindsClearing, resetCreditKinds, type ResetCreditKind } from '@domain/costs/reset-kinds.js';
import { usageService } from '@domain/costs/usage-service.js';
import { nextResetCredit, type ProviderUsage, type UsageResetCredit } from '@domain/costs/usage-store.js';
import type { ActionBinding, CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type { ActionContext, ActionElement } from '@platform/index.js';
import {
  clearedWindowLabel, filteredRecords, formatPercent, formatUsageReport, resetKindName, windowLabel,
} from './usage-format.js';

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

function rowKinds(row: ProviderUsage | undefined): ResetCreditKind[] {
  return row?.resetCredits ? resetCreditKinds(row.resetCredits) : [];
}

/** A reset action's value: the provider, then the credit to spend when the account holds more
 *  than one kind of reset (credit ids never contain `:`). */
interface ResetTarget {
  provider: ResetProvider;
  creditId?: string;
}

function targetValue(target: ResetTarget): string {
  return target.creditId ? `${target.provider}:${target.creditId}` : target.provider;
}

function parseTarget(value: string): ResetTarget | null {
  const [provider, creditId] = value.split(':', 2);
  if (!isResetProvider(provider)) return null;
  return creditId ? { provider, creditId } : { provider };
}

export function usageResetButton(provider: ResetProvider): ActionElement {
  return {
    type: 'button',
    text: t('cmd.usage.resetButton', { name: RESET_NAMES[provider] }),
    actionId: USAGE_RESET_ACTION_ID,
    value: provider,
  };
}

function kindButton(provider: ResetProvider, row: ProviderUsage | undefined, kind: ResetCreditKind): ActionElement {
  const name = resetKindName(row, kind.clears);
  if (!name || !kind.credit) return usageResetButton(provider);
  return {
    type: 'button',
    text: t('cmd.usage.resetKindButton', { kind: name, name: RESET_NAMES[provider] }),
    actionId: USAGE_RESET_ACTION_ID,
    value: targetValue({ provider, creditId: kind.credit.id }),
  };
}

/** One button per offered kind while the account holds several kinds, else one plain button. */
function resetButtonsFor(provider: ResetProvider, row: ProviderUsage | undefined, windowType?: string): ActionElement[] {
  const kinds = rowKinds(row);
  if (kinds.length <= 1) return [usageResetButton(provider)];
  return kindsClearing(kinds, windowType).map((kind) => kindButton(provider, row, kind));
}

/** Reset buttons for each provider in the shown rows whose account holds a reset to spend. */
export function usageResetButtons(records: ProviderUsage[], provider?: string): ActionElement[] {
  const shown = filteredRecords(records, provider);
  return RESET_PROVIDERS
    .filter((candidate) => hasResets(shown, candidate))
    .flatMap((candidate) => resetButtonsFor(candidate, resetRow(shown, candidate)));
}

/** A throttle notice's extra buttons, offered while the throttled account is known to hold a
 *  reset: only the kinds that lift the limited window. */
export async function usageResetNoticeActions(
  provider: string,
  windowType?: string,
  service: UsageStatusReader = usageService,
): Promise<ActionElement[]> {
  if (!isResetProvider(provider)) return [];
  const records = await service.getStatus();
  return hasResets(records, provider) ? resetButtonsFor(provider, resetRow(records, provider), windowType) : [];
}

function chosenCredit(row: ProviderUsage | undefined, creditId?: string): UsageResetCredit | null {
  const credits = row?.resetCredits;
  if (!credits) return null;
  return credits.credits.find((credit) => credit.id === creditId) ?? nextResetCredit(credits);
}

/** Current use of the windows the reset clears, for a confirm sent while not at a limit. */
function notAtLimitLine(row: ProviderUsage, clears: string[]): string {
  const usage = row.windows
    .filter((window) => clears.length === 0 || clears.includes(window.type))
    .map((window) => `${windowLabel(window)} ${formatPercent(window.utilization)}`)
    .join(' · ');
  return t('cmd.usage.resetNotAtLimit', { usage: usage || t('cmd.usage.unavailable') });
}

export function usageResetConfirmText(provider: ResetProvider, records: ProviderUsage[], creditId?: string): string {
  const row = resetRow(records, provider);
  const clears = chosenCredit(row, creditId)?.clears ?? [];
  const windows = clears.map((type) => clearedWindowLabel(row, type)).join(', ') || t('cmd.usage.resetAllWindows');
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
  const target = parseTarget(ctx.value);
  if (!adapter || !target) return;
  const anchor = ctx.messageRef?.threadId ?? ctx.messageRef?.messageId;
  await adapter.postInteractive(
    { type: 'interactive-reply', conduit: ctx.messageRef?.conduit ?? ctx.channelId, sessionId: '' },
    {
      text: usageResetConfirmText(target.provider, await service.getStatus(), target.creditId),
      actions: [
        { type: 'button', text: t('cmd.usage.resetConfirmButton'), actionId: 'cmd:usage:reset-confirm', value: ctx.value, style: 'danger' },
        { type: 'button', text: t('cmd.usage.resetCancelButton'), actionId: 'cmd:usage:reset-cancel', value: ctx.value },
      ],
    },
    anchor ? { threadId: anchor } : undefined,
  );
}

export async function usageResetOutcomeText(
  provider: ResetProvider, redeem: UsageResetRedeemer, creditId?: string,
): Promise<string> {
  const name = RESET_NAMES[provider];
  try {
    const result = await redeem(provider, creditId);
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
  const target = parseTarget(ctx.value);
  if (!target) return;
  const name = RESET_NAMES[target.provider];
  await settlePrompt(router, ctx, t('cmd.usage.resetRunning', { name }));
  await settlePrompt(router, ctx, await usageResetOutcomeText(target.provider, redeem, target.creditId));
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
