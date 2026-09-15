// input:  one thread's id + mode + the surface it runs on (adapter, destination, status message,
//         blocks template, interactivity) and an optional settle hook
// output: the whole run — status message, OutputStream, progress line, the `runThread` family
//         call, the verdict, the terminal render/seal, `statusMsgRef` persistence and settle
// pos:    orchestration/thread-run — the thread-path twin of `orchestration/turn/turn.ts`. Every
//         caller that used to assemble a `RunThreadOptions` by hand (thread-executor x3, the MCP
//         `thread_start` webhook, the suspended-parent resume, the rate-limit resume) now hands
//         one `ThreadRunInput` over and renders nothing itself. Dependencies run one way,
//         caller → ThreadRun: nothing here imports thread-executor, webhook or thread-callback
//         (depcruise `no-circular`), which is why `settle` is injected rather than imported.

import type { Destination, DownloadedFile, MessageRef, PlatformAdapter } from '@platform/index.js';
import type { RunThreadOptions } from '@core/types/thread-types.js';
import { createLogger } from '@core/log.js';
import { threadStore } from '@store/thread-repo.js';
import {
  continueThread, resumeRateLimitedThread, resumeThread, runThread, type ThreadRunResult,
} from '@domain/threads/runner.js';
import { buildInteractiveCallbacks } from '../turn/turn.js';
import { trackPendingTask } from '../busy-tracker.js';
import type { StatusBlocksTemplate } from '../status-helpers.js';
import { createThreadSurface } from './thread-surface.js';
import { openSummaryStatus, renderSummaryOutcome, renderSummaryProgress } from './render-summary.js';
import { settleThreadRun } from './settle.js';
import { classifyThreadVerdict, type ThreadVerdict } from './verdict.js';

const log = createLogger('thread-run');

export type { ThreadVerdict };

/** How this run enters the thread. Exactly the four `domain/threads/runner` entrypoints. */
export type ThreadRunMode =
  | { kind: 'start' }
  | { kind: 'continue'; userMessage: string }
  | { kind: 'resume' }
  | { kind: 'resume-rate-limited' };

export interface ThreadRunInput {
  threadId: string;
  mode: ThreadRunMode;
  channel: string;
  adapter: PlatformAdapter;
  /** Where output goes — `interactive-reply` or `project-report`. The caller decides; ThreadRun
   *  never infers it from the channel. */
  destination: Destination;
  threadAnchorId: string | null;
  /** When ThreadRun posts the status message itself and the record has no platformThreadId yet,
   *  make that message the thread's platform root — a user reply under it then continues THIS
   *  thread (what `!thread` has always done at createThread time). False for the MCP path: the
   *  parent session owns that channel, and a reply under an agent-spawned thread's status line
   *  stays a conversation message, as today. Irrelevant when `statusMessage` is supplied. */
  claimPlatformThread: boolean;
  /** A status message the CALLER already posted (a resume's persisted `statusMsgRef`, and in T2.2
   *  the dispatch / scheduled processing lines). Null ⇒ ThreadRun posts `render.startText` itself. */
  statusMessage: MessageRef | null;
  render: {
    kind: 'summary';
    /** Action-button template, or null for a background surface with nobody to click. */
    blocks: StatusBlocksTemplate | null;
    /** Opening line to post when `statusMessage` is null; null ⇒ this run draws no status line. */
    startText: string | null;
  };
  /** Capture plan / ask-user dialogs for a live user (`!thread`); false for background runs. */
  interactive: boolean;
  files?: DownloadedFile[];
  onAbort?: RunThreadOptions['onAbort'];
  extraHooks?: RunThreadOptions['extraHooks'];
  startTime?: number;
  /** Wake whoever is waiting on this thread. `thread-callback.settleThread` for the MCP and resume
   *  paths; null for the interactive path (the user is already looking at the status message). */
  settle: ((threadId: string) => Promise<void>) | null;
}

export interface ThreadRunOutcome {
  verdict: ThreadVerdict;
  result: ThreadRunResult | null;
  error: Error | null;
  /** The status message this run drew on, for a caller that wants to keep rendering on it. */
  statusMsg: MessageRef | null;
}

/**
 * Run one thread on one surface, to completion.
 *
 * Resolves once the terminal render and the settle hook are done. It does NOT reject for a failure
 * inside the run: the failure IS the outcome (`verdict: 'failed' | 'cancelled'`), already rendered
 * and logged, and callers — the dispatch path above all — need the verdict to decide what happens
 * to the task. Rendering and settle failures are logged too. A status message that cannot be posted
 * is tolerated (the run continues with nowhere to draw); only an unexpected failure while opening
 * the surface itself escapes.
 *
 * The daemon busy gate is NOT taken here: `ThreadExecutor.route` already brackets its queued work
 * and `resume-dispatcher` brackets its own fire-and-forget resume. `openThreadRunDetached` below is
 * the one path that has no bracket of its own and therefore takes it.
 */
export async function openThreadRun(input: ThreadRunInput): Promise<ThreadRunOutcome> {
  return new ThreadRun(input).run();
}

export class ThreadRun {
  private readonly input: ThreadRunInput;
  private readonly startTime: number;

  constructor(input: ThreadRunInput) {
    this.input = input;
    this.startTime = input.startTime ?? Date.now();
  }

