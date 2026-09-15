// input:  a thread run's status message, its blocks template and its verdict
// output: every SUMMARY-style rendering of a thread — the opening status line, the multi-agent
//         progress line, the terminal seal, the non-terminal (suspended / paused) refresh and the
//         status-message-less fallback post
// pos:    orchestration/thread-run — the `!thread`, MCP `thread_start` and resume surfaces. This
//         file is the single owner of the four seal implementations the survey (§A) found spread
//         over status-helpers, the webhook's inline `onSettled` and thread-callback's
//         suspended-status refresh. The dispatch / scheduled (task-framed,
//         durable) rendering is a sibling file, not a branch in here.

import type { Destination, MessageRef, PlatformAdapter } from '@platform/index.js';
import type { ThreadRecord } from '@core/types/thread-types.js';
import type { ThreadRunResult } from '@domain/threads/runner.js';
import { buildThreadSummary } from '@domain/threads/runner.js';
import { buildThreadStatusMessage } from '@core/status-format.js';
import { Icons } from '@core/icons.js';
import { threadStore } from '@store/thread-repo.js';
import {
  buildSealedStatusActionBlocks, buildStatusActionBlocks, computeElapsed, initStatusBlocks,
  sealStatus, writeStatus, type StatusBlocksTemplate,
} from '../status-helpers.js';
import type { ThreadVerdict } from './verdict.js';

/** Where a summary-style run draws itself. Assembled once by `ThreadRun`. */
export interface SummaryRenderTarget {
  adapter: PlatformAdapter;
  /** The live status message, or null (no channel / the post failed) — then only the
   *  destination fallback below can render anything. */
  statusMsg: MessageRef | null;
  /** Action-button template, or null for a background surface with no live user to click. */
  blocks: StatusBlocksTemplate | null;
  /** Fallback target when there is no status message. */
  destination: Destination;
  threadAnchorId: string | null;
  startTime: number;
}

/** The terminal state to render, as `ThreadRun` computed it. */
export interface SummaryOutcome {
  threadId: string;
  verdict: ThreadVerdict;
  /** Freshly re-read record — `waiting` counts its children off it. */
  thread: ThreadRecord | null;
  result: ThreadRunResult | null;
  error: Error | null;
}

/** Synthesize the `ThreadRunResult` shape `buildThreadSummary` needs from a bare record. Verbatim
 *  from the deleted suspended-status refresh in thread-callback: the resume / persisted-ref
 *  paths render a thread they did not themselves run. */
export function summaryResultFromThread(thread: ThreadRecord): ThreadRunResult {
  const totalNumTurns = thread.steps.reduce((acc, step) => acc + (step.numTurns || 0), 0);
  return {
    thread, totalCostUsd: thread.totalCostUsd, totalNumTurns,
    finalOutput: null, lastAgentResult: null, executionId: null, stopReason: null,
  };
}

/** Post the opening status line and, once the thread id is known, re-render it WITH the Cancel
 *  button (the P → U+B two-step the `!thread` and webhook paths have always performed: the button
 *  needs a threadId, which only exists after the record is created). A post failure is not fatal —
 *  the run continues with no status message, exactly as the webhook path does today. */
export async function openSummaryStatus(
  adapter: PlatformAdapter,
  destination: Destination,
  threadAnchorId: string | null,
  startText: string,
  blocks: StatusBlocksTemplate | null,
): Promise<MessageRef | null> {
  const statusMsg = await adapter.postMessage(
    destination, { text: startText },
    threadAnchorId ? { threadId: threadAnchorId } : undefined,
  );
  if (blocks) {
    await adapter.updateMessage(statusMsg, {
      text: startText,
      richBlocks: buildStatusActionBlocks(startText, blocks),
    }).catch(() => {});
    initStatusBlocks(statusMsg, blocks);
  }
  return statusMsg;
}

/** The multi-agent status line, or null when this surface draws nothing for this step. Guard and
 *  text are verbatim from the two `adapter.updateMessage(buildThreadStatusMessage(...))` calls the
 *  thread runner used to make itself. */
