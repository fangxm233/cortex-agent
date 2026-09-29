import type { PlatformAdapter } from '@platform/index.js';
import { postOnce } from '@platform/index.js';
import { Icons } from '../../core/icons.js';
import { t } from '../../core/i18n.js';


async function sendPlanToSlack(
  planContent: string | null,
  channel: string,
  adapter: PlatformAdapter,
): Promise<void> {
  const label = '**[PLAN]**';
  if (!planContent) {
    await postOnce(adapter, { type: 'interactive-reply', conduit: channel, sessionId: '' }, `${Icons.memo} ${label} ${t('notice.plan.noContent')}`);
    return;
  }

  const prompt = t('notice.plan.generated');

  await postOnce(adapter, { type: 'interactive-reply', conduit: channel, sessionId: '' }, `${Icons.memo} ${label} ${prompt}\n${planContent}`);
}
export { sendPlanToSlack };
