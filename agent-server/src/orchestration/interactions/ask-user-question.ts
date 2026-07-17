// input:  AskUserQuestion tool_use payloads, hook requests
// output: state management + interactive component builders
// pos:    AskUserQuestion state management and interaction construction
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Destination, PlatformAdapter, OutputStream } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { buildQuestionGroupBlocks, buildQuestionModalDefinition } from '@platform/index.js';
import { runningExecutions } from '../../core/running-executions.js';

const log = createLogger('ask-user');

const ASK_USER_QUESTION_TTL_MS = 1800000; // 30 minutes

// pendingId → lightweight record for action routing
const pendingAskUserQuestions = new Map();
// groupId → group record with all questions + collected answers
const pendingAskUserQuestionGroups = new Map();

// --- ID builders ---

function buildPendingId(sessionId, toolUseId, questionIndex) {
  return [sessionId, toolUseId || 'ask', questionIndex].join(':');
}

function buildGroupId(sessionId, toolUseId) {
  return `${sessionId}:${toolUseId || 'ask'}`;
}

// --- Formatting ---

function formatGroupResponse(group) {
  const parts = [];
  for (const q of group.questions) {
    const answer = group.answers.get(q.pendingId);
    if (answer) {
      const formatted = Array.isArray(answer.value) ? `[${answer.value.join(', ')}]` : answer.value;
      parts.push(`${q.header} = ${formatted}`);
    }
  }
  if (parts.length === 1) return `AskUserQuestion response: ${parts[0]}`;
  return `AskUserQuestion response:\n${parts.join('\n')}`;
}

// --- State management ---

function isExpired(record) {
  return !record || (Date.now() - record.createdAt) > ASK_USER_QUESTION_TTL_MS;
}

function getGroup(groupId) {
  return pendingAskUserQuestionGroups.get(groupId) || null;
}

function deleteGroup(groupId) {
  const group = pendingAskUserQuestionGroups.get(groupId);
  if (group) {
    for (const q of group.questions) pendingAskUserQuestions.delete(q.pendingId);
    pendingAskUserQuestionGroups.delete(groupId);
  }
}

function getPendingQuestion(pendingId) {
  return pendingId ? pendingAskUserQuestions.get(pendingId) : null;
}

// --- Hook mode support ---

// Resolvers for PreToolUse hook requests (requestId → callback with answers)
const pendingHookResolvers = new Map();

/** Create a question group from a PreToolUse hook request (not from Claude output).
 *  @param extensionUiId — original PI extension_ui_request id; when set, tryResolveHook
 *         uses this for sendExtensionUiResponse instead of the hookRequestId. */
function createHookGroup(requestId, channel, sessionId, questions, extensionUiId?: string, threadId?: string | null) {
  const groupId = buildGroupId(sessionId, requestId);
  const group = {
    groupId,
    sessionId,
    toolUseId: requestId,
    channel,
    messageTs: null,
    responseMessageTs: null,
    hookRequestId: requestId,
    extensionUiId: extensionUiId || null,
    threadId: threadId ?? null,
    questions: questions.map((q, idx) => ({
      pendingId: buildPendingId(sessionId, requestId, idx),
      header: q.header,
      question: q.question,
      options: q.options || [],
      multiSelect: !!q.multiSelect,
    })),
    answers: new Map(),
    createdAt: Date.now(),
  };
  for (const q of group.questions) {
    pendingAskUserQuestions.set(q.pendingId, { ...q, groupId, channel });
  }
  pendingAskUserQuestionGroups.set(groupId, group);
  return group;
}

/** Register a callback to be called when all hook-mode answers are collected. */
function registerHookResolver(requestId, resolver) {
  pendingHookResolvers.set(requestId, resolver);
}

/** If the group is in hook mode and all answers collected, resolve the hook and return true.
 *  For PI backend: if a running execution with an agentProcess exists, send extension_ui_response directly. */
