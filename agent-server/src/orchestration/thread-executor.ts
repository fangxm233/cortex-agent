// input:  domain/threads, thread-runner, orch/channel-queue, orch/busy-tracker
// output: ThreadExecutor with queue markers plus detached thread runner
// pos:    Sole thread-routing execution path
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import type { Destination, PlatformAdapter, MessageRef, DownloadedFile, IncomingMessage, PlatformFileRef } from '@platform/index.js';
import type { RunThreadOptions } from '@core/types/thread-types.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../core/icons.js';
import { conduitQueues, enqueue } from './conduit-queue.js';
import { trackPendingTask } from './busy-tracker.js';
import { addAgentToThread, createThread, getTemplate, getAgent } from '@domain/threads/index.js';
import { runThread, continueThread, getActiveHandle } from '@domain/threads/runner.js';
import { downloadFiles as downloadPlatformFiles } from './routing/file-handler.js';
import { computeElapsed, buildStatusActionBlocks, buildSealedStatusActionBlocks, initStatusBlocks, sealThreadStatus } from './status-helpers.js';
import { threadStore } from '@store/thread-repo.js';
import { WORKSPACE_DIR } from '@core/utils.js';
import { buildInteractiveCallbacks } from './agent-runner.js';

const TEMP_DIR = WORKSPACE_DIR;
const log = createLogger('thread-executor');

type Enqueuer = (channel: string, fn: () => Promise<void>) => boolean;
type Tracker = (delta: number) => void;
type Executor = (ctx: ThreadExecCtx) => Promise<void>;

/** Run a thread fire-and-forget while holding the daemon busy gate for the ENTIRE pipeline.
 *  The Slack `!thread` path (ThreadExecutor.route), the scheduled-task path, and the task-dispatch
 *  path all bracket runThread with trackPendingTask(±1). The MCP `thread_start` webhook path did
 *  not — so a background thread was invisible to the busy/idle gate, and a deploy/restart deferred
 *  during the orchestrating session's turn would fire on the next idle and SIGTERM app.ts
 *  mid-thread, stamping it "Interrupted by server restart". This helper closes that gap.
 *
 *  track(+1) is synchronous so the daemon observes `busy` before it can act on any idle. The gate
 *  is held across BOTH the run AND the onSettled callback: onSettled (the MCP completion callback)
 *  may wake the parent agent for a full LLM turn, and `track(-1)` synchronously emits IPC `idle`.
 *  If we released the gate before awaiting onSettled, a deferred restart would fire mid-callback and
 *  SIGTERM app.ts, dropping the proactive completion notification. So we await onSettled first, then
 *  release. track(-1) lives in an inner `finally` so the gate never leaks. The thread runs detached:
 *  errors are logged (the caller already returned the threadId to the MCP client, which polls
 *  thread_status). `deps` is injectable for unit tests. */
export function runThreadDetached(
  threadId: string,
  runOpts: RunThreadOptions,
  deps: {
    run?: (id: string, opts: RunThreadOptions) => Promise<unknown>;
    track?: Tracker;
    onSettled?: (threadId: string) => void | Promise<void>;
  } = {},
): void {
  const run = deps.run ?? runThread;
  const track = deps.track ?? trackPendingTask;
  track(+1);
  run(threadId, runOpts)
    .catch((e) => log.error(`detached thread ${threadId} failed: ${(e as Error).message}`))
    .finally(async () => {
      // Hold the busy gate across the settle callback (which may wake the parent agent for a full
      // turn) so the daemon doesn't observe idle — and fire a deferred restart — mid-callback.
      // track(-1) still always runs in the inner finally, so the gate never leaks.
      try { await deps.onSettled?.(threadId); }
      catch (e) { log.error(`detached thread ${threadId} onSettled error: ${(e as Error).message}`); }
      finally { track(-1); }
    });
}

export interface ThreadExecCtx {
  message: IncomingMessage;
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  hasFiles: boolean;
  agentMessage: string;
  threadAddMatch: RegExpMatchArray | null;
  threadStartMatch: RegExpMatchArray | null;
  existingThread: any;
  isActiveThread: boolean;
}

export class ThreadExecutor {
  readonly _enqueue: Enqueuer;
  readonly _track: Tracker;
  /** Injectable for unit tests — allows verification of track(-1)-in-finally without running real thread ops. */
  readonly _execute: Executor;

