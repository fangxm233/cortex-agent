// input:  a notice text plus where it goes (a project's report channel, a session's channel), or
//         a task-dispatch thread that just settled terminal
// output: the posted / delivered message, or the task-tree event that closes a resumed task loop
// pos:    orchestration leaf between thread-notices and thread-callback. These are the wake
//         protocol's terminal edges: they hand a notice to the outside world (adapter queue,
//         session gateway) or re-emit one event, and never call back into the protocol — so they
//         hold none of its dedup state and must not import thread-callback / thread-run /
//         thread-executor / webhook. Callers: thread-callback.

import { threadStore } from '@store/thread-repo.js';
import { deliverToSession, type DeliveryOrigin } from './session-gateway.js';
import { getOutboundQueue, durablePost } from '@store/outbound-queue.js';
import { orchestrationAdapter, orchestrationBus } from './runtime.js';
import { isTerminalStatus } from '@domain/threads/tree.js';
import { createLogger } from '@core/log.js';
import { readTaskFromDisk } from './thread-notices.js';
import type { ThreadRecord } from '@core/types/thread-types.js';
import type { Destination } from '@platform/index.js';

// Same tag as thread-callback's logger on purpose: these lines used to be emitted from there and
// operators grep for it.
const log = createLogger('thread-callback');

/** Durable notice to a project's report channel (falls back to a direct post without a queue). */
export async function postProjectNoticeTo(projectId: string, trigger: string, text: string): Promise<void> {
  const adapter = orchestrationAdapter();
  if (!adapter) { log.error(`no adapter; cannot post project notice for ${projectId}`); return; }
  const dest: Destination = { type: 'project-report', projectId, trigger, sessionId: '' };
  const queue = getOutboundQueue();
  if (queue) {
    await durablePost(queue, adapter, dest, { text });
  } else {
    await adapter.postMessage(dest, { text });
  }
}

/** Durable degraded-path notice to the project-report channel. */
export async function postProjectNotice(t: ThreadRecord, text: string): Promise<void> {
  await postProjectNoticeTo(t.projectId, 'mcp-thread', text);
}

/** The delivery origins a wake can carry — the chat hint names what woke the session. */
type WakeOrigin = Extract<DeliveryOrigin, 'task-callback' | 'thread-callback' | 'subtask-question'>;

/** Wake (or create) the session on a channel by delivering the notice as a user turn — the same
 *  mechanism the interactive thread-parent path uses. Shared by thread completion
 *  (fireThreadCallback) and task completion (notifyTaskOriginSession); top-of-tree ask_manager
 *  escalation (manager-qa) calls the gateway directly. `deliverToSession` → `agentRunner.route`
 *  find-or-creates the channel's session, so this works whether or not a live session still
 *  exists, and it is where the synthetic message shape now lives (session-gateway.ts). */
export async function wakeSession(
  channel: string, notice: string, tag: string,
  origin: WakeOrigin = 'task-callback',
): Promise<void> {
  log.info(`waking session on ${channel} for ${tag}`);
  await deliverToSession({ channel, text: notice, origin, tag });
}

/** After a resumed task-dispatch thread settles TERMINAL, publish the task-tree event that the
 *  dispatch cycle (task-dispatch.ts:281) would have published — but didn't, because the thread
 *  re-entered via a RESUME path (rate-limit resume in resume-dispatcher, OR the DR-0014
 *  child-completion resume in defaultResume) that bypasses the dispatch cycle entirely. The
 *  worker still marks its task done/blocked on disk, but without this nobody emits the event
 *  that wakes a manager/session waiting on that task — it stays suspended forever (2026-06-29
 *  finding: rate-limit-resumed leaf task ef14 left manager 5afd → e5be permanently stuck; the
 *  only accidental rescue was a later re-suspension's reconcile-on-suspend sweep). Mirrors the
 *  loose publish at task-dispatch.ts — every subscriber re-verifies disk state (notifyTaskParent
 *  rejects a not-actually-done task; deliveredChildResults dedupes), so a duplicate/stale publish
 *  is a safe no-op. No-op unless the thread is a TERMINAL task-dispatch thread whose task is
 *  done (→ task.completed) or blocked (→ task.blocked) on disk. */
export async function closeResumedTaskLoop(
  threadId: string,
  deps: { publish?: (e: { type: 'task.completed'; taskId: string; dispatchGeneration?: string | null } | { type: 'task.blocked'; taskId: string; reason: string; dispatchGeneration?: string | null }) => void } = {},
): Promise<void> {
  const t = threadStore.get(threadId);
  if (!t || !isTerminalStatus(t.status)) return; // suspension/rate-limit re-entry is not completion
  const m = t.metadata;
  if (m?.trigger !== 'task-dispatch' || !m?.taskId) return; // only dispatch threads close a task loop
  const task = readTaskFromDisk(m.taskProject || t.projectId, m.taskId);
  if (!task) return;
  const publish = deps.publish ?? ((e) => orchestrationBus()?.publish(e));
  if (task.status === 'done') {
    publish({
      type: 'task.completed', taskId: m.taskId,
      dispatchGeneration: m.dispatchGeneration ?? null,
    });
  } else if (task.blocked_by) {
    publish({
      type: 'task.blocked', taskId: m.taskId, reason: task.blocked_by,
      dispatchGeneration: m.dispatchGeneration ?? null,
    });
  }
}
