// input:  interaction state, plan response delivery, adapter
// output: registerInteractionHandlers(adapter)
// pos:    AskUserQuestion and ExitPlanMode handler registration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Destination, PlatformAdapter, ActionContext, ModalSubmitContext, ModalFieldValue, QuestionGroup } from '@platform/index.js';
import { buildPlanFeedbackModal } from '@platform/index.js';

import type { EventBus } from '@events/index.js';
import { trackPendingTask } from '../busy-tracker.js';
import { enqueue } from '../conduit-queue.js';
import * as askUserQuestion from './ask-user-question.js';
import { getStreamingCallback } from '../routing/hook-bridge.js';
import { resumeAskUserQuestionGroup } from '../lifecycle.js';
import { planApprovals } from './plan-approvals.js';
import { runningExecutions } from '../../core/running-executions.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { conduitQueues } from '../conduit-queue.js';
import { setSessionAsync, deleteSessionAsync } from '@domain/sessions/session.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { closeSession, getActiveBackend, getActiveProfile, setActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';
import { fireAndForgetPreCloseHook } from '@domain/sessions/session-hooks.js';
import { Icons } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import * as sessionBackup from '@domain/sessions/session-backup.js';
import { cancelThread as cancelThreadById } from '@domain/threads/index.js';
import { deliverPlanResponse } from './plan-response.js';
import { createLogger } from '@core/log.js';

let _adapter: PlatformAdapter | null = null;
let _bus: EventBus | null = null;

const log = createLogger('cancel-button');
const askLog = createLogger('ask-user-question-modal');

/** Called once from app.ts during startup, after EventBus is constructed. */
export function initInteractionHandlers(bus: EventBus): void {
  _bus = bus;
}

export function registerInteractionHandlers(adapter: PlatformAdapter): void {
  _adapter = adapter;
  registerAskUserQuestionHandlers(adapter);
  registerExitPlanModeHandlers(adapter);
  registerStatusActionHandlers(adapter);
}

function registerAskUserQuestionHandlers(adapter: PlatformAdapter): void {
  adapter.onAction('ask_user_question_open_modal', handleOpenModal);
  adapter.onModalSubmit('ask_user_question_modal_submit', handleModalSubmit);
}

async function handleOpenModal(ctx: ActionContext): Promise<void> {
  if (!_adapter) return;
  const group = askUserQuestion.getGroup(ctx.value);
  if (!group || askUserQuestion.isExpired(group)) {
    if (group && askUserQuestion.isExpired(group)) askUserQuestion.deleteGroup(group.groupId);
    const msg = group ? t('interaction.askExpired') : t('interaction.askInactive');
    if (ctx.channelId) {
      const expiredDest: Destination = { type: 'interactive-reply', conduit: ctx.channelId, sessionId: '' };
      await _adapter.postMessage(expiredDest, { text: msg }).catch(() => {});
    }
    return;
  }
  await _adapter.openModal(ctx.triggerId, askUserQuestion.buildQuestionModalDefinition(group));
}

async function handleModalSubmit(ctx: ModalSubmitContext): Promise<void> {
  if (!_adapter) { askLog.error('handleModalSubmit: _adapter is null'); return; }

  let groupId: string;
  try {
    const meta = JSON.parse(ctx.privateMetadata || '{}');
    groupId = meta.groupId;
  } catch {
    askLog.error('handleModalSubmit: failed to parse privateMetadata', { privateMetadata: ctx.privateMetadata });
    await ctx.ack();
    return;
  }

  if (!groupId) {
    askLog.error('handleModalSubmit: privateMetadata missing groupId', { privateMetadata: ctx.privateMetadata });
    await ctx.ack();
    return;
  }

  const group = askUserQuestion.getGroup(groupId);
  if (!group) {
    askLog.warn('handleModalSubmit: group not found (may have expired)', { groupId });
    await ctx.ack();
    return;
  }

  const answers = collectModalAnswers(group, ctx.values);
  if (answers.errors) {
    askLog.info('handleModalSubmit: validation errors', { groupId, errors: answers.errors });
    await ctx.ack({ errors: answers.errors });
    return;
  }
  await ctx.ack();

  askLog.info('handleModalSubmit: answers collected', { groupId, totalQuestions: group.questions.length });

  for (const [pendingId, answer] of answers.collected!) group.answers.set(pendingId, answer);
  await updateQuestionMessage(group);

  if (group.answers.size === group.questions.length) {
    askLog.info('handleModalSubmit: all questions answered, resolving', { groupId });
    const g = group as unknown as { channel: string; sessionId: string; hookRequestId?: string };
    _bus?.publish({ type: 'ask-user.answered', channel: g.channel, requestId: g.hookRequestId, sessionId: g.sessionId, answer: askUserQuestion.formatGroupResponse(group) });
    const resolved = askUserQuestion.tryResolveHook(group);
    if (resolved) return;
    dispatchAskUserQuestionResume(group);
  }
}

