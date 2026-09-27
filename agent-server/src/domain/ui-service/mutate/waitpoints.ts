import { t } from '@core/i18n.js';
import type { Result, UiServiceDeps, WaitpointsCancelArgs, WaitpointsCancelReturn } from '../types.js';

export async function handleCancelWaitpoint(
  deps: UiServiceDeps,
  args: WaitpointsCancelArgs,
): Promise<Result<WaitpointsCancelReturn>> {
  if (!deps.waitpointRegistry) {
    return { ok: false, code: 'not-available', message: t('ui.waitpoint.unavailable') };
  }
  try {
    const outcome = await deps.waitpointRegistry.cancel(args.waitpointId);
    if (!outcome.cancelled && !outcome.state) {
      return { ok: false, code: 'not-found', message: t('ui.waitpoint.notFound', { id: args.waitpointId }) };
    }
    return { ok: true, data: { cancelled: outcome.cancelled, state: outcome.state ?? null } };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}