  constructor(opts: { enqueue?: Enqueuer; track?: Tracker; execute?: Executor } = {}) {
    this._enqueue = opts.enqueue ?? enqueue;
    this._track = opts.track ?? trackPendingTask;
    this._execute = opts.execute ?? ((ctx) => this._executeReal(ctx));
  }

  async route(ctx: ThreadExecCtx): Promise<void> {
    const { message, channel, adapter } = ctx;

    // Phase 6: buffer user messages when the thread is running a step,
    // so they're included in the next step's prompt instead of being lost.
    // DR-0014: also buffer for a parent suspended on child threads — routing such a
    // message through handleThreadContinue would prematurely wake the parent AND
    // overwrite its userMessage (the delegation contract).
    const suspendedOnChildren = ctx.existingThread?.status === 'waiting'
      && !!ctx.existingThread?.metadata?.waitingOn?.length;
    if (ctx.isActiveThread && ctx.existingThread
        && (ctx.existingThread.status === 'running' || suspendedOnChildren)
        && !ctx.threadAddMatch && !ctx.threadStartMatch) {
      await bufferUserMessage(ctx);
      return;
    }

    const markerRef = conduitQueues.has(channel)
      ? { conduit: channel, messageId: message.ref.messageId }
      : null;
    if (markerRef) await adapter.markQueued(markerRef).catch(() => {});
    this._track(+1);
    this._enqueue(channel, () => this._runQueued(ctx, markerRef));
  }

  private async _runQueued(ctx: ThreadExecCtx, markerRef: MessageRef | null): Promise<void> {
    try {
      await this._execute(ctx);
    } finally {
      if (markerRef) await ctx.adapter.unmarkQueued(markerRef).catch(() => {});
      this._track(-1);
    }
  }

  private async _executeReal(ctx: ThreadExecCtx): Promise<void> {
    const { channel, adapter } = ctx;
    const interactiveDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
    const startTime = Date.now();
    let statusMsg: MessageRef | undefined;
    const downloadedFiles = await downloadFiles(ctx.message.files, ctx.hasFiles, ctx.adapter);
    try {
      if (ctx.threadAddMatch) {
        statusMsg = await handleThreadAdd({ threadAddMatch: ctx.threadAddMatch, existingThread: ctx.existingThread, channel, adapter, threadAnchorId: ctx.threadAnchorId, startTime, downloadedFiles }) || undefined;
      } else if (ctx.isActiveThread && ctx.existingThread) {
        statusMsg = await handleThreadContinue({ existingThread: ctx.existingThread, agentMessage: ctx.agentMessage, channel, adapter, threadAnchorId: ctx.threadAnchorId, startTime, downloadedFiles });
      } else if (ctx.threadStartMatch) {
        statusMsg = await handleThreadStart({ threadStartMatch: ctx.threadStartMatch, messageId: ctx.message.ref.messageId, channel, adapter, threadAnchorId: ctx.threadAnchorId, startTime, downloadedFiles }) || undefined;
      }
    } catch (error) {
      const { elapsedStr } = computeElapsed(startTime);
      const isCancelled = (error as any)?.cancelled;
      const errorBlocksTemplate = { channel, sessionName: null, isDm: false };
      if (isCancelled) {
        if (statusMsg) {
          const cancelText = `${Icons.stopped} Cancelled (${elapsedStr})`;
          await adapter.updateMessage(statusMsg, {
            text: cancelText,
            richBlocks: buildSealedStatusActionBlocks(cancelText, errorBlocksTemplate),
          }).catch(() => {});
        } else {
          await adapter.postMessage(interactiveDest, { text: `${Icons.stopped} Cancelled` }, ctx.threadAnchorId ? { threadId: ctx.threadAnchorId } : undefined).catch(() => {});
        }
      } else {
        const errorMsg = (error as Error)?.message || 'Unknown error';
        if (statusMsg) {
          const failText = `${Icons.error} Thread failed (${elapsedStr}): ${errorMsg}`;
          await adapter.updateMessage(statusMsg, {
            text: failText,
            richBlocks: buildSealedStatusActionBlocks(failText, errorBlocksTemplate),
          }).catch(() => {});
        } else {
          await adapter.postMessage(interactiveDest, { text: `${Icons.error} Thread failed: ${errorMsg}` }, ctx.threadAnchorId ? { threadId: ctx.threadAnchorId } : undefined).catch(() => {});
        }
      }
    }
  }
}

export const threadExecutor = new ThreadExecutor();

// --- Thread sub-handlers ---

