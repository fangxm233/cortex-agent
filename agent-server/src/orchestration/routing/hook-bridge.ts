// input:  AskUserQuestion and ExitPlanMode requests
// output: Hook resolution, blocking TTL, and interaction events
// pos:    PreToolUse interaction communication bridge
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { EventBus } from '@events/index.js';
import type { ChatNoticeLevel } from '@core/types/agent-types.js';

export const TTL_MS = 30 * 60 * 1000; // 30 minutes — matches ASK_USER_QUESTION_TTL_MS

interface PendingRequest {
  resolve: (data: any) => void;
  channel: string;
  sessionId: string;
  createdAt: number;
}

const log = createLogger('hook-bridge');

const pendingRequests = new Map<string, PendingRequest>();

// --- EventBus reference (set once by app.ts via initHookBridge) ---

let _bus: EventBus | null = null;

/** Called once from app.ts during startup, before startWebhookServer(). */
function initHookBridge(bus: EventBus): void {
  _bus = bus;
}

// --- Deprecated notification callbacks (kept as no-op stubs for one week; removed after 2026-05-09) ---

type QuestionNotify = (requestId: string, channel: string, sessionId: string, questions: any[]) => void;
type PlanNotify = (requestId: string, channel: string, sessionId: string, planContent: string, toolInput: any) => void;

/** @deprecated no-op since S5; replaced by bus.subscribe('ask-user.requested') in app.ts */
function setQuestionNotify(_cb: QuestionNotify): void { /* no-op, deprecated */ }
/** @deprecated no-op since S5; replaced by bus.subscribe('plan.submitted') in app.ts */
function setPlanNotify(_cb: PlanNotify): void { /* no-op, deprecated */ }

// --- Registration (called by webhook routes, blocks until Slack interaction completes) ---

function registerAskQuestion(requestId: string, channel: string, sessionId: string, questions: any[], dryRun = false, threadId?: string | null, level?: ChatNoticeLevel | null): Promise<any> {
  return new Promise((resolve) => {
    if (!_bus) {
      log.error('bus not initialised; failing ask-user request immediately');
      resolve({ error: 'bus_not_initialized', answers: {} });
      return;
    }
    const levelField = level ? { level } : {};
    if (dryRun) {
      // Smoke-test path: publish event for journal capture, skip Slack interaction, resolve synthetically.
      _bus.publish({ type: 'ask-user.requested', requestId, channel, sessionId, threadId: threadId ?? null, questions, ...levelField, dryRun: true });
      resolve({ dryRun: true, answers: {} });
      return;
    }
    pendingRequests.set(requestId, { resolve, channel, sessionId, createdAt: Date.now() });
    _bus.publish({ type: 'ask-user.requested', requestId, channel, sessionId, threadId: threadId ?? null, questions, ...levelField });
  });
}

function registerPlanApproval(requestId: string, channel: string, sessionId: string, planContent: string, toolInput: any, dryRun = false, threadId?: string | null): Promise<any> {
  return new Promise((resolve) => {
    if (!_bus) {
      log.error('bus not initialised; failing plan-approval request immediately');
      resolve({ error: 'bus_not_initialized', approved: true, reason: '' });
      return;
    }
    if (dryRun) {
      // Smoke-test path: publish event for journal capture, skip Slack post, resolve synthetically.
      _bus.publish({ type: 'plan.submitted', requestId, channel, sessionId, threadId: threadId ?? null, planContent, toolInput, dryRun: true });
      resolve({ dryRun: true, approved: true, reason: '' });
      return;
    }
    pendingRequests.set(requestId, { resolve, channel, sessionId, createdAt: Date.now() });
    _bus.publish({ type: 'plan.submitted', requestId, channel, sessionId, threadId: threadId ?? null, planContent, toolInput });
  });
}

// --- Resolution (called by Slack handlers in app.ts) ---

function resolveRequest(requestId: string, data: any): boolean {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  pending.resolve(data);
  pendingRequests.delete(requestId);
  return true;
}

// --- Cleanup stale requests ---

type OnStale = (requestId: string, channel: string, sessionId: string) => void;
let _onStale: OnStale | null = null;

/** Register a callback fired when a pending request times out (wired by app.ts to mark the
 *  interaction entity expired + clean the group/plan maps). Pass null to clear (tests). */
function setOnStale(cb: OnStale | null): void {
  _onStale = cb;
}

function cleanupStale(now: number = Date.now()) {
  for (const [id, req] of pendingRequests) {
    if (now - req.createdAt > TTL_MS) {
      try { _onStale?.(id, req.channel, req.sessionId); } catch (e) {
        log.error(`onStale callback failed for ${id}: ${(e as Error).message}`);
      }
      req.resolve({ error: 'timeout', answers: {} });
      pendingRequests.delete(id);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(() => cleanupStale(), 5 * 60 * 1000).unref();

// --- Per-channel streaming context (for thread-aware hook messages) ---

const streamingCallbacks = new Map<string, (text: string) => void>();

/** Register the active onAssistantMessage callback for a channel (called by app.ts before runAgent). */
function setStreamingCallback(channel: string, cb: (text: string) => void) {
  streamingCallbacks.set(channel, cb);
}

/** Clear the streaming callback when the turn ends (called by app.ts after runAgent). */
function clearStreamingCallback(channel: string) {
  streamingCallbacks.delete(channel);
}

/** Get the active streaming callback for a channel, if any. */
function getStreamingCallback(channel: string): ((text: string) => void) | null {
  return streamingCallbacks.get(channel) || null;
}

/**
 * Publish plan.submitted directly (non-blocking, no pendingRequest).
 * Used by PI backend: the resolution goes through sendExtensionUiResponse, not resolveRequest.
 */
function publishPlanSubmitted(
  requestId: string,
  channel: string,
  sessionId: string,
  planContent: string,
  planFilePath: string | null,
  extensionUiId: string,
  threadId?: string | null,
): void {
  if (!_bus) { log.error('bus not initialised; dropping PI plan.submitted'); return; }
  const toolInput = planFilePath ? { plan_file_path: planFilePath } : {};
  _bus.publish({ type: 'plan.submitted', requestId, channel, sessionId, threadId: threadId ?? null, planContent, toolInput, extensionUiId });
}

/**
 * Publish ask-user.requested directly (non-blocking, no pendingRequest).
 * Used by PI backend: the resolution goes through sendExtensionUiResponse, not resolveRequest.
 * @param extensionUiId — original PI extension_ui_request id; required for sendExtensionUiResponse to unblock the PI subprocess.
 */
function publishAskUserRequested(requestId: string, channel: string, sessionId: string, questions: any[], extensionUiId?: string, threadId?: string | null): void {
  if (!_bus) { log.error('bus not initialised; dropping PI ask-user.requested'); return; }
  _bus.publish({ type: 'ask-user.requested', requestId, channel, sessionId, threadId: threadId ?? null, questions, extensionUiId });
}

export { initHookBridge, setQuestionNotify, setPlanNotify, registerAskQuestion, registerPlanApproval, resolveRequest, setOnStale, cleanupStale, setStreamingCallback, clearStreamingCallback, getStreamingCallback, publishPlanSubmitted, publishAskUserRequested };
