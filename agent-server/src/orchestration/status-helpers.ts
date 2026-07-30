// input:  executions, threads, platform, runtime settings
// output: status, session, and execution helpers
// pos:    Builds and serializes status messages and actions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import type { Destination, PlatformAdapter, MessageRef, IncomingAttachment, RichBlock, ActionElement, OutputStream } from '@platform/index.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { ExecutionRecord } from '@domain/executions/registry.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { runAgent } from '@domain/agents/index.js';
import { shouldAutoRunCompound, combineFinalOutputs } from '@domain/threads/auto-thread.js';
import { buildThreadSummary } from '@domain/threads/runner.js';
import type { ThreadRunResult } from '@domain/threads/runner.js';
import { projectStore } from '@domain/projects/index.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { durableUpdate } from './durable-helpers.js';
// Pure formatters live in core/ so the domain layer can consume them without an orch dep.
export { computeElapsed, formatMetricsSuffix, buildSessionTag, buildUserProcessingMessage } from '@core/status-format.js';

const log = createLogger('status-helpers');

/** Feature gate: the "New (quiet)" status button (=!newq, skips the pre-close hook). */
export function isStatusNewqButtonEnabled(): boolean {
  return getSettings().statusNewqButton;
}

export function resolveExecutionProject({ execution, fallbackMessage }: { execution: ExecutionRecord | null; fallbackMessage: string }): string {
  return execution?.project || (projectStore.resolveFromMessage(fallbackMessage || '')?.id ?? 'general');
}

export function buildExecutionStatusReport(): string {
  const running = executionRegistry.getRunningExecutions();
  if (running.length === 0) return t('status.noRunningExecutions');

  const lines = [t('status.runningExecutions', { count: running.length })];
  for (const record of running) {
    const location = record.kind === 'dispatch'
      ? `${record.dispatch?.machine || '?'}:${record.dispatch?.taskId || record.id}`
      : record.channel || record.id;
    lines.push(`\u2022 ${record.kind} ${location} ${record.project} ${record.status}`);
  }
  return lines.join('\n');
}

export function finalizeLocalExecution({ executionId, status, result, error, durationS }: { executionId: string | null; status: string; result?: AgentResult | null; error?: { message: string; cancelled?: boolean } | null; durationS: number }): ExecutionRecord | null {
  if (!executionId) return null;
  if (status === 'completed') {
    return executionRegistry.completeExecution(executionId, {
      costUsd: result?.total_cost_usd,
      numTurns: result?.num_turns,
      durationS,
      finalOutput: result?.finalOutput || null,
    });
  }
  if (status === 'cancelled') {
    return executionRegistry.cancelExecution(executionId, { durationS });
  }
  return executionRegistry.failExecution(executionId, {
    durationS,
    error: error?.message || null,
  });
}

export function makeFallbackNotifier(channel: string, statusMsg: MessageRef | null, adapter: PlatformAdapter) {
  return async (fromConfig: { model: string; mode?: string }, toConfig: { model: string; mode?: string }) => {
    const fromLabel = `${fromConfig.model}/${fromConfig.mode || 'default'}`;
    const toLabel = `${toConfig.model}/${toConfig.mode || 'default'}`;
    log.info(`Fallback: ${fromLabel} \u2192 ${toLabel}`);
    if (statusMsg) {
      try {
        await adapter.updateMessage(statusMsg, {
          text: `${Icons.warning} ${fromLabel} rate limited, falling back to *${toLabel}*...`,
        });
      } catch {}
    }
  };
}

export async function runAutoCompoundForScheduledTask({ baseResult, channel, profileName, project, trigger, onAssistantMessage = null }: { baseResult: AgentResult; channel: string; profileName: string | null; project?: string; trigger?: string; onAssistantMessage?: ((text: string) => void) | null }): Promise<AgentResult> {
  if (!shouldAutoRunCompound(baseResult?.finalOutput)) return baseResult;
  const compoundHandle = runAgent('/compound-simple', {
    channel,
    sessionId: baseResult?.sessionId || null,
    files: [],
    scheduleTaskId: null,
    profileName,
    project,
    trigger: trigger ? `${trigger}:compound` : 'auto-compound',
    onAssistantMessage,
  });
  const compoundResult = await compoundHandle.promise;
  return {
    ...baseResult,
    sessionId: compoundResult?.sessionId || baseResult?.sessionId || null,
    total_cost_usd: (baseResult?.total_cost_usd || 0) + (compoundResult?.total_cost_usd || 0),
    num_turns: (baseResult?.num_turns || 0) + (compoundResult?.num_turns || 0),
    finalOutput: combineFinalOutputs(baseResult?.finalOutput, compoundResult?.finalOutput),
  };
}

