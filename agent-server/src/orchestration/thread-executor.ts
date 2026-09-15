import type { Destination, PlatformAdapter, MessageRef, DownloadedFile } from '@platform/index.js';
import { Icons } from '../core/icons.js';
import { conduitQueues, enqueue } from './conduit-queue.js';
import { trackPendingTask } from './busy-tracker.js';
import { addAgentToThread, createThread, getTemplate, getAgent } from '@domain/threads/index.js';
import { getActiveHandle } from '@domain/threads/runner.js';
import { openThreadRun, type ThreadRunInput } from './thread-run/index.js';
import { threadStore } from '@store/thread-repo.js';
import { type ThreadExecCtx, downloadFiles, bufferUserMessage } from './thread-input.js';

export type { ThreadExecCtx };

type Enqueuer = (channel: string, fn: () => Promise<void>) => boolean;
type Tracker = (delta: number) => void;
type Executor = (ctx: ThreadExecCtx) => Promise<void>;

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

  /** Validate, create/extend the thread record, then hand the whole run to `ThreadRun`.
   *  The catch covers the VALIDATION phase only: once `openThreadRun` is entered, the failure /
   *  cancellation rendering (onto the live status message, with the elapsed clock) belongs to it. */
  private async _executeReal(ctx: ThreadExecCtx): Promise<void> {
    const startTime = Date.now();
    // A thread's first step takes the files; a failed download is named in the buffered-input
    // prompt instead (thread-input), and logged by the downloader either way.
    const { files: downloadedFiles } = await downloadFiles(ctx.message, ctx.hasFiles, ctx.adapter);
    const args = { channel: ctx.channel, adapter: ctx.adapter, threadAnchorId: ctx.threadAnchorId, startTime, downloadedFiles };
    try {
      if (ctx.threadAddMatch) {
        await handleThreadAdd({ ...args, threadAddMatch: ctx.threadAddMatch, existingThread: ctx.existingThread });
      } else if (ctx.isActiveThread && ctx.existingThread) {
        await handleThreadContinue({ ...args, existingThread: ctx.existingThread, agentMessage: ctx.agentMessage });
      } else if (ctx.threadStartMatch) {
        await handleThreadStart({ ...args, threadStartMatch: ctx.threadStartMatch, messageId: ctx.message.ref.messageId });
      }
    } catch (error) {
      const isCancelled = (error as any)?.cancelled;
      const text = isCancelled
        ? `${Icons.stopped} Cancelled`
        : `${Icons.error} Thread failed: ${(error as Error)?.message || 'Unknown error'}`;
      await ctx.adapter.postMessage(
        { type: 'interactive-reply', conduit: ctx.channel, sessionId: '' },
        { text },
        ctx.threadAnchorId ? { threadId: ctx.threadAnchorId } : undefined,
      ).catch(() => {});
    }
  }
}

export const threadExecutor = new ThreadExecutor();

// --- Thread sub-handlers ---
//
// Each one validates, writes the thread record, and opens a ThreadRun. Nothing here posts, updates
// or seals a status message: `render: { kind: 'summary' }` tells ThreadRun to post `startText`,
// re-render it with the Cancel button and seal it with `buildThreadSummary` at the end.

interface HandlerArgs {
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  startTime: number;
  downloadedFiles: DownloadedFile[];
}

/** The shared half of all three ThreadRunInputs: an interactive surface, with buttons, that
 *  captures plan/ask dialogs and settles nothing (the user is watching the status message). */
function interactiveRunInput(args: HandlerArgs, threadId: string, startText: string): Omit<ThreadRunInput, 'mode'> {
  return {
    threadId, channel: args.channel, adapter: args.adapter,
    destination: { type: 'interactive-reply', conduit: args.channel, sessionId: '' } as Destination,
    threadAnchorId: args.threadAnchorId,
    claimPlatformThread: true,
    statusMessage: null,
    render: {
      kind: 'summary' as const,
      blocks: { channel: args.channel, sessionName: null, isDm: false, threadId },
      startText,
    },
    interactive: true, files: args.downloadedFiles, startTime: args.startTime, settle: null,
  };
}

async function handleThreadAdd(args: HandlerArgs & { threadAddMatch: RegExpMatchArray; existingThread: any }): Promise<void> {
  const addAgentName = args.threadAddMatch[1];
  const addMessage = args.threadAddMatch[2]?.trim() || null;
  const target = await validateThreadAddTarget(addAgentName, args.existingThread, args.channel, args.adapter, args.threadAnchorId);
  if (!target) return;

  await addAgentToThread(target.id, addAgentName, addMessage);
  const startText = `${Icons.add} Adding *${addAgentName}* to thread ${target.id.substring(0, 12)}...`;
  await openThreadRun({
    ...interactiveRunInput(args, target.id, startText),
    mode: { kind: 'start' },
    threadAnchorId: target.platformThreadId || args.threadAnchorId,
  });
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

async function handleThreadContinue(args: HandlerArgs & { existingThread: any; agentMessage: string }): Promise<void> {
  const startText = `${Icons.processing} Continuing thread ${args.existingThread.id.substring(0, 12)}...`;
  await openThreadRun({
    ...interactiveRunInput(args, args.existingThread.id, startText),
    mode: { kind: 'continue', userMessage: args.agentMessage },
  });
}

async function handleThreadStart(args: HandlerArgs & { threadStartMatch: RegExpMatchArray; messageId: string }): Promise<void> {
  const name = args.threadStartMatch[1];
  const template = getTemplate(name);
  const agent = getAgent(name);
  if (!template && !agent) {
    await args.adapter.postMessage(
      { type: 'interactive-reply', conduit: args.channel, sessionId: '' },
      { text: `${Icons.error} Unknown template or agent: \`${name}\`. Use \`!thread templates\` or \`!thread agents\`.` },
    );
    return;
  }
  // platformThreadId is the anchor when the user is already in a platform thread; otherwise
  // ThreadRun stamps the status message it posts (which is what this used to pass inline).
  const thread = createThread(args.channel, {
    templateName: template ? name : null, agentName: template ? null : name,
    userMessage: args.threadStartMatch[2].trim(), userMessageTs: args.messageId,
    platformThreadId: args.threadAnchorId,
  });
  const startText = `${Icons.processing} Starting thread (${template ? name : `agent:${name}`})...`;
  await openThreadRun({ ...interactiveRunInput(args, thread.id, startText), mode: { kind: 'start' } });
}