function tryResolveHook(group) {
  if (!group.hookRequestId) { log.info('tryResolveHook: no hookRequestId'); return false; }
  if (group.answers.size !== group.questions.length) { log.info(`tryResolveHook: incomplete ${group.answers.size}/${group.questions.length}`); return false; }

  // Build answers
  const answers = {};
  for (const q of group.questions) {
    const answer = group.answers.get(q.pendingId);
    if (answer) {
      answers[q.question] = Array.isArray(answer.value) ? answer.value.join(', ') : answer.value;
    }
  }
  // PI branch: resolve by sending extension_ui_response to the running PI process.
  // Use extensionUiId (the original PI extension_ui_request id) when available;
  // fall back to group.toolUseId for legacy / non-PI paths.
  // NOTE: Check for sendExtensionUiResponse capability directly instead of exec.backend,
  // because the profile's backend (which determines the adapter) may differ from
  // getActiveBackend() (which is stored in exec.backend).
  const exec = runningExecutions.getByChannel(group.channel).find(e => e.agentProcess) ?? null;
  if (exec && exec.agentProcess) {
    const proc = exec.agentProcess as any;
    if (typeof proc.sendExtensionUiResponse === 'function') {
      const piId = group.extensionUiId || group.toolUseId;
      if (piId) {
        const value = Object.values(answers).join('\n');
        log.info(`sendExtensionUiResponse id=${piId}`);
        proc.sendExtensionUiResponse(piId, { value });
        deleteGroup(group.groupId);
        return true;
      }
    }
  }

  // Claude branch: resolve via hook callback
  const resolver = pendingHookResolvers.get(group.hookRequestId);
  if (!resolver) return false;
  resolver({ answers });
  pendingHookResolvers.delete(group.hookRequestId);
  deleteGroup(group.groupId);
  return true;
}

// --- Send questions via adapter ---

async function sendMessages(result, channel, adapter: PlatformAdapter, messageTs, threadAnchorId = null, stream: OutputStream | null = null) {
  let sentCount = 0;
  for (const payload of result.askUserQuestions || []) {
    if (!payload.questions?.length) continue;
    const groupId = buildGroupId(payload.sessionId, payload.toolUseId);
    const group = {
      groupId,
      sessionId: payload.sessionId,
      toolUseId: payload.toolUseId,
      channel,
      messageTs,
      responseMessageTs: null as string | null,
      threadId: null,
      questions: payload.questions.map((q, idx) => ({
        pendingId: buildPendingId(payload.sessionId, payload.toolUseId, idx),
        header: q.header,
        question: q.question,
        options: q.options || [],
        multiSelect: !!q.multiSelect,
      })),
      answers: new Map(),
      createdAt: Date.now(),
    };
    const text = `Questions (${group.questions.length})`;
    const richBlocks = buildQuestionGroupBlocks(group);
    if (stream) {
      const ref = await stream.postInteractive(text, { richBlocks });
      group.responseMessageTs = ref?.messageId || null;
    } else {
      const askMsgDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
      const ref = await adapter.postMessage(askMsgDest, { text, richBlocks }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
      group.responseMessageTs = ref.messageId;
    }
    for (const q of group.questions) {
      pendingAskUserQuestions.set(q.pendingId, { ...q, groupId, channel });
    }
    pendingAskUserQuestionGroups.set(groupId, group);
    sentCount++;
  }
  return sentCount;
}

/** Return the first non-expired pending question group for a channel, or null. */
function getGroupByChannel(channel: string): any | null {
  for (const group of pendingAskUserQuestionGroups.values()) {
    if (group.channel === channel && !isExpired(group)) return group;
  }
  return null;
}

export {
  sendMessages,
  formatGroupResponse,
  buildQuestionGroupBlocks,
  buildQuestionModalDefinition,
  isExpired,
  getGroup,
  getGroupByChannel,
  deleteGroup,
  getPendingQuestion,
  createHookGroup,
  registerHookResolver,
  tryResolveHook,
};
