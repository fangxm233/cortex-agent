import { t } from '@core/i18n.js';
import type { UiServiceDeps, Result, ExecutionsCancelReturn } from '../types.js';

export async function handleCancelExecution(
  deps: UiServiceDeps,
  args: { executionId: string },
): Promise<Result<ExecutionsCancelReturn>> {
  try {
    const record = deps.executionRegistry.cancelExecution(args.executionId);
    if (!record) {
      return { ok: false, code: 'not-found', message: t('ui.execution.notFound', { id: args.executionId }) };
    }
    return { ok: true, data: { cancelled: true } };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}
