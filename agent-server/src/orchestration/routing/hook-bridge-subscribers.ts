// input:  EventBus, PlatformAdapter, PlanApprovals
// output: registerHookBridgeSubscribers(bus, adapter, planApprovals) — extracts
//         ask-user.requested / plan.submitted handler bodies from entry/app.ts into orch/
// pos:    orch/routing/ — hook-bridge event subscribers (S13 composition-root extraction)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { EventBus, CortexEvent } from '@events/index.js';
import type { Destination, PlatformAdapter, OutputStream } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { buildPlanApprovalContent } from '@platform/index.js';
import * as askUserQuestion from '@orch/interactions/ask-user-question.js';
import { sendPlanToSlack } from '@orch/interactions/plan-handler.js';
import type { PlanApprovals } from '@orch/interactions/plan-approvals.js';
import { resolveRequest as resolveHookRequest, getStreamingCallback } from './hook-bridge.js';

const log = createLogger('hook-bridge');

export function registerHookBridgeSubscribers(
  bus: EventBus,
  adapter: PlatformAdapter,
  planApprovals: PlanApprovals,
): void {
  bus.subscribe('ask-user.requested', async (e) => {
    const ev = e as Extract<CortexEvent, { type: 'ask-user.requested' }>;
    if (ev.dryRun) return; // smoke-test: event is journalled, skip Slack post
    try {
      const group = askUserQuestion.createHookGroup(ev.requestId, ev.channel, ev.sessionId, ev.questions, ev.extensionUiId, ev.threadId ?? null);
      askUserQuestion.registerHookResolver(ev.requestId, (data) => resolveHookRequest(ev.requestId, data));

      // Web UI (web: conduit) has no PlatformAdapter — route through EventBus so the
      // frontend SSE subscription picks it up and renders the AskQuestionCard.
      if (ev.channel.startsWith('web:')) {
        const webSessionId = ev.channel.slice(4);
        bus.publish({
          type: 'session.askUser',
          sessionId: webSessionId,
          channel: ev.channel,
          requestId: ev.requestId,
          questions: group.questions.map((q: any) => ({
            question: q.question,
            header: q.header,
            options: q.options || [],
            multiSelect: !!q.multiSelect,
          })),
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
      const text = `Questions (${group.questions.length})`;
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
      // Web UI: route through EventBus (no PlatformAdapter for web: conduits).
      if (ev.channel.startsWith('web:')) {
        const webSessionId = ev.channel.slice(4);
        planApprovals.register(ev.requestId, { channel: ev.channel, extensionUiId: ev.extensionUiId ?? null, threadId: ev.threadId ?? null });
        bus.publish({
          type: 'session.planApproval',
          sessionId: webSessionId,
          channel: ev.channel,
          requestId: ev.requestId,
          planContent: ev.planContent || '',
          planFilePath: ev.toolInput?.plan_file_path ?? null,
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
