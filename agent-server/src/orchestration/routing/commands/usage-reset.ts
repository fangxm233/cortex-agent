import { t } from '@core/i18n.js';
import { SUBSCRIPTION_CONNECTION } from '@core/connections-file.js';
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

/** Spends a reset of the provider's default login, or of the account `connection`. */
export type UsageResetRedeemer = (
  provider: ResetProvider, creditId?: string, connection?: string | null,
) => Promise<UsageResetResult>;

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

/** One account's subscription row, the one that carries its banked resets; no account: the
 *  provider's default login. */
function resetRow(records: ProviderUsage[], provider: string, account?: string): ProviderUsage | undefined {
  return records.find((record) => record.provider === provider && record.billing !== 'api'
    && (record.route ?? undefined) === account);
}

function rowHasResets(row: ProviderUsage | undefined): boolean {
  return (row?.resetCredits?.availableCount ?? 0) > 0;
}

/** The product name, with the account beside it for any login but the default. */
function resetName(provider: ResetProvider, account?: string, row?: ProviderUsage): string {
  return account ? `${RESET_NAMES[provider]} (${row?.label ?? account})` : RESET_NAMES[provider];
}

/** The account a throttle route stands for: none for the default login, whose route is
 *  `subscription` (Claude) or the provider's own name (PI). */
function routeAccount(provider: string, route?: string | null): string | undefined {
  return route && route !== SUBSCRIPTION_CONNECTION && route !== provider ? route : undefined;
}

function rowKinds(row: ProviderUsage | undefined): ResetCreditKind[] {
  return row?.resetCredits ? resetCreditKinds(row.resetCredits) : [];
}

/** A reset action's value: the provider, `@account` unless it is the default login, then `:` and
 *  the credit to spend when the account holds more than one kind of reset (account and credit ids
 *  never contain `@` or `:`). */
interface ResetTarget {
  provider: ResetProvider;
  account?: string;
  creditId?: string;
}

function targetValue(target: ResetTarget): string {
  const base = target.account ? `${target.provider}@${target.account}` : target.provider;
  return target.creditId ? `${base}:${target.creditId}` : base;
}

function parseTarget(value: string): ResetTarget | null {
  const [head, creditId] = value.split(':', 2);
  const [provider, account] = head.split('@', 2);
  if (!isResetProvider(provider)) return null;
  return { provider, ...(account ? { account } : {}), ...(creditId ? { creditId } : {}) };
}

export function usageResetButton(provider: ResetProvider, account?: string, row?: ProviderUsage): ActionElement {
  return {
    type: 'button',
    text: t('cmd.usage.resetButton', { name: resetName(provider, account, row) }),
    actionId: USAGE_RESET_ACTION_ID,
    value: targetValue({ provider, account }),
  };
}

function kindButton(
  provider: ResetProvider, account: string | undefined, row: ProviderUsage | undefined, kind: ResetCreditKind,
): ActionElement {
  const name = resetKindName(row, kind.clears);
  if (!name || !kind.credit) return usageResetButton(provider, account, row);
  return {
    type: 'button',
    text: t('cmd.usage.resetKindButton', { kind: name, name: resetName(provider, account, row) }),
    actionId: USAGE_RESET_ACTION_ID,
    value: targetValue({ provider, account, creditId: kind.credit.id }),
  };
}

/** One button per offered kind while the account holds several kinds, else one plain button. */
function resetButtonsFor(
  provider: ResetProvider, account: string | undefined, row: ProviderUsage | undefined, windowType?: string,
): ActionElement[] {
  const kinds = rowKinds(row);
  if (kinds.length <= 1) return [usageResetButton(provider, account, row)];
  return kindsClearing(kinds, windowType).map((kind) => kindButton(provider, account, row, kind));
}

/** Reset buttons for each shown subscription row — one per account — that holds a reset to spend. */
export function usageResetButtons(records: ProviderUsage[], provider?: string): ActionElement[] {
  const shown = filteredRecords(records, provider);
  return RESET_PROVIDERS.flatMap((candidate) => shown
    .filter((row) => row.provider === candidate && row.billing !== 'api' && rowHasResets(row))
    .flatMap((row) => resetButtonsFor(candidate, row.route ?? undefined, row)));
}

/** A throttle notice's extra buttons, offered while the throttled account (`route`) is known to
 *  hold a reset: only the kinds that lift the limited window. */
export async function usageResetNoticeActions(
  provider: string,
  route: string | null | undefined,
  windowType?: string,
  service: UsageStatusReader = usageService,
): Promise<ActionElement[]> {
  if (!isResetProvider(provider)) return [];
  const account = routeAccount(provider, route);
  const row = resetRow(await service.getStatus(), provider, account);
  return rowHasResets(row) ? resetButtonsFor(provider, account, row, windowType) : [];
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

export function usageResetConfirmText(
  provider: ResetProvider, records: ProviderUsage[], creditId?: string, account?: string,
): string {
  const row = resetRow(records, provider, account);
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
      text: usageResetConfirmText(target.provider, await service.getStatus(), target.creditId, target.account),
      actions: [
        { type: 'button', text: t('cmd.usage.resetConfirmButton'), actionId: 'cmd:usage:reset-confirm', value: ctx.value, style: 'danger' },
        { type: 'button', text: t('cmd.usage.resetCancelButton'), actionId: 'cmd:usage:reset-cancel', value: ctx.value },
      ],
    },
    anchor ? { threadId: anchor } : undefined,
  );
}

export async function usageResetOutcomeText(
  provider: ResetProvider, redeem: UsageResetRedeemer, creditId?: string, account?: string,
): Promise<string> {
  const name = resetName(provider, account);
  try {
    const result = await redeem(provider, creditId, account ?? null);
    const line = t(RESET_STATUS_KEYS[result.status], { name });
    const row = result.status === 'reset' ? resetRow(result.usage, provider, account) : undefined;
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
  const name = resetName(target.provider, target.account);
  await settlePrompt(router, ctx, t('cmd.usage.resetRunning', { name }));
  await settlePrompt(router, ctx, await usageResetOutcomeText(target.provider, redeem, target.creditId, target.account));
}

const redeemDefault: UsageResetRedeemer = (provider, creditId, connection) =>
  redeemUsageReset(provider, creditId, {}, connection);

export function usageResetActions(
  router: CommandActionRouter,
  service: UsageStatusReader,
  redeem: UsageResetRedeemer = redeemDefault,
): ActionBinding[] {
  return [
    { actionId: 'reset', handler: (ctx) => postResetConfirm(router, service, ctx) },
    { actionId: 'reset-confirm', handler: (ctx) => runReset(router, redeem, ctx) },
    { actionId: 'reset-cancel', handler: (ctx) => settlePrompt(router, ctx, t('cmd.usage.resetCancelled')) },
  ];
}