async function handleThreadAdd({ threadAddMatch, existingThread, channel, adapter, threadAnchorId, startTime, downloadedFiles }: {
  threadAddMatch: RegExpMatchArray; existingThread: any; channel: string; adapter: PlatformAdapter;
  threadAnchorId: string | null; startTime: number; downloadedFiles: DownloadedFile[];
}): Promise<MessageRef | null> {
  const interactiveDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const addAgentName = threadAddMatch[1];
  const addMessage = threadAddMatch[2]?.trim() || null;
  const targetThread = await validateThreadAddTarget(addAgentName, existingThread, channel, adapter, threadAnchorId);
  if (!targetThread) return null;

  await addAgentToThread(targetThread.id, addAgentName, addMessage);
  const platformThreadId = targetThread.platformThreadId || threadAnchorId;
  const threadBlocksTemplate = { channel, sessionName: null, isDm: false, threadId: targetThread.id };
  const addText = `${Icons.add} Adding *${addAgentName}* to thread ${targetThread.id.substring(0, 12)}...`;
  const statusMsg = await adapter.postMessage(interactiveDest, {
    text: addText,
    richBlocks: buildStatusActionBlocks(addText, threadBlocksTemplate),
  }, platformThreadId ? { threadId: platformThreadId } : undefined);
  initStatusBlocks(statusMsg, threadBlocksTemplate);

  const interactiveCallbacks = buildInteractiveCallbacks(channel, null);
  const threadResult = await runThread(targetThread.id, {
    adapter, channel, threadAnchorId: platformThreadId, statusMsg, startTime, files: downloadedFiles,
    destination: interactiveDest,
    onToolUse: interactiveCallbacks.onToolUse, onPlanWritten: interactiveCallbacks.onPlanWritten, onAskUserQuestion: interactiveCallbacks.onAskUserQuestion,
  });
  await sealThreadStatus(adapter, statusMsg, threadResult, { blocksTemplate: threadBlocksTemplate });
  return statusMsg;
}

