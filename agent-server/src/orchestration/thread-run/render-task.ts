// input:  a task-framed run's status message + the verdict the owning job reached about the TASK
// output: every TASK-style rendering — the opening line, the in-step progress line, and the one
//         terminal / non-terminal line the dispatch and scheduled jobs used to write themselves
// pos:    orchestration/thread-run — the sibling of render-summary. These two files are the only
//         thread renderers left (plan §0-3). Everything here is a verbatim port of the status
//         strings that lived inline in `domain/scheduling/jobs/{task-dispatch,scheduled-task}.ts`
//         and in the jobs' shared finalize helper; the jobs now decide WHAT happened (a
//         `TaskVerdict`) and never touch the adapter.

import type { Destination, MessageRef, PlatformAdapter } from '@platform/index.js';
import type { ThreadRunResult } from '@domain/threads/runner.js';
import {
  buildSessionTag, buildUserProcessingMessage, computeElapsed, formatMetricsSuffix,
} from '@core/status-format.js';
import { createLogger } from '@core/log.js';
import { Icons } from '@core/icons.js';
import { durablePost, durableUpdate, getOutboundQueue } from '@store/outbound-queue.js';
import { sealStatus } from '../status-helpers.js';
import { renderSummaryProgress } from './render-summary.js';
import type { ProgressRenderer } from './thread-surface.js';

const log = createLogger('render-task');

/** Which job this run is drawing for, and the few values its lines quote. Assembled by the job
 *  and handed over as `ThreadRunInput.render`. */
export interface TaskRender {
  kind: 'task';
  /** `dispatch` leads every line with `[project] <task text>`; `scheduled` leads with the session
   *  tag. That asymmetry is the shipped one — a dispatch line is read in a busy project channel
   *  and has to say WHICH task, a scheduled line only has to say which run. */
  flavour: 'dispatch' | 'scheduled';
  /** dispatch: the claimed task's project. scheduled: the schedule's project id. */
  project: string;
  /** The claimed task's full text — truncated to 80 chars HERE, so the job never pre-formats.
   *  Null for scheduled (its lines do not quote the message). */
  taskText: string | null;
  sessionName: string;
  profileName: string;
}

/**
 * What the owning job concluded about the TASK behind this thread run — one member per shipped
 * status line. The thread's own verdict (`ThreadVerdict`) says how the RUN ended; this says what
 * that means for the task, which only the job knows (it is the thing that blocked / unclaimed /
 * decomposed / registered a session a moment earlier).
 */
export type TaskVerdict =
  /** Terminal success. */
  | { kind: 'done' }
  /** Non-terminal: the thread parked on children. Not sealed — the resumed run rewrites this line. */
  | { kind: 'suspended'; childThreads: number; childTasks: number }
  /** The worker escalated ([ABORT: …]); `blockError` is set when blocking the task itself failed. */
  | { kind: 'aborted'; note: string; blockError: string | null }
  /** The worker proposed a decomposition; `error` is set when the proposal was rejected. */
  | { kind: 'split'; note: string; error: string | null }
  /** Non-terminal: paused by an active rate-limit throttle, will auto-resume. */
  | { kind: 'paused' }
  /** Rate limited with no throttle to wait on — every fallback was exhausted. */
  | { kind: 'exhausted' }
  /** The run threw (or the job's own decision did). */
  | { kind: 'error'; message: string };

/** Where a task-style run draws itself. Assembled once by `ThreadRun`. */
export interface TaskRenderTarget {
  adapter: PlatformAdapter;
  /** The live status message, or null when the opening post failed — then only the destination
   *  notice below can say anything. */
  statusMsg: MessageRef | null;
  /** The project-report destination this run reports on (the scheduled error notice posts here). */
  destination: Destination;
  startTime: number;
  /** The run's result, for the session tag and the metrics suffix. */
  result: ThreadRunResult | null;
}

/** `[project] first-80-chars-of-the-task` — the lead every dispatch line has always carried. */
function taskLabel(render: TaskRender): string {
  return `[${render.project}] ${(render.taskText ?? '').substring(0, 80)}`;
}

/** The opening line, posted by `ThreadRun` when the job supplied no status message (both jobs). */
export function taskStartText(render: TaskRender, startTime: number): string {
  if (render.flavour === 'dispatch') {
    return `${Icons.satellite} Dispatching: ${taskLabel(render)}... | ${render.sessionName} | ${render.profileName}`;
  }
  return buildUserProcessingMessage({
    startTime, profileName: render.profileName, sessionName: render.sessionName,
  });
}

/** Post the opening line. No action blocks: nobody clicks a background surface. */
export function openTaskStatus(
  adapter: PlatformAdapter, destination: Destination, text: string,
): Promise<MessageRef | null> {
  return adapter.postMessage(destination, { text });
}

/**
 * The in-step progress line.
 *
 * `dispatch` reuses the multi-agent line verbatim — its old inline updater was a copy of the one
 * the thread runner used to write. `scheduled` redraws its own processing line with turns and
 * elapsed (the scheduler's former progress updater), and draws nothing at a step boundary,
 * which is why its step-started report returns null.
 */
