// input:  runtime settings, platform adapter, outbound queue
// output: turn notification gates and completion notifier
// pos:    Pushes completion notices for long interactive turns
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { buildSessionTag } from '../core/status-format.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import { getOutboundQueue, durablePost } from '@store/outbound-queue.js';
import { isInteractiveChannel } from './bg-continuation.js';

const log = createLogger('turn-notify');

/** Feature gate: turn-completion notification is ON by default. */
export function isTurnNotifyEnabled(): boolean {
  return getSettings().turnNotify;
}

/** Minimum turn duration (seconds) before a completion notification is pushed. */
export function getTurnNotifyThresholdS(): number {
  return getSettings().turnNotifyThresholdS;
}

/** Push a NEW message to the conversation's channel when a long-running, user-initiated
 *  turn finishes — so the user gets an actual push notification (editing the status
 *  message to "✓ Done" does not notify on Slack or Feishu). Works for both Slack and
 *  Feishu through the PlatformAdapter abstraction (Composite fans out to both).
 *
 *  Gated by: feature flag, interactive-channel scope, and a duration threshold.
 *  Never throws — a failed notification must not affect the main turn. */
export async function maybeNotifyTurnComplete(params: {
  adapter: PlatformAdapter;
  channel: string;
  threadAnchorId: string | null;
  sessionName: string | null;
  sessionId: string | null;
  elapsedS: number;
  elapsedStr: string;
  status: 'completed' | 'failed';
  metricsSuffix?: string;
}): Promise<void> {
  const { adapter, channel, threadAnchorId, sessionName, sessionId, elapsedS, elapsedStr, status, metricsSuffix } = params;
  try {
    if (!isTurnNotifyEnabled()) return;
    if (!isInteractiveChannel(channel)) return;
    if (elapsedS < getTurnNotifyThresholdS()) return;

    const sessionTag = buildSessionTag(sessionName, sessionId);
    const text = status === 'completed'
      ? `${Icons.ok} ${t('notify.turnComplete')} | ${sessionTag}(${elapsedStr}${metricsSuffix ?? ''})`
      : `${Icons.error} ${t('notify.turnFailed')} | ${sessionTag}(${elapsedStr})`;

    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: sessionId ?? '' };
    const opts = threadAnchorId ? { threadId: threadAnchorId } : undefined;
    const queue = getOutboundQueue();
    if (queue) {
      await durablePost(queue, adapter, dest, { text }, opts);
    } else {
      await adapter.postMessage(dest, { text }, opts);
    }
  } catch (err) {
    log.warn('turn-complete notification failed:', (err as Error)?.message ?? err);
  }
}
