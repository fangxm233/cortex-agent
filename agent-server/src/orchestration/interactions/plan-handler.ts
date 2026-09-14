import type { PlatformAdapter } from '@platform/index.js';
import { postOnce } from '@platform/index.js';
import { Icons } from '../../core/icons.js';


async function sendPlanToSlack(
  planContent: string | null,
  channel: string,
  adapter: PlatformAdapter,
  { machine, threadAnchorId }: { machine?: string; threadAnchorId?: string | null } = {},
): Promise<void> {
  if (!planContent) {
    const label = machine ? `**[PLAN: ${machine}]**` : '**[PLAN]**';
    await postOnce(adapter, { type: 'interactive-reply', conduit: channel, sessionId: '' }, `${Icons.memo} ${label} Plan generated but no content found.`, { threadId: threadAnchorId });
    return;
  }

  const label = '**[PLAN]**';
  const prompt = 'Generated plan — use the buttons below to approve or provide feedback:';

  await postOnce(adapter, { type: 'interactive-reply', conduit: channel, sessionId: '' }, `${Icons.memo} ${label} ${prompt}\n${planContent}`, { threadId: threadAnchorId });
}
export { sendPlanToSlack };