export function makeTaskProgressRenderer(render: TaskRender): ProgressRenderer {
  if (render.flavour === 'dispatch') return renderSummaryProgress;
  return ({ phase, numTurns, durationMs, startTime }) => {
    if (phase === 'step-started') return null;
    return buildUserProcessingMessage({
      startTime,
      elapsed_s: durationMs != null ? durationMs / 1000 : null,
      num_turns: numTurns ?? null,
      profileName: render.profileName,
      sessionName: render.sessionName,
    });
  };
}

/** A NON-terminal line. Durable when a queue exists, exactly as the jobs wrote it; deliberately
 *  NOT `sealStatus` — the thread will be resumed and the resumed run keeps writing here. */
async function writeTaskStatus(adapter: PlatformAdapter, ref: MessageRef, text: string): Promise<void> {
  const queue = getOutboundQueue();
  if (queue) await durableUpdate(queue, adapter, ref, { text });
  else await adapter.updateMessage(ref, { text }).catch(() => {});
}

/** A terminal line. `sealStatus` is already durable-when-queued and closes the write chain, so a
 *  late progress update can no longer overwrite it. Failures are logged, never thrown: the line is
 *  the last thing that happens to a run and must not cost the job its bookkeeping. */
async function sealTaskStatus(adapter: PlatformAdapter, ref: MessageRef, text: string): Promise<void> {
  try {
    await sealStatus(adapter, ref, text);
  } catch (e) {
    log.warn(`seal task status ${ref.conduit}:${ref.messageId}: ${(e as Error).message}`);
  }
}

async function postTaskNotice(adapter: PlatformAdapter, destination: Destination, text: string): Promise<void> {
  const queue = getOutboundQueue();
  if (queue) await durablePost(queue, adapter, destination, { text });
  else await adapter.postMessage(destination, { text });
}

/**
 * Render one task-style verdict. Every string below is byte-identical to the one the two jobs
 * wrote before this file existed; the mapping old-site → member is in the T2.2 report.
 *
 * The dispatch `error` line is the one deliberate absence: a failed dispatch has never touched its
 * status message (it stays on "Dispatching…"), it posts a separate project notice — and that
 * notice is identical whether the failure happened before or during the run, so the job owns that
 * one string and delivers it through `ctx.notify`.
 */
export async function renderTaskOutcome(
  target: TaskRenderTarget, render: TaskRender, verdict: TaskVerdict,
): Promise<void> {
  const { adapter, statusMsg } = target;
  const agent = (target.result?.lastAgentResult ?? null) as { sessionId?: string } | null;
  const { elapsedStr } = computeElapsed(target.startTime);
  const tag = buildSessionTag(render.sessionName, agent?.sessionId ?? null);
  const label = taskLabel(render);
  const dispatch = render.flavour === 'dispatch';

  switch (verdict.kind) {
    case 'suspended': {
      if (!statusMsg) return;
      const parts = [
        verdict.childThreads > 0 ? `${verdict.childThreads} child thread(s)` : null,
        verdict.childTasks > 0 ? `${verdict.childTasks} child task(s)` : null,
      ].filter(Boolean);
      await writeTaskStatus(
        adapter, statusMsg,
        `${Icons.processing} ${label} | suspended — waiting on ${parts.join(' + ') || 'children'}`,
      );
      return;
    }
    case 'paused': {
      if (!statusMsg) return;
      await writeTaskStatus(adapter, statusMsg, dispatch
        ? `${Icons.warning} ${label} | paused — rate limited, will auto-resume`
        : `${Icons.warning} ${tag}Paused — rate limited, will auto-resume (${elapsedStr})`);
      return;
    }
    case 'aborted': {
      if (!statusMsg) return;
      await sealTaskStatus(adapter, statusMsg, verdict.blockError
        ? `${Icons.error} ${label} | worker aborted but block failed: ${verdict.blockError}`
        : `${Icons.stopped} ${label} | ${verdict.note}`);
      return;
    }
    case 'split': {
      if (!statusMsg) return;
      await sealTaskStatus(adapter, statusMsg, verdict.error
        ? `${Icons.error} ${label} | [SPLIT] proposal invalid: ${verdict.error} — task unclaimed`
        : `🌿 ${label} | ${verdict.note}`);
      return;
    }
    case 'exhausted': {
      if (!statusMsg) return;
      const lead = dispatch ? `${label} | ` : '';
      await sealTaskStatus(
        adapter, statusMsg,
        `${Icons.warning} ${lead}${tag}Rate limited — all fallbacks exhausted (${elapsedStr})`,
      );
      return;
    }
    case 'done': {
      if (!statusMsg) return;
      const metrics = formatMetricsSuffix({
        costUsd: target.result?.totalCostUsd ?? null,
        numTurns: target.result?.totalNumTurns ?? null,
      });
      const prefix = dispatch ? `Done: ${label}` : 'Done';
      await sealTaskStatus(adapter, statusMsg, `${Icons.ok} ${prefix} | ${tag}(${elapsedStr}${metrics})`);
      return;
    }
    case 'error': {
      if (dispatch) return; // see the doc above — the job posts the project notice itself.
      if (statusMsg) {
        await sealTaskStatus(
          adapter, statusMsg,
          `${Icons.error} ${buildSessionTag(render.sessionName, null)}Error (${elapsedStr})`,
        );
      }
      try {
        await postTaskNotice(adapter, target.destination, `Scheduled task error: ${verdict.message}`);
      } catch { /* the run is over; a failed notice must not escape */ }
      return;
    }
  }
}