  async run(): Promise<ThreadRunOutcome> {
    const { adapter, destination, threadAnchorId, render, threadId } = this.input;

    // 1. Status message: the caller's, or our own two-step post (text first, then the same text
    //    with the Cancel button once the thread id is known).
    const statusMsg = this.input.statusMessage ?? await this.postStatus();
    // 2. The platform thread everything hangs off: the caller's anchor, else the status message we
    //    just posted. Only a claiming caller (`!thread`) makes that message the record's platform
    //    root — see `claimPlatformThread`.
    const anchor = threadAnchorId ?? statusMsg?.messageId ?? null;
    if (this.input.claimPlatformThread && !this.input.statusMessage && anchor) await this.stampPlatformThread(anchor);

    const stream = adapter.openOutputStream(destination, { threadId: anchor, anchorRef: statusMsg });
    const surface = createThreadSurface({
      adapter, statusMsg, threadId, startTime: this.startTime,
      renderProgress: renderSummaryProgress,
      interactive: this.input.interactive ? buildInteractiveCallbacks(this.input.channel, null) : null,
    });

    // 3. Run. A throw is a verdict, not an escape — see the class doc.
    let result: ThreadRunResult | null = null;
    let error: Error | null = null;
    try {
      result = await this.invoke({
        channel: this.input.channel, startTime: this.startTime, stream, surface,
        ...(this.input.files ? { files: this.input.files } : {}),
        ...(this.input.onAbort ? { onAbort: this.input.onAbort } : {}),
        ...(this.input.extraHooks ? { extraHooks: this.input.extraHooks } : {}),
      });
    } catch (e) {
      error = e as Error;
      log.error(`thread ${threadId} ${(e as Error & { cancelled?: boolean }).cancelled ? 'cancelled' : 'failed'}: ${(e as Error).message}`);
    }
    const verdict = classifyThreadVerdict(result, error);

    // 4. Render the verdict. A delivery failure must not cost the caller its outcome or the
    //    parent its wake-up, so it is logged and swallowed here (and only here).
    try {
      await renderSummaryOutcome(
        {
          adapter, statusMsg, blocks: render.blocks, destination, threadAnchorId,
          startTime: this.startTime,
        },
        { threadId, verdict, thread: threadStore.get(threadId), result, error },
      );
    } catch (e) {
      log.warn(`render ${verdict} for ${threadId}: ${(e as Error).message}`);
    }

    // 5. Persist the live ref for a run that will be re-entered, then wake whoever is waiting.
    await settleThreadRun({ threadId, verdict, statusMsg, settle: this.input.settle });

    return { verdict, result, error, statusMsg };
  }

  private async postStatus(): Promise<MessageRef | null> {
    const { render, adapter, destination, threadAnchorId } = this.input;
    if (!render.startText) return null;
    try {
      return await openSummaryStatus(adapter, destination, threadAnchorId, render.startText, render.blocks);
    } catch (e) {
      // The webhook's posture, now everyone's: a thread whose status line cannot be posted still
      // runs — it just has nowhere to draw.
      log.warn(`thread ${this.input.threadId}: status message post failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Stamp the platform thread root onto the record when the caller could not know it yet (it is
   *  the id of the status message we posted a moment ago). `!thread` did this inside createThread. */
  private async stampPlatformThread(anchor: string): Promise<void> {
    if (threadStore.get(this.input.threadId)?.platformThreadId) return;
    await threadStore.mutate(this.input.threadId, (t) => { t.platformThreadId = anchor; })
      .catch((e) => log.warn(`stamp platformThreadId ${this.input.threadId}: ${(e as Error).message}`));
  }

  private invoke(opts: RunThreadOptions): Promise<ThreadRunResult> {
    const { threadId, mode } = this.input;
    switch (mode.kind) {
      case 'continue': return continueThread(threadId, mode.userMessage, opts);
      case 'resume': return resumeThread(threadId, opts);
      case 'resume-rate-limited': return resumeRateLimitedThread(threadId, opts);
      default: return runThread(threadId, opts);
    }
  }
}

/**
 * Run a thread fire-and-forget while holding the daemon busy gate for the ENTIRE pipeline.
 * (Verbatim port of the detached-run helper thread-executor used to own; its doc follows.)
 *
 * The Slack `!thread` path (ThreadExecutor.route), the scheduled-task path, and the task-dispatch
 * path all bracket their run with trackPendingTask(±1). The MCP `thread_start` webhook path did
 * not — so a background thread was invisible to the busy/idle gate, and a deploy/restart deferred
 * during the orchestrating session's turn would fire on the next idle and SIGTERM app.ts
 * mid-thread, stamping it "Interrupted by server restart". This helper closes that gap.
 *
 * track(+1) is synchronous so the daemon observes `busy` before it can act on any idle. The gate is
 * held across the run, the render, the settle AND the `onSettled` callback: settling wakes the
 * parent agent for a full LLM turn, and `track(-1)` synchronously emits IPC `idle`. If we released
 * the gate first, a deferred restart would fire mid-callback and SIGTERM app.ts, dropping the
 * proactive completion notification. So we await `onSettled` first, then release. track(-1) lives
 * in an inner `finally` so the gate never leaks. Errors are only logged (the caller already
 * returned the threadId to the MCP client, which polls thread_status). `deps` is injectable for
 * unit tests.
 */
export function openThreadRunDetached(
  input: ThreadRunInput,
  onSettled?: (threadId: string) => void | Promise<void>,
  deps: {
    run?: (input: ThreadRunInput) => Promise<unknown>;
    track?: (delta: number) => void;
  } = {},
): void {
  const run = deps.run ?? openThreadRun;
  const track = deps.track ?? trackPendingTask;
  track(+1);
  run(input)
    .catch((e) => log.error(`detached thread ${input.threadId} failed: ${(e as Error).message}`))
    .finally(async () => {
      try { await onSettled?.(input.threadId); }
      catch (e) { log.error(`detached thread ${input.threadId} onSettled error: ${(e as Error).message}`); }
      finally { track(-1); }
    });
}
