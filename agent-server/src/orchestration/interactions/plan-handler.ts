import type { PlatformAdapter } from '@platform/index.js';
import { postOnce } from '@platform/index.js';
import { Icons } from '../../core/icons.js';
import { t } from '../../core/i18n.js';


async function sendPlanToSlack(
  planContent: string | null,
  channel: string,
  adapter: PlatformAdapter,
  { machine, threadAnchorId }: { machine?: string; threadAnchorId?: string | null } = {},
): Promise<void> {
  if (!planContent) {
    const label = machine ? `**[PLAN: ${machine}]**` : '**[PLAN]**';
    await postOnce(adapter, { type: 'interactive-reply', conduit: channel, sessionId: '' }, `${Icons.memo} ${label} ${t('notice.plan.noContent')}`, { threadId: threadAnchorId });
    return;
  }

  const label = '**[PLAN]**';
  const prompt = t('notice.plan.generated');

  await postOnce(adapter, { type: 'interactive-reply', conduit: channel, sessionId: '' }, `${Icons.memo} ${label} ${prompt}\n${planContent}`, { threadId: threadAnchorId });
}
export { sendPlanToSlack };