export function renderSummaryProgress(info: {
  threadId: string;
  stepNumber: number;
  label: string;
  multiAgent: boolean;
  numTurns: number | null;
  startTime: number;
}): string | null {
  if (!info.multiAgent) return null;
  const record = threadStore.get(info.threadId);
  return buildThreadStatusMessage({
    threadId: record?.id ?? info.threadId,
    stepNumber: info.stepNumber,
    label: info.label,
    elapsedS: (Date.now() - info.startTime) / 1000,
    numTurns: info.numTurns,
    taskProject: record?.metadata?.taskProject ?? null,
    taskId: record?.metadata?.taskId ?? null,
    taskText: record?.metadata?.taskText ?? null,
  });
}

/** Seal a status message with a thread summary (the former seal helper in status-helpers).
 *  Attaches SEALED action blocks (Cancel removed) when a template is supplied. Delivery failures
 *  propagate — the caller decides its own posture. */
export async function sealThreadSummary(
  adapter: PlatformAdapter,
  statusMsg: MessageRef,
  result: ThreadRunResult,
  blocks: StatusBlocksTemplate | null = null,
): Promise<void> {
  await sealSummaryText(adapter, statusMsg, buildThreadSummary(result), blocks);
}

/** Seal a status message with arbitrary terminal text (failure / cancellation). */
export async function sealSummaryText(
  adapter: PlatformAdapter,
  statusMsg: MessageRef,
  text: string,
  blocks: StatusBlocksTemplate | null = null,
): Promise<void> {
  await sealStatus(adapter, statusMsg, text, blocks ? buildSealedStatusActionBlocks(text, blocks) : undefined);
}

/**
 * Render one finished (or suspended) summary-style thread run.
 *
 * Terminal verdicts SEAL (writes to the ref are refused afterwards); `waiting` and `rate_limited`
 * only WRITE, because the thread will be resumed and the resumed run keeps updating this very
 * message — sealing it here is what used to freeze resumed status lines (plan §1.2 step 7).
 *
 * Throws on a delivery failure; `ThreadRun` logs it and keeps its outcome / settle intact.
 */
export async function renderSummaryOutcome(target: SummaryRenderTarget, outcome: SummaryOutcome): Promise<void> {
  const { adapter, statusMsg, blocks } = target;
  const { verdict, thread, error } = outcome;
  const result = outcome.result ?? (thread ? summaryResultFromThread(thread) : null);

  if (verdict === 'waiting') {
    if (!statusMsg || !thread) return;
    const n = (thread.metadata?.waitingOn?.length ?? 0) + (thread.metadata?.waitingOnTasks?.length ?? 0);
    // No action blocks: this is the shape the webhook has always written for a suspended thread.
    await writeStatus(adapter, statusMsg, `${Icons.processing} Thread suspended — waiting on ${n} child(ren)`, { blocks: false });
    return;
  }
  if (verdict === 'rate_limited') {
    if (!statusMsg || !result) return;
    await writeStatus(adapter, statusMsg, buildThreadSummary(result));
    return;
  }
  if (verdict === 'failed' || verdict === 'cancelled') {
    const { elapsedStr } = computeElapsed(target.startTime);
    const message = error?.message || 'Unknown error';
    if (statusMsg) {
      const text = verdict === 'cancelled'
        ? `${Icons.stopped} Cancelled (${elapsedStr})`
        : `${Icons.error} Thread failed (${elapsedStr}): ${message}`;
      await sealSummaryText(adapter, statusMsg, text, blocks);
      return;
    }
    // No status message to seal — say it once on the destination instead (the elapsed-less
    // variant the `!thread` catch and the channel-less webhook path have always posted).
    const text = verdict === 'cancelled'
      ? `${Icons.stopped} Cancelled`
      : `${Icons.error} Thread failed: ${message}`;
    await adapter.postMessage(
      target.destination, { text },
      target.threadAnchorId ? { threadId: target.threadAnchorId } : undefined,
    );
    return;
  }
  // completed / aborted / split / rate-limit-exhausted: the summary already spells out which.
  if (!statusMsg || !result) return;
  await sealThreadSummary(adapter, statusMsg, result, blocks);
}
