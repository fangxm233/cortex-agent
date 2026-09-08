// input:  EventBus, PlatformAdapter, PlanApprovals
// output: registerHookBridgeSubscribers(bus, adapter, planApprovals) — extracts
//         ask-user.requested / plan.submitted handler bodies from entry/app.ts into orch/,
//         plus non-blocking-ask answer delivery as an ordinary user turn
// pos:    orch/routing/ — hook-bridge event subscribers (S13 composition-root extraction)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { EventBus, CortexEvent } from '@events/index.js';
import type { Destination, PlatformAdapter, OutputStream } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { buildPlanApprovalContent, askLevelIcon } from '@platform/index.js';
import * as askUserQuestion from '@orch/interactions/ask-user-question.js';
import { sendPlanToSlack } from '@orch/interactions/plan-handler.js';
import type { PlanApprovals } from '@orch/interactions/plan-approvals.js';
import { interactionRecords as defaultInteractionRecords, type InteractionRecords } from '@orch/interactions/interaction-records.js';
import { resolveRequest as resolveHookRequest, getStreamingCallback } from './hook-bridge.js';
import { sendWebUserMessage } from '../session-send.js';

const log = createLogger('hook-bridge');

/** Delivery seam for a non-blocking ask's answer; production binds it to the web-user-turn sender. */
export type UserMessageSender = (opts: { channel: string; text: string; adapter: PlatformAdapter }) => void;

/**
 * Non-blocking ask (`cortex_ask_user blocking:false`): the tool call already returned, so the
 * answer cannot come back as a tool_result. It is delivered as a genuine user turn on the
 * session's channel instead — the same seam a typed message uses, so it folds into a live turn
 * when one is running and opens a fresh turn when the session is idle. Null ⇒ nothing to say.
 */
function askAnswerMessageText(answers: Record<string, unknown>): string | null {
  const parts = Object.entries(answers ?? {})
    .map(([question, value]) => {
      const answer = Array.isArray(value) ? value.join(', ') : String(value ?? '');
      return `Q: ${question}\nA: ${answer.trim() ? answer : '(no answer)'}`;
    });
  if (parts.length === 0) return null;
  return `[Answer to the question you asked earlier via cortex_ask_user]\n\n${parts.join('\n\n')}`;
}