function collectModalAnswers(group: QuestionGroup, values: Record<string, Record<string, ModalFieldValue>>): { errors?: Record<string, string>; collected?: Map<string, { header: string; value: string | string[] }> } {
  const errors: Record<string, string> = {};
  const collected = new Map<string, { header: string; value: string | string[] }>();
  for (const [qIdx, q] of group.questions.entries()) {
    const selection = values[`q_${qIdx}`]?.selection;
    const otherText = values[`q_${qIdx}_other`]?.other_text?.value?.trim();
    let answer: string | string[] | undefined;
    if (otherText) {
      answer = otherText;
    } else if (q.multiSelect) {
      const selected = (selection?.selectedOptions || []).map((o) => q.options[parseInt(o.value)]?.label).filter(Boolean);
      if (selected.length > 0) answer = selected;
    } else {
      const idx = selection?.selectedOption?.value;
      if (idx != null) answer = q.options[parseInt(idx)]?.label;
    }
    if (!answer || (Array.isArray(answer) && answer.length === 0)) {
      errors[`q_${qIdx}`] = t('interaction.selectOrType');
    } else {
      collected.set(q.pendingId, { header: q.header, value: answer });
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { collected };
}

async function updateQuestionMessage(group: QuestionGroup & { responseMessageTs?: string; channel: string }): Promise<void> {
  if (!group.responseMessageTs || !_adapter) return;
  await _adapter.updateMessage(
    { conduit: group.channel, messageId: group.responseMessageTs },
    {
      text: t('interaction.questionsProgress', { answered: group.answers.size, total: group.questions.length }),
      richBlocks: askUserQuestion.buildQuestionGroupBlocks(group),
    },
  ).catch(() => {});
}

function dispatchAskUserQuestionResume(group: QuestionGroup & { channel: string; sessionId: string; threadId?: string | null }): void {
  if (!_adapter) return;
  const adapter = _adapter;
  const responseText = askUserQuestion.formatGroupResponse(group);
  trackPendingTask(+1);
  enqueue(group.channel, async () => {
    try {
      await resumeAskUserQuestionGroup({ adapter, group, responseText });
    } finally {
      trackPendingTask(-1);
    }
  });
}

function registerExitPlanModeHandlers(adapter: PlatformAdapter): void {
  adapter.onAction('hook_plan_approve', async (ctx: ActionContext) => {
    const requestId = ctx.value;
    const pending = planApprovals.lookup(requestId);
    if (!pending || !deliverPlanResponse(requestId, pending, true)) return;
    planApprovals.resolve(requestId);
    if (ctx.messageRef) {
      await adapter.updateMessage(
        ctx.messageRef,
        {
          text: `${Icons.ok} ${t('interaction.planApproved')}`,
          richBlocks: [{ type: 'section', text: `${Icons.ok} ${t('interaction.planApprovedRich')}` }],
        },
      ).catch(() => {});
    }
  });

  adapter.onAction('hook_plan_feedback', async (ctx: ActionContext) => {
    const requestId = ctx.value;
    if (!requestId || !planApprovals.has(requestId)) return;
    await adapter.openModal(ctx.triggerId, buildPlanFeedbackModal(requestId));
  });

  adapter.onModalSubmit('hook_plan_feedback_submit', async (ctx: ModalSubmitContext) => {
    await ctx.ack();
    const { requestId } = JSON.parse(ctx.privateMetadata);
    const pending = planApprovals.lookup(requestId);
    if (!pending) return;
    const feedback = ctx.values?.feedback?.text?.value || t('interaction.noSpecificFeedback');
    if (!deliverPlanResponse(requestId, pending, false, feedback)) return;
    planApprovals.reject(requestId);
    const feedbackText = `${Icons.edit} ${t('interaction.planFeedbackSent', { feedback })}`;
    const streamingCb = getStreamingCallback(pending.channel);
    const feedbackDest: Destination = { type: 'interactive-reply', conduit: pending.channel, sessionId: '' };
    if (streamingCb) {
      streamingCb(feedbackText);
    } else {
      await adapter.postMessage(feedbackDest, { text: feedbackText }).catch(() => {});
    }
  });
}

// --- Status action button handlers ---

function registerStatusActionHandlers(adapter: PlatformAdapter): void {
  adapter.onAction('status_cancel', handleStatusCancel);
  adapter.onAction('status_resume', handleStatusResume);
  adapter.onAction('status_new', handleStatusNew);
  adapter.onAction('status_newq', handleStatusNewq);
}

async function handleStatusCancel(ctx: ActionContext): Promise<void> {
  if (!_adapter) return;
  let channel: string;
  let threadId: string | null;
  let executionId: string | null;
  try {
    const parsed = JSON.parse(ctx.value);
    channel = parsed.channel;
    threadId = parsed.threadId ?? null;
    executionId = parsed.executionId ?? null;
  } catch {
    return;
  }

  // Conversation path: plain user messages are no longer wrapped in a thread, so the
  // Cancel button carries an executionId. Resolve and kill via the execution index;
  // there is no thread to cancel.
  if (!threadId && executionId) {
    const exec = runningExecutions.getById(executionId);
    if (!exec) {
      log.warn('Cancel button clicked but no running execution for executionId', { channel, executionId });
      return;
    }
    if (exec.sessionId) await setSessionAsync(exec.channel ?? channel, exec.sessionId, getActiveBackend()).catch(() => {});
    // teardownExecution(cancelled): record→cancelled, kill the handle, publish a balanced event.
    executionRegistry.teardownExecution({ executionId, status: 'cancelled', durationS: 0 });
    conduitQueues.delete(exec.channel ?? channel);
    if (ctx.messageRef) {
      await _adapter.updateMessage(ctx.messageRef, {
        text: `${Icons.stopped} ${t('interaction.cancelledPreserved')}`,
      }).catch(() => {});
    }
    return;
  }

  if (!threadId) {
    log.warn('Cancel button clicked but threadId/executionId missing in value', { channel });
    return;
  }
  const exec = runningExecutions.getByThreadId(threadId);
  if (!exec) {
    log.warn('Cancel button clicked but no running execution for threadId', { channel, threadId });
    return;
  }
  await cancelThreadById(threadId).catch(() => {});
  if (exec.sessionId) await setSessionAsync(exec.channel ?? channel, exec.sessionId, getActiveBackend()).catch(() => {});
  if (exec.executionId) {
    executionRegistry.teardownExecution({ executionId: exec.executionId, status: 'cancelled', durationS: 0 });
  } else {
    runningExecutions.killByThreadId(threadId);
  }
  conduitQueues.delete(exec.channel ?? channel);
  if (ctx.messageRef) {
    await _adapter.updateMessage(ctx.messageRef, {
      text: `${Icons.stopped} Cancelled. Session preserved — next message will resume.`,
    }).catch(() => {});
  }
}

async function handleStatusResume(ctx: ActionContext): Promise<void> {
  if (!_adapter) return;
  const sessionName = ctx.value;
  const record = await sessionStore.lookupSession(sessionName);
  if (!record) return;
  if (record.profileName) setActiveProfile(record.profileName, ctx.channelId);
  await setSessionAsync(ctx.channelId, record.sessionId, record.backend);
  await conversationLedger.switchSession(ctx.channelId, {
    sessionId: record.sessionId, sessionName, backend: record.backend, profileName: record.profileName,
  });
  const profileNote = record.profileName ? t('interaction.sessionProfileNote', { profileName: record.profileName }) : '';
  const resumeDest: Destination = { type: 'interactive-reply', conduit: ctx.channelId, sessionId: record.sessionId ?? '' };
  await _adapter.postMessage(resumeDest, {
    text: `${Icons.refresh} ${t('interaction.sessionActive', { sessionName, profileNote })}`,
  }).catch(() => {});
}

// "New" button (=!new): close the session and run the pre-close hook.
async function handleStatusNew(ctx: ActionContext): Promise<void> {
  await resetChannelFromStatusButton(ctx, { skipHook: false });
}

// "New (quiet)" button (=!newq): close the session WITHOUT running the pre-close hook.
async function handleStatusNewq(ctx: ActionContext): Promise<void> {
  await resetChannelFromStatusButton(ctx, { skipHook: true });
}

async function resetChannelFromStatusButton(ctx: ActionContext, opts: { skipHook: boolean }): Promise<void> {
  if (!_adapter) return;
  const channel = ctx.value;
  // Status message IS the thread parent (no thread_ts on it) — use its messageId
  // as the thread context so hook messages land in the session's thread.
  const threadAnchorId = ctx.messageRef?.threadId || ctx.messageRef?.messageId;

  // Fire-and-forget: hook starts, session closes immediately without waiting.
  // The quiet variant (!newq) skips the hook entirely.
  if (!opts.skipHook) void fireAndForgetPreCloseHook(channel, _adapter, threadAnchorId);

  closeSession(channel);
  const conv = await conversationLedger.getConversation(channel);
  const profileName = getActiveProfile(channel) || 'default';
  if (conv) {
    sessionBackup.cleanupAllBackups(conv.sessionId);
    await conversationLedger.clearConversation(channel);
  }
  await deleteSessionAsync(channel, resolveBackendForChannel(channel));
  planApprovals.clearByChannel(channel);
  const newDest: Destination = { type: 'interactive-reply', conduit: ctx.channelId, sessionId: '' };
  await _adapter.postMessage(newDest, {
    text: t('interaction.newConversation', { profileName }),
  }).catch(() => {});
}
