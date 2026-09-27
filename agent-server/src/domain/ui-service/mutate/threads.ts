import { t } from '@core/i18n.js';
import { cancelThread } from '@domain/threads/index.js';
import type { UiServiceDeps, Result, ThreadsCancelReturn } from '../types.js';

export async function handleCancelThread(
  deps: UiServiceDeps,
  args: { threadId: string },
): Promise<Result<ThreadsCancelReturn>> {
  try {
    const cancelled = await cancelThread(args.threadId);
    if (!cancelled) {
      // thread not found or already terminal
      const thread = deps.threadStore.get(args.threadId);
      if (!thread) {
        return { ok: false, code: 'not-found', message: t('ui.thread.notFound', { id: args.threadId }) };
      }
      return { ok: false, code: 'already-terminal', message: t('ui.thread.alreadyTerminal', { id: args.threadId }) };
    }
    return { ok: true, data: { cancelled: true } };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}