/** Build a streaming callback that aggregates assistant messages via OutputStream. */
export function makeStreamingMessageCallback(adapter: PlatformAdapter, destination: Destination, threadAnchorId: string | null = null, onMessagePosted: ((ref: MessageRef) => void) | null = null, durable?: import('@platform/types.js').DurableHooks | null): ((text: string) => void) & { stream: OutputStream } {
  const stream = adapter.openOutputStream(destination, { threadId: threadAnchorId, onMessagePosted, durable: durable ?? null });
  const callback = (text: string) => stream.emitText(text);
  (callback as ((text: string) => void) & { stream: OutputStream }).stream = stream;
  return callback as ((text: string) => void) & { stream: OutputStream };
}

/** Extract text content from forwarded messages (attachments marked isForwarded by the platform adapter). */
export function extractForwardedContent(message: { attachments?: IncomingAttachment[] }): string | null {
  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) return null;
  const parts = [];
  for (const att of attachments) {
    if (att.isForwarded) {
      const author = att.authorName || 'Unknown';
      const text = att.text || '';
      if (text) parts.push(`[${author}]: ${text}`);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// --- Status action buttons ---

export interface StatusBlocksTemplate {
  channel: string;
  sessionName: string | null;
  isDm: boolean;
  threadId?: string | null;
  /** Execution-scoped Cancel target for the conversation path (plain user messages that
   *  are no longer wrapped in a thread). When set, the Cancel handler resolves the running
   *  execution via executionId instead of threadId. */
  executionId?: string | null;
}

function buildActionElements({ channel, sessionName, isDm, includeCancel, threadId, executionId }: StatusBlocksTemplate & { includeCancel: boolean }): ActionElement[] {
  const elements: ActionElement[] = [];
  if (includeCancel) {
    elements.push({
      type: 'button',
      text: t('btn.cancel'),
      actionId: 'status_cancel',
      value: JSON.stringify({ channel, threadId: threadId ?? null, executionId: executionId ?? null }),
      style: 'danger',
    });
  }
  if (sessionName) {
    elements.push({
      type: 'button',
      text: t('btn.resume'),
      actionId: 'status_resume',
      value: sessionName,
    });
  }
  if (isDm) {
    elements.push({
      type: 'button',
      text: t('btn.new'),
      actionId: 'status_new',
      value: channel,
    });
  }
  if (isDm && isStatusNewqButtonEnabled()) {
    elements.push({
      type: 'button',
      text: t('btn.newq'),
      actionId: 'status_newq',
      value: channel,
    });
  }
  return elements;
}

/** Build richBlocks for the initial "Processing" message (Cancel button included). */
export function buildStatusActionBlocks(text: string, template: StatusBlocksTemplate): RichBlock[] {
  return buildStatusBlocksImpl(text, template, { includeCancel: true });
}

/** Build richBlocks for the sealed message (Cancel button removed). */
export function buildSealedStatusActionBlocks(text: string, template: StatusBlocksTemplate): RichBlock[] {
  return buildStatusBlocksImpl(text, template, { includeCancel: false });
}

function buildStatusBlocksImpl(text: string, template: StatusBlocksTemplate, opts: { includeCancel: boolean }): RichBlock[] {
  const blocks: RichBlock[] = [
    { type: 'section', text, format: 'markdown' },
  ];
  const actionElements = buildActionElements({ ...template, includeCancel: opts.includeCancel });
  if (actionElements.length > 0) {
    blocks.push({ type: 'actions', elements: actionElements });
  }
  return blocks;
}

// --- Unified thread-completion seal (interactive `!thread` + background/resume) ---
//
// Both the interactive `!thread` path (thread-executor handleThreadStart/Add/Continue) and the
// background/resume path (thread-callback.sealSuspendedStatusMsg) end a thread by writing
// buildThreadSummary(threadResult) onto the live status message. They differ only in whether
// sealed interactive action blocks (Cancel removed; Resume/New retained) are attached. Funnel both
// through this one function so "seal a finished thread's status message" has a single, hard-to-forget
// implementation — the omission of exactly this call is what froze rate-limit-resumed status messages.
//
// The task-dispatch seal (finalizeThreadSuccess) stays separate BY DESIGN: it lives in the domain
// layer (which must not import these orch-layer block builders) and presents task-framed text
// ("Done: [project] …") with durable delivery, not a thread summary. See _shared.finalizeThreadSuccess.
export async function sealThreadStatus(
  adapter: PlatformAdapter,
  statusMsg: MessageRef,
  threadResult: ThreadRunResult,
  opts: { blocksTemplate?: StatusBlocksTemplate } = {},
): Promise<void> {
  const text = buildThreadSummary(threadResult);
  const richBlocks = opts.blocksTemplate ? buildSealedStatusActionBlocks(text, opts.blocksTemplate) : undefined;
  await adapter.updateMessage(statusMsg, { text, ...(richBlocks && { richBlocks }) });
}

// --- Status message serializer (anti-race for onProgress vs. final update) ---
//
// Background: onProgress callbacks during agent execution write "Processing..."
// to statusMsg via fire-and-forget adapter.updateMessage(). When the agent
// completes and we write the final "Done" text, an in-flight "Processing"
// Slack API call can land *after* the final write and overwrite it.
//
// writeStatus serializes updates per statusMsg and drops any update issued
// after sealStatus has been called. sealStatus awaits in-flight progress
// writes, then writes the final text, then prevents further writes.
type StatusState = { chain: Promise<unknown>; sealed: boolean; blocksTemplate?: StatusBlocksTemplate };
const statusStates = new Map<string, StatusState>();

function statusKey(ref: MessageRef): string {
  return `${ref.conduit}:${ref.messageId}`;
}

function getOrCreateStatusState(ref: MessageRef): StatusState {
  const key = statusKey(ref);
  let s = statusStates.get(key);
  if (!s) {
    s = { chain: Promise.resolve(), sealed: false };
    statusStates.set(key, s);
  }
  return s;
}

/** Store the blocks template for a status message so writeStatus can regenerate richBlocks
 *  with updated text while preserving buttons. */
export function initStatusBlocks(ref: MessageRef, template: StatusBlocksTemplate): void {
  const s = getOrCreateStatusState(ref);
  s.blocksTemplate = template;
}

/**
 * Serialized status update. Drops silently if statusMsg has been sealed.
 * Regenerates richBlocks from the stored template so buttons persist alongside updated text.
 * Returns a promise that resolves when this write has landed (or was dropped);
 * call sites generally ignore it, but tests can await.
 */
export function writeStatus(adapter: PlatformAdapter, ref: MessageRef, text: string): Promise<void> {
  const s = getOrCreateStatusState(ref);
  if (s.sealed) return Promise.resolve();
  const next = s.chain
    .catch(() => {})
    .then(() => {
      if (s.sealed) return;
      const richBlocks = s.blocksTemplate
        ? buildStatusActionBlocks(text, s.blocksTemplate)
        : undefined;
      return adapter.updateMessage(ref, { text, ...(richBlocks && { richBlocks }) }).catch((e: Error) => {
        log.error('Failed to update status:', e.message);
      });
    });
  s.chain = next;
  return next as Promise<void>;
}

/** Awaits in-flight writeStatus calls, writes final text, then blocks further writes to this statusMsg.
 *  Uses durable delivery when OutboundQueue is available to survive restarts. */
export async function sealStatus(adapter: PlatformAdapter, ref: MessageRef, text: string, richBlocks?: RichBlock[]): Promise<void> {
  const s = getOrCreateStatusState(ref);
  s.sealed = true;
  try { await s.chain; } catch {}
  const content = { text, ...(richBlocks && richBlocks.length > 0 && { richBlocks }) };
  const queue = getOutboundQueue();
  if (queue) {
    await durableUpdate(queue, adapter, ref, content);
  } else {
    await adapter.updateMessage(ref, content);
  }
  const t = setTimeout(() => statusStates.delete(statusKey(ref)), 60_000);
  if (typeof t.unref === 'function') t.unref();
}
