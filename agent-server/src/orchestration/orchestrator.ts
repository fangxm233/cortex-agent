import type { PlatformAdapter, IncomingMessage, Destination } from '@platform/index.js';
import { SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import { agentRunner } from './agent-runner.js';
import { threadExecutor } from './thread-executor.js';
import { tryAnswerFromHuman } from './manager-qa.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';

export interface OrchMessageContext {
  message: IncomingMessage;
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  hasFiles: boolean;
  userMessage: string;
  agentMessage: string;
  threadAddMatch: RegExpMatchArray | null;
  threadStartMatch: RegExpMatchArray | null;
  existingThread: any;
  isActiveThread: boolean;
}

type Runner = { route(ctx: any): Promise<void> };
type HumanAnswerCheck = (channel: string, text: string) => boolean;

export class Orchestrator {
  private _agentRunner: Runner;
  private _threadExecutor: Runner;
  private _tryAnswerFromHuman: HumanAnswerCheck;

  constructor(deps?: { agentRunner?: Runner; threadExecutor?: Runner; tryAnswerFromHuman?: HumanAnswerCheck }) {
    this._agentRunner = deps?.agentRunner ?? agentRunner;
    this._threadExecutor = deps?.threadExecutor ?? threadExecutor;
    this._tryAnswerFromHuman = deps?.tryAnswerFromHuman ?? tryAnswerFromHuman;
  }

  /** Two-branch routing decision: thread-match path or default-agent path. */
  async handleMessage(ctx: OrchMessageContext): Promise<void> {
    const { threadAddMatch, threadStartMatch, isActiveThread } = ctx;
    if (threadAddMatch || threadStartMatch || isActiveThread) {
      await this._threadExecutor.route(ctx);
      return;
    }
    if (await this._answeredPendingQuestion(ctx)) return;
    await this._agentRunner.route(ctx);
  }

  /**
   * DR-0016 top-level fallback: if this channel has a pending human-escalated subtask question,
   * consume this message as the answer and short-circuit normal turn handling. Scope is narrow —
   * tryAnswerFromHuman returns false unless this exact channel is awaiting a human reply.
   *
   * Synthetic wake/callback messages are exempt: askManager arms this backstop and then wakes the
   * origin session through a delivery of its own, so without the exemption the backstop consumed
   * the question notice itself as "the human's answer" (2026-07-05 self-consumption bug).
   *
   * It sits here, not in `AgentRunner`, because it is a routing decision — nothing about it
   * belongs to executing a turn — and because the thread branch above must not see it (a message
   * addressed to a live thread was never a candidate answer).
   */
  private async _answeredPendingQuestion(ctx: OrchMessageContext): Promise<boolean> {
    const { message, channel, adapter } = ctx;
    if (message.senderId === SYNTHETIC_CALLBACK_SENDER) return false;
    if (!this._tryAnswerFromHuman(channel, ctx.userMessage || '')) return false;
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
    await adapter.postMessage(dest, { text: `${Icons.ok} ${t('subtask.replyDelivered')}` }).catch(() => {});
    return true;
  }
}

export const orchestrator = new Orchestrator();
