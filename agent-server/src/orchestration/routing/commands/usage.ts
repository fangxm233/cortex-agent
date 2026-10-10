import { t } from '@core/i18n.js';
import { usageService } from '@domain/costs/usage-service.js';
import type { ProviderUsage } from '@domain/costs/usage-store.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type { ActionContext, ActionElement, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import { formatUsageReport } from './usage-format.js';
import { usageResetActions, usageResetButtons, type UsageResetRedeemer } from './usage-reset.js';

export interface UsageCommandService {
  getStatus(): Promise<ProviderUsage[]>;
  refresh(): Promise<ProviderUsage[]>;
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

function usageActions(records: ProviderUsage[], provider?: string): ActionElement[] {
  return [refreshButton(provider), ...usageResetButtons(records, provider)];
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

export function createUsageHandler(
  router?: CommandActionRouter,
  service: UsageCommandService = usageService,
  redeem?: UsageResetRedeemer,
) {
  router?.registerCommand('usage', {
    actions: [
      { actionId: 'refresh', handler: (ctx) => updateUsageMessage(router, service, ctx) },
      ...usageResetActions(router, service, redeem),
    ],
  });
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
