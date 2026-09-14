// input:  ScheduleTarget + lookup callbacks (session/thread stores)
// output: planScheduledDispatch — pure decision tree picking how to land a fired schedule
// pos:    extracted from scheduled-task.ts so the target dispatch is unit-testable
//         without spinning up the platform adapter, execution registry, or thread runner.
//         Removed channel variant in M4; project replaces it as the default target kind.

import type { ScheduleTarget, ScheduleTask } from '@store/schedule-repo.js';
import type { ThreadRecord } from '@core/types/thread-types.js';

/** What scheduled-task.ts should do at fire time. Each kind maps to one runtime branch:
 *  - fresh → createThread('scheduler') + runThreadExec (fresh scheduler session)
 *  - continue-thread → continueThread (resumes the existing thread's slot session)
 *  - skip → record lastSkipped, post a one-line Slack note, do not run.
 */
export type DispatchPlan =
  | { kind: 'fresh'; channel: string }
  | { kind: 'continue-thread'; channel: string; threadId: string }
  | { kind: 'skip'; reason: string };

export interface DispatchLookups {
  /** Look up a thread record by id. Null if missing. */
  getThread(threadId: string): ThreadRecord | null;
}

export interface DispatchPlanInput {
  target: ScheduleTarget | undefined;
  fallback: ScheduleTask['fallback'];
  /** Channel to use when falling back to fresh — typically the schedule's own resolved channel. */
  fallbackChannel: string;
  lookups: DispatchLookups;
}

function applyFallback(input: DispatchPlanInput, reason: string): DispatchPlan {
  const policy = input.fallback ?? 'fresh';
  if (policy === 'skip') return { kind: 'skip', reason };
  // 'wait' falls through to fresh too — the timer-level wait/retry isn't the planner's job;
  // see scheduled-task.ts for the future "wait" implementation that re-arms a short-delay timer.
  return { kind: 'fresh', channel: input.fallbackChannel };
}

export async function planScheduledDispatch(input: DispatchPlanInput): Promise<DispatchPlan> {
  const target = input.target ?? { kind: 'fresh' };

  if (target.kind === 'fresh') {
    return { kind: 'fresh', channel: input.fallbackChannel };
  }

  if (target.kind === 'project') {
    // Always spawn a fresh session in the project channel.
    // The scheduler resolves projectId → channel before calling runScheduledTask.
    return { kind: 'fresh', channel: input.fallbackChannel };
  }

  if (target.kind === 'thread') {
    const thread = input.lookups.getThread(target.threadId);
    if (!thread) {
      return applyFallback(input, `thread ${target.threadId} no longer exists`);
    }
    if (thread.status !== 'running' && thread.status !== 'waiting') {
      return applyFallback(input, `thread ${target.threadId} is ${thread.status}`);
    }
    return { kind: 'continue-thread', channel: thread.channel, threadId: target.threadId };
  }

  // Exhaustive check — TS will flag if a new ScheduleTarget kind is added.
  const _exhaustive: never = target;
  void _exhaustive;
  return { kind: 'fresh', channel: input.fallbackChannel };
}