async function validateThreadAddTarget(addAgentName: string, existingThread: any, channel: string, adapter: PlatformAdapter, threadAnchorId: string | null): Promise<any> {
  const interactiveDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (!getAgent(addAgentName)) {
    await adapter.postMessage(interactiveDest, { text: `${Icons.error} Unknown agent: \`${addAgentName}\`. Use \`!thread agents\` to see available agents.` }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
    return null;
  }
  // Plain user conversations are no longer wrapped in a thread (templateName='default'), so they
  // cannot be chained off. Exclude any legacy 'default' threads still present in the store — the
  // user must start an explicit thread with `!thread <agent> <message>` to use `!thread add`.
  const targetThread = existingThread || threadStore.findByChannel(channel).find((t: any) => (t.status === 'completed' || t.status === 'waiting') && t.templateName !== 'default');
  if (!targetThread) {
    await adapter.postMessage(interactiveDest, { text: `${Icons.error} No thread found. Start one first with \`!thread <agent> <message>\`.` }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
    return null;
  }
  if (targetThread.status === 'running' && getActiveHandle(channel)) {
    await adapter.postMessage(interactiveDest, { text: `${Icons.warning} Thread ${targetThread.id.substring(0, 12)} is currently running. Wait for it to finish.` }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
    return null;
  }
  return targetThread;
}

async function handleThreadContinue({ existingThread, agentMessage, channel, adapter, threadAnchorId, startTime, downloadedFiles }: {
  existingThread: any; agentMessage: string; channel: string; adapter: PlatformAdapter;
  threadAnchorId: string | null; startTime: number; downloadedFiles: DownloadedFile[];
}): Promise<MessageRef> {
  const interactiveDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const continueBlocksTemplate = { channel, sessionName: null, isDm: false, threadId: existingThread.id };
  const continueText = `${Icons.processing} Continuing thread ${existingThread.id.substring(0, 12)}...`;
  const statusMsg = await adapter.postMessage(interactiveDest, {
    text: continueText,
    richBlocks: buildStatusActionBlocks(continueText, continueBlocksTemplate),
  }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
  initStatusBlocks(statusMsg, continueBlocksTemplate);

  const interactiveCallbacks = buildInteractiveCallbacks(channel, null);
  const threadResult = await continueThread(existingThread.id, agentMessage, {
    adapter, channel, threadAnchorId, statusMsg, startTime, files: downloadedFiles,
    destination: interactiveDest,
    onToolUse: interactiveCallbacks.onToolUse, onPlanWritten: interactiveCallbacks.onPlanWritten, onAskUserQuestion: interactiveCallbacks.onAskUserQuestion,
  });

  await sealThreadStatus(adapter, statusMsg, threadResult, { blocksTemplate: continueBlocksTemplate });
  return statusMsg;
}

async function handleThreadStart({ threadStartMatch, messageId, channel, adapter, threadAnchorId, startTime, downloadedFiles }: {
  threadStartMatch: RegExpMatchArray; messageId: string; channel: string; adapter: PlatformAdapter;
  threadAnchorId: string | null; startTime: number; downloadedFiles: DownloadedFile[];
}): Promise<MessageRef | null> {
  const interactiveDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const name = threadStartMatch[1];
  const template = getTemplate(name);
  const agent = getAgent(name);
  if (!template && !agent) {
    await adapter.postMessage(interactiveDest, { text: `${Icons.error} Unknown template or agent: \`${name}\`. Use \`!thread templates\` or \`!thread agents\`.` });
    return null;
  }

  const startBlocksTemplate = { channel, sessionName: null, isDm: false };
  const startText = `${Icons.processing} Starting thread (${template ? name : `agent:${name}`})...`;
  const statusMsg = await adapter.postMessage(interactiveDest, {
    text: startText,
    // No Cancel button initially — threadId needed first
  }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
  const platformThreadId = threadAnchorId || statusMsg.messageId;
  const thread = createThread(channel, {
    templateName: template ? name : null, agentName: template ? null : name,
    userMessage: threadStartMatch[2].trim(), userMessageTs: messageId, platformThreadId,
  });
  // Update status message with Cancel button now that we have thread.id
  const startBlocksTemplateWithThread = { ...startBlocksTemplate, threadId: thread.id };
  await adapter.updateMessage(statusMsg, {
    text: startText,
    richBlocks: buildStatusActionBlocks(startText, startBlocksTemplateWithThread),
  }).catch(() => {});
  initStatusBlocks(statusMsg, startBlocksTemplateWithThread);

  const interactiveCallbacks = buildInteractiveCallbacks(channel, null);
  const threadResult = await runThread(thread.id, {
    adapter, channel, threadAnchorId: platformThreadId, statusMsg, startTime, files: downloadedFiles,
    destination: interactiveDest,
    onToolUse: interactiveCallbacks.onToolUse, onPlanWritten: interactiveCallbacks.onPlanWritten, onAskUserQuestion: interactiveCallbacks.onAskUserQuestion,
  });
  await sealThreadStatus(adapter, statusMsg, threadResult, { blocksTemplate: startBlocksTemplate });
  return statusMsg;
}


// --- Message buffering (Phase 6) ---

/** Append a user message to thread.metadata.pendingMessages for inclusion
 *  in the next step's prompt. Used when a step is currently executing
 *  and we can't safely call continueThread + runThread concurrently. */
async function bufferUserMessage(ctx: ThreadExecCtx): Promise<void> {
  const { adapter, channel, threadAnchorId } = ctx;
  const interactiveDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const thread = ctx.existingThread;
  const text = ctx.agentMessage || ctx.message.text || '';

  // Synchronously append to in-memory metadata so the next buildStepPrompt
  // call (within the same event-loop tick) sees it immediately.
  // NOTE: Uses threadStore.set() (not mutate()) intentionally — mutate() awaits
  // _pendingPersist which introduces a microtask delay, breaking the synchronous
  // visibility guarantee required by the runThread main loop. The in-memory ref is
  // updated first, then the fire-and-forget set() persists the whole record.
  if (!thread.metadata) thread.metadata = {};
  if (!Array.isArray(thread.metadata.pendingMessages)) thread.metadata.pendingMessages = [];
  // Cap at 10 to prevent unbounded prompt growth
  if (thread.metadata.pendingMessages.length >= 10) {
    thread.metadata.pendingMessages.shift();
  }
  thread.metadata.pendingMessages.push(text);

  // Fire-and-forget persist — .set() is deliberate (see NOTE above). Errors are
  // dropped because the in-memory state is authoritative and will be persisted by
  // the next conventional mutate() call on this thread.
  threadStore.set(thread).catch(() => {});

  await adapter.postMessage(interactiveDest, {
    text: `${Icons.inbox} Message buffered — will be included in the next step’s prompt`,
  }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
}

// --- Shared helper ---

async function downloadFiles(files: PlatformFileRef[] | undefined, hasFiles: boolean, adapter: PlatformAdapter): Promise<DownloadedFile[]> {
  if (!hasFiles || !files) return [];
  return downloadPlatformFiles(files, adapter, TEMP_DIR);
}
