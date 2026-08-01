// input:  channel text, adapter, optional mutation lease
// output: fire-and-forget Web user turn routing
// pos:    Web session turn admission adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { IncomingMessage, PlatformAdapter } from '@platform/index.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import { agentRunner, type AgentRunnerCtx } from './agent-runner.js';
import type { TurnMutationRelease } from './turn-mutation-lock.js';

/** Sender id for web-originated user turns. Distinct from SYNTHETIC_CALLBACK_SENDER so the message
 *  flows through route as a real user message (not a self-consumed callback). */
export const WEB_UI_SENDER = 'cortex-web-ui';

export function buildWebUserMessage(
  channel: string,
  text: string,
  attachments?: AttachmentMeta[],
): IncomingMessage {
  return {
    ref: { conduit: channel, messageId: `web_${Date.now()}` },
    text,
    senderId: WEB_UI_SENDER,
    isBot: false,
    kind: 'user',
    raw: { source: 'web-ui' },
    webAttachments: attachments,
  };
}

/**
 * Fire-and-forget: build a genuine user message for `channel` and route it through the agent.
 * `route` is injectable for tests; defaults to the agentRunner singleton. Errors are swallowed
 * (the assistant reply and any failure surface via the session's normal channels, not here).
 */
export function sendWebUserMessage(opts: {
  channel: string;
  text: string;
  attachments?: AttachmentMeta[];
  adapter: PlatformAdapter;
  mutationRelease?: TurnMutationRelease;
  route?: (ctx: AgentRunnerCtx) => Promise<void>;
}): void {
  const message = buildWebUserMessage(opts.channel, opts.text, opts.attachments);
  const route = opts.route ?? ((ctx: AgentRunnerCtx) => agentRunner.route(ctx));
  void route({
    message,
    channel: opts.channel,
    adapter: opts.adapter,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: opts.text,
    agentMessage: opts.text,
    mutationRelease: opts.mutationRelease,
  }).catch(() => { /* fire-and-forget */ });
}