export function registerHookBridgeSubscribers(
  bus: EventBus,
  adapter: PlatformAdapter,
  planApprovals: PlanApprovals,
  interactions: InteractionRecords = defaultInteractionRecords,
  sendUserMessage: UserMessageSender = sendWebUserMessage,
): void {
  bus.subscribe('ask-user.requested', async (e) => {
    const ev = e as Extract<CortexEvent, { type: 'ask-user.requested' }>;
    if (ev.dryRun) return; // smoke-test: event is journalled, skip Slack post
    try {
      const group = askUserQuestion.createHookGroup(ev.requestId, ev.channel, ev.sessionId, ev.questions, ev.extensionUiId, ev.threadId ?? null, ev.level ?? null);
      const nonBlocking = ev.blocking === false;
      askUserQuestion.registerHookResolver(ev.requestId, (data) => {
        // Clearing the pending entry first keeps the TTL sweep off an answered non-blocking card;
        // its resolve is a no-op, so nothing downstream depends on the return value.
        resolveHookRequest(ev.requestId, data);
        if (!nonBlocking) return;
        const text = askAnswerMessageText(data?.answers ?? {});
        if (text) sendUserMessage({ channel: ev.channel, text, adapter });
      });

      // Web UI (web: conduit) has no PlatformAdapter — persist the interaction entity;
      // the create() publishes session.interaction and the frontend renders the card
      // from the transcript (web-interactions-redesign).
      if (ev.channel.startsWith('web:')) {
        await interactions.create({
          id: ev.requestId,
          sessionId: ev.sessionId,
          channel: ev.channel,
          kind: 'ask-user',
          payload: {
            questions: group.questions.map((q: any) => ({
              question: q.question,
              header: q.header,
              options: q.options || [],
              multiSelect: !!q.multiSelect,
            })),
            ...(ev.level ? { level: ev.level } : {}),
            ...(nonBlocking ? { blocking: false } : {}),
          },
        });
        return;
      }

      // Inline-modal platforms (Feishu) render the question form as an inline card,
      // so the intermediate "Answer" summary card + click is redundant — post the
      // form directly. Slack requires a user click (trigger_id) to open a modal, so
      // it keeps the summary card + Answer button below. The conduit prefix is the
      // reliable per-channel signal under a multi-platform CompositeAdapter (merged
      // capabilities can't distinguish channels).
      if (ev.channel.startsWith('feishu:')) {
        // Flush any pending streamed text so the form lands after it, in order.
        const fstream = (getStreamingCallback(ev.channel) as any)?.stream as OutputStream | undefined;
        await fstream?.flush?.().catch(() => {});
        await adapter.openModal(ev.channel, askUserQuestion.buildQuestionModalDefinition(group));
        return;
      }

      // streamingCb is fetched only to extract the stream reference — not invoked directly for AskUser
      const streamingCb = getStreamingCallback(ev.channel);
      const stream = (streamingCb as any)?.stream as OutputStream | undefined;
      const levelIcon = askLevelIcon(ev.level ?? null);
      const text = `${levelIcon ? `${levelIcon} ` : ''}Questions (${group.questions.length})`;
      const richBlocks = askUserQuestion.buildQuestionGroupBlocks(group);
      // Route through stream when available so standalone post flushes pending appends
      // and resets stream state — without this, messages emitted after the form would
      // be merged back into the message that preceded it.
      const askDest: Destination = { type: 'interactive-reply', conduit: ev.channel, sessionId: ev.sessionId ?? '' };
      if (stream) {
        const ref = await stream.postInteractive(text, { richBlocks });
        group.responseMessageTs = ref?.messageId || null;
      } else {
        const ref = await adapter.postMessage(askDest, { text, richBlocks });
        group.responseMessageTs = ref.messageId;
      }
    } catch (e) {
      log.error(`Failed to post AskUserQuestion: ${(e as Error).message}`);
      resolveHookRequest(ev.requestId, { error: 'post_failed', answers: {} });
    }
  });

  bus.subscribe('plan.submitted', async (e) => {
    const ev = e as Extract<CortexEvent, { type: 'plan.submitted' }>;
    if (ev.dryRun) return; // smoke-test: event is journalled, skip Slack post + approval registration
    try {
      // Web UI: persist the interaction entity with a FULL plan-content snapshot (no
      // PlatformAdapter for web: conduits). planApprovals stays the live resolver map.
      if (ev.channel.startsWith('web:')) {
        planApprovals.register(ev.requestId, { channel: ev.channel, sessionId: ev.sessionId, extensionUiId: ev.extensionUiId ?? null, threadId: ev.threadId ?? null });
        await interactions.create({
          id: ev.requestId,
          sessionId: ev.sessionId,
          channel: ev.channel,
          kind: 'plan-approval',
          payload: {
            planContent: ev.planContent || '',
            planFilePath: ev.toolInput?.plan_file_path ?? null,
          },
        });
        return;
      }

      const streamingCb = getStreamingCallback(ev.channel);
      const stream = (streamingCb as any)?.stream as OutputStream | undefined;
      const planDest: Destination = { type: 'interactive-reply', conduit: ev.channel, sessionId: ev.sessionId ?? '' };
      if (streamingCb && ev.planContent) {
        streamingCb(ev.planContent);
      } else {
        await sendPlanToSlack(ev.planContent || null, ev.channel, adapter);
      }
      planApprovals.register(ev.requestId, { channel: ev.channel, extensionUiId: ev.extensionUiId ?? null, threadId: ev.threadId ?? null });
      const planApproval = buildPlanApprovalContent(ev.requestId);
      // Route approval form through stream so it enqueues behind the plan content append,
      // ensuring Slack ordering (plan text first, then button card) and resetting stream
      // state so subsequent assistant output starts a fresh message instead of
      // merging back into the message that preceded the form.
      if (stream) {
        await stream.postInteractive('Plan approval', {
          richBlocks: planApproval.richBlocks,
          actions: planApproval.actions,
        });
      } else {
        // Fallback path (stream already finalized after the turn): pass threadId
        // explicitly so the approval card lands inside the conversation topic via
        // message.reply instead of being posted as a standalone message.
        await adapter.postInteractive(planDest, {
          text: 'Plan approval',
          ...planApproval,
        }, { threadId: ev.threadId ?? undefined });
      }
    } catch (e) {
      log.error(`Failed to post plan: ${(e as Error).message}`);
      resolveHookRequest(ev.requestId, { error: 'post_failed', approved: true, reason: '' });
    }
  });
}
