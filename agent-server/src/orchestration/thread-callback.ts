import { threadStore } from '@store/thread-repo.js';
import { orchestrationAdapter } from './runtime.js';
import { isTerminalStatus } from '@domain/threads/tree.js';
import { openThreadRunDetached, type ThreadRunInput } from './thread-run/index.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import {
  scanAllTasks, type Task, type TaskGenerationExpectation,
} from '@core/task-parser.js';
import { recordDelivered } from '@domain/tasks/acceptance-ledger.js';
import { withTaskFileMutationLockAsync } from '@domain/tasks/system/task-lifecycle-edit.js';
import { isTaskArtifactTemplate } from '@domain/threads/index.js';
import {
  buildNotice, buildChildResultNotice, buildTaskResultNotice, buildTaskOriginNotice,
  buildThreadOriginTaskNotice, buildRehydrationNotice, buildDeadlockNotice, computeStuckWaitSet,
  rotateStepsThreshold, matchesTaskGeneration, readTaskFromDisk, hasTaskWaitState,
} from './thread-notices.js';
import {
  wakeSession, postProjectNotice, postProjectNoticeTo, closeResumedTaskLoop,
} from './thread-delivery.js';
import type { ThreadRecord } from '@core/types/thread-types.js';
import type { Destination } from '@platform/index.js';

// The wake/settle protocol's leaves live next door (T3.1): notice text + read-only predicates in
// thread-notices, terminal delivery edges in thread-delivery. Re-exported here so every existing
// importer of this module keeps working — this file stays the protocol's single public face.
export {
  buildChildResultNotice, buildTaskResultNotice, buildThreadOriginTaskNotice,
  buildRehydrationNotice, buildDeadlockNotice, computeStuckWaitSet,
} from './thread-notices.js';
export { wakeSession, closeResumedTaskLoop } from './thread-delivery.js';

const log = createLogger('thread-callback');

// Single-fire guard for the interactive-parent wake path (in-memory; resets on restart —
// acceptable there because waking a chat session twice is merely noisy). The thread-parent
// path does NOT use this set: its idempotency is persistent, via metadata.deliveredChildResults.
const fired = new Set<string>();
// Parents with a resume already in flight (guards the gap between scheduling the detached
// resume and resumeThread flipping status to 'running').
const resuming = new Set<string>();

/** Test hook: clear in-memory dedup state to simulate a server restart. */
export function _testResetCallbackState(): void {
  fired.clear();
  resuming.clear();
}

/** The ThreadRunInput for re-entering a suspended (`resume`) or provider-paused
 *  (`resume-rate-limited`) thread. Everything the surface needs was persisted at suspension:
 *  `resumeDest` says where output goes, `statusMsgRef` is the live status message so the resumed
 *  run refreshes the original message instead of posting a new one. Null when there is no adapter.
 *  Lifecycle hooks are resolved by the HookBus from the thread's persisted metadata. */
export function resumeThreadRunInput(parent: ThreadRecord, mode: 'resume' | 'resume-rate-limited'): ThreadRunInput | null {
  const adapter = orchestrationAdapter();
  if (!adapter) return null;
  const m = parent.metadata;
  const dest: Destination = m?.resumeDest === 'interactive-reply'
    ? { type: 'interactive-reply', conduit: parent.channel, sessionId: '' }
    : { type: 'project-report', projectId: parent.projectId, trigger: m?.trigger || 'mcp-thread', sessionId: '' };
  return {
    threadId: parent.id,
    mode: { kind: mode },
    channel: parent.channel,
    adapter,
    destination: dest,
    threadAnchorId: parent.platformThreadId ?? null,
    claimPlatformThread: false,
    statusMessage: m?.statusMsgRef ?? null,
    // No buttons: the resumed run refreshes a message whose interactive era is over.
    render: { kind: 'summary', blocks: null, startText: null },
    // A resumed thread has no live user to capture plan/ask dialogs for.
    interactive: false,
    settle: settleThread,
  };
}

/** The one place a finished thread wakes whatever was waiting on it: its parent thread / session
 *  (fireThreadCallback) and, when it was itself a dispatched task, the task loop its manager is
 *  suspended on (closeResumedTaskLoop — a no-op for every non-dispatch thread, so the pair is
 *  always safe to call). Injected into `ThreadRun` as `settle` rather than imported by it: this
 *  module imports `openThreadRunDetached`, so the reverse edge would close a cycle. */
export async function settleThread(threadId: string): Promise<void> {
  await fireThreadCallback(threadId).catch((e) => log.error(`cascade callback ${threadId}: ${(e as Error).message}`));
  // A resume-path worker bypasses the dispatch cycle, which is the only place
  // task.completed/task.blocked is published — re-emit it here so a manager/session waiting on
  // this task is woken (2026-06-29 finding: resumed leaf task left its manager suspended).
  await closeResumedTaskLoop(threadId).catch((e) => log.error(`close task loop ${threadId}: ${(e as Error).message}`));
}

export type ResumeFn = (parentThreadId: string) => void;

const defaultResume: ResumeFn = (parentId) => {
  const parent = threadStore.get(parentId);
  if (!parent) { resuming.delete(parentId); return; }
  const input = resumeThreadRunInput(parent, 'resume');
  if (!input) {
    resuming.delete(parentId);
    log.error(`cannot resume suspended parent ${parentId}: no adapter`);
    return;
  }
  log.info(`resuming suspended parent ${parentId} (all awaited children terminal)`);
  // The status refresh and the cascade (its own parent, its own task loop) are ThreadRun's:
  // `settle` is wired in resumeThreadRunInput. Only the in-flight guard is ours to drop — and it
  // must drop BEFORE the cascade runs: settleThread → fireThreadCallback → reconcileWaitingTasks
  // may find this very thread re-suspended on tasks that are already done and resume it again at
  // once, which `maybeResumeParent`'s `resuming.has()` check would otherwise refuse until the
  // periodic sweep. The onSettled delete is the net for a run that never reached settle.
  openThreadRunDetached(
    { ...input, settle: async (tid) => { resuming.delete(tid); await settleThread(tid); } },
    (tid) => { resuming.delete(tid); },
  );
};

/** Resume a suspended manager thread to answer a subtask's question (ask_manager / DR-0016).
 *  Unlike maybeResumeParent, this does NOT require the manager's child sets to be empty — the
 *  manager is woken to answer, not because its children finished. It answers via answer_subtask,
 *  whose handler sets pendingControl='wait', so the manager re-suspends on its still-live children
 *  at the next step boundary. Shares the `resuming` guard so it never collides with a concurrent
 *  completion-driven resume (whichever wins, the question + any child results both sit in
 *  pendingMessages). No-op unless the manager is currently 'waiting'. */
export function resumeManagerForQuestion(managerThreadId: string, resume?: ResumeFn): void {
  if (resuming.has(managerThreadId)) return;
  const mgr = threadStore.get(managerThreadId);
  if (!mgr || mgr.status !== 'waiting') return;
  resuming.add(managerThreadId);
  log.info(`resuming manager ${managerThreadId} to answer a subtask question`);
  (resume ?? defaultResume)(managerThreadId);
}

// --- Manager session rotation (DR-0017 W3) ---

/** Rotate an over-threshold manager session before re-entry: retire the persisted session
 *  (clear every slot's sessionId → the next step runs on a FRESH session and gets the full
 *  directive + contract prompt), reset the step base, and queue the rehydration notice.
 *  Only task-artifact (manager) templates rotate; everything uncertain fails open (no
 *  rotation). Returns true iff a rotation happened. */
export async function maybeRotateManager(threadId: string): Promise<boolean> {
  const parent = threadStore.get(threadId);
  if (!parent) return false;
  if (!isTaskArtifactTemplate(parent.templateName)) return false;
  const base = parent.metadata?.rotationBaseStepIndex ?? 0;
  const since = parent.steps.length - base;
  const threshold = rotateStepsThreshold();
  if (since < threshold) return false;
  const notice = buildRehydrationNotice(parent, since);
  await threadStore.mutate(threadId, (t) => {
    // Clear BOTH ids (track/backend decoupling): backendSessionId is the actual --resume
    // target now — leaving it would defeat the rotation's fresh-session guarantee.
    for (const slot of Object.values(t.agents)) { slot.sessionId = null; slot.backendSessionId = null; }
    const m = (t.metadata ??= {});
    m.rotationBaseStepIndex = t.steps.length;
    if (!Array.isArray(m.pendingMessages)) m.pendingMessages = [];
    if (m.pendingMessages.length >= 10) m.pendingMessages.shift();
    m.pendingMessages.push(notice);
  });
  log.info(`rotated manager ${threadId}: fresh session after ${since} steps (threshold ${threshold})`);
  return true;
}

// --- Wait-set deadlock guard (2026-07-21) ---
// Wake-on-empty alone deadlocks: block does not cascade to dependents, so a manager waiting on
// siblings that depend on a blocked child waits on tasks that can never turn terminal — no event
// will ever empty its wait set. Detect that stall and wake the manager once to handle it.

/** Resume `parentId` if it is suspended with nothing left to wait on — both thread children
 *  (waitingOn) and task children (waitingOnTasks, DR-0014 §8) — OR if its remaining awaited
 *  tasks are ALL stuck behind blocked dependencies (deadlock guard above; woken once per
 *  distinct stall, dedup via the persisted metadata.stuckWakeKey).
 *  DR-0017 W3: an over-threshold manager is rotated to a fresh session just before
 *  re-entry (rotation failure is non-fatal — resume proceeds on the old session). */
async function maybeResumeParent(parentId: string, resume?: ResumeFn): Promise<void> {
  if (resuming.has(parentId)) return;
  const parent = threadStore.get(parentId);
  if (!parent || parent.status !== 'waiting') return;
  if (parent.metadata?.waitingOn?.length) return;
  resuming.add(parentId); // claim the slot before any await (concurrent deliveries race here)
  try {
    const waitingTasks = parent.metadata?.waitingOnTasks ?? [];
    if (waitingTasks.length) {
      const project = parent.metadata?.taskProject || parent.projectId;
      let stall: ReturnType<typeof computeStuckWaitSet> = null;
      try { stall = computeStuckWaitSet(scanAllTasks(project), waitingTasks); } catch { /* unreadable → keep waiting */ }
      if (!stall || parent.metadata?.stuckWakeKey === stall.key) { resuming.delete(parentId); return; }
      await threadStore.mutate(parentId, (t) => {
        const m = (t.metadata ??= {});
        m.stuckWakeKey = stall.key;
        if (!Array.isArray(m.pendingMessages)) m.pendingMessages = [];
        if (m.pendingMessages.length >= 10) m.pendingMessages.shift();
        m.pendingMessages.push(buildDeadlockNotice(stall.stuck, stall.blockers));
      });
      log.warn(`waiting manager ${parentId} deadlocked on ${stall.stuck.join(',')} (blocked: ${stall.blockers.join(',')}) — waking to handle`);
    } else if (parent.metadata?.stuckWakeKey) {
      // Normal resume — clear the stall marker so a future distinct stall can wake again.
      await threadStore.mutate(parentId, (t) => { if (t.metadata) t.metadata.stuckWakeKey = null; });
    }
  } catch (e) {
    resuming.delete(parentId);
    throw e;
  }
  await maybeRotateManager(parentId).catch((e) => log.warn(`rotation check ${parentId}: ${(e as Error).message}`));
  (resume ?? defaultResume)(parentId);
}

/** Deliver a terminal child's result to its thread parent: remove the child from waitingOn,
 *  queue the result notice into pendingMessages (persistent idempotency via
 *  deliveredChildResults), and resume the parent when nothing is left to wait on.
 *  Orphan children (parent purged or already terminal) degrade to a project-report notice. */
export async function notifyThreadParent(childId: string, deps: { resume?: ResumeFn } = {}): Promise<void> {
  const child = threadStore.get(childId);
  if (!child) return;
  const parentId = child.metadata?.parentThreadId;
  if (!parentId) return;

  const parent = threadStore.get(parentId);
  if (!parent || isTerminalStatus(parent.status)) {
    log.info(`orphan child ${childId}: parent ${parentId} ${parent ? parent.status : 'purged'} — degrading to project notice`);
    await postProjectNotice(child, buildNotice(childId));
    return;
  }

  let delivered = false;
  await threadStore.mutate(parentId, (t) => {
    const m = (t.metadata ??= {});
    const waiting = m.waitingOn ?? [];
    const idx = waiting.indexOf(childId);
    if (idx >= 0) {
      waiting.splice(idx, 1);
      m.waitingOn = waiting;
    }
    const alreadyDelivered = (m.deliveredChildResults ?? []).includes(childId);
    if (alreadyDelivered) return;
    delivered = true;
    (m.deliveredChildResults ??= []).push(childId);
    if (!Array.isArray(m.pendingMessages)) m.pendingMessages = [];
    if (m.pendingMessages.length >= 10) m.pendingMessages.shift();
    m.pendingMessages.push(buildChildResultNotice(child));
  });

  // Failure visibility (tree noise reduction trades per-node completion spam for this):
  // failed/aborted children additionally surface on the project-report channel.
  if (delivered && (child.status === 'failed' || child.status === 'aborted')) {
    await postProjectNotice(child, buildNotice(childId)).catch(() => {});
  }

  if (delivered) await maybeResumeParent(parentId, deps.resume);
}

// --- Task-children bridge (DR-0014 §8: resident manager waits on child TASKS) ---

/** Deliver one child-task result to one waiting manager thread. Returns true if delivered.
 *  Same-incarnation idempotency rides the persistent deliveredChildResults array (4-hex
 *  task ids cannot collide with thr_ thread ids). Cross-incarnation idempotency (DR-0017
 *  W1) rides the task-keyed acceptance ledger: an 'accepted' child never re-delivers,
 *  even to a fresh manager thread; a pending/rejected-then-reworked child re-delivers
 *  at-least-once per incarnation until a verdict is recorded — a result that reached a
 *  dead session is re-delivered, never lost. Ledger errors fail open (deliver anyway).
 *  Parents without task identity (thread_start-style) keep the legacy per-thread path. */
async function deliverTaskResult(parentThreadId: string, task: Task, kind: 'completed' | 'blocked', deps: { resume?: ResumeFn }): Promise<boolean> {
  const parent = threadStore.get(parentThreadId);
  const parentTaskId = parent?.metadata?.taskId;
  const parentProject = parent?.metadata?.taskProject || parent?.projectId;
  if (parentTaskId && parentProject) {
    const deliverable = await recordDelivered(
      parentProject, parentTaskId, task.id, kind, { parentThreadId },
    )
      .catch((e) => { log.warn(`acceptance-ledger record failed for ${parentTaskId}/${task.id}: ${(e as Error).message}`); return true; });
    if (!deliverable) {
      // Already accepted by a previous incarnation — drop from the wait set without re-queueing.
      await threadStore.mutate(parentThreadId, (t) => {
        const m = (t.metadata ??= {});
        m.waitingOnTasks = (m.waitingOnTasks ?? []).filter((id) => id !== task.id);
      });
      await maybeResumeParent(parentThreadId, deps.resume);
      return false;
    }
  }
  let delivered = false;
  await threadStore.mutate(parentThreadId, (t) => {
    const m = (t.metadata ??= {});
    const waiting = m.waitingOnTasks ?? [];
    const idx = waiting.indexOf(task.id);
    if (idx >= 0) {
      waiting.splice(idx, 1);
      m.waitingOnTasks = waiting;
    }
    if ((m.deliveredChildResults ?? []).includes(task.id)) return;
    delivered = true;
    (m.deliveredChildResults ??= []).push(task.id);
    if (!Array.isArray(m.pendingMessages)) m.pendingMessages = [];
    if (m.pendingMessages.length >= 10) m.pendingMessages.shift();
    m.pendingMessages.push(buildTaskResultNotice(task, kind));
  });
  if (delivered) await maybeResumeParent(parentThreadId, deps.resume);
  return delivered;
}

async function deliverCurrentTaskResult(
  parent: ThreadRecord, taskId: string, kind: 'completed' | 'blocked',
  deps: { resume?: ResumeFn }, ownership?: TaskGenerationExpectation,
): Promise<void> {
  const project = parent.metadata?.taskProject || parent.projectId;
  await withTaskFileMutationLockAsync(project, async () => {
    const task = readTaskFromDisk(project, taskId);
    if (!task) {
      log.warn(`task ${taskId} missing for waiting manager ${parent.id}`);
      return;
    }
    if (kind === 'completed' && task.status !== 'done') {
      log.info(`ignoring loose task.completed for ${taskId} (disk status=${task.status})`);
      return;
    }
    if (kind === 'completed' && !matchesTaskGeneration(task, ownership)) {
      log.info(`ignoring stale task.completed for ${taskId} (dispatch generation mismatch)`);
      return;
    }
    if (kind === 'blocked' && !task.blocked_by) return;
    if (kind === 'blocked' && !matchesTaskGeneration(task, ownership)) return;
    await deliverTaskResult(parent.id, task, kind, deps);
  });
}

/** Verify task provenance while holding its mutation lock, then wake waiting managers. */
export async function notifyTaskParentThreads(
  taskId: string, kind: 'completed' | 'blocked', deps: { resume?: ResumeFn } = {},
  ownership?: TaskGenerationExpectation,
): Promise<void> {
  for (const parent of threadStore.getAll()) {
    if (parent.status !== 'waiting') continue;
    if (!parent.metadata?.waitingOnTasks?.includes(taskId)) continue;
    await deliverCurrentTaskResult(parent, taskId, kind, deps, ownership);
  }
}

type WakeFn = (channel: string, notice: string) => void | Promise<void>;

type PostNoticeFn = (projectId: string, text: string) => void | Promise<void>;

/** Session→task wake (Problem 1): when a task created by an interactive session/agent turns
 *  terminal, route a notice back to its origin channel. Default-on, no fallback — if origin_channel
 *  is set we always wake it. Mutually exclusive with the thread-parent path: if any thread is
 *  currently waiting on this task (waitingOnTasks), that path owns the result and we defer.
 *  Thread-origin tasks (origin_thread_id set — fire-and-forget adds from inside a thread) never
 *  wake a session: the creating thread has likely ended, and its recorded channel is an
 *  unattended dispatch conduit; the result degrades to a durable project-report notice instead.
 *  origin_thread_id takes precedence over origin_channel so legacy tasks that captured both
 *  are fixed retroactively. `wake`/`postNotice` are injectable for testing (mirrors the
 *  `resume` injection on notifyTaskParentThreads). */
export async function notifyTaskOriginSession(
  taskId: string, kind: 'completed' | 'blocked', deps: { wake?: WakeFn; postNotice?: PostNoticeFn } = {},
  ownership?: TaskGenerationExpectation,
): Promise<void> {
  for (const t of threadStore.getAll()) {
    if (t.status === 'waiting' && t.metadata?.waitingOnTasks?.includes(taskId)) return;
  }
  const key = `task_${taskId}_${kind}`;
  if (fired.has(key)) return;
  const located = scanAllTasks().find((task) => task.id === taskId);
  if (!located?.origin_channel && !located?.origin_thread_id) return;
  const delivery = await withTaskFileMutationLockAsync(located.project, async () => {
    const task = readTaskFromDisk(located.project, taskId);
    if (!task || (!task.origin_channel && !task.origin_thread_id)) return null;
    if (kind === 'completed' && task.status !== 'done') return null;
    if (kind === 'completed' && !matchesTaskGeneration(task, ownership)) return null;
    if (kind === 'blocked' && !task.blocked_by) return null;
    if (kind === 'blocked' && !matchesTaskGeneration(task, ownership)) return null;
    fired.add(key);
    if (task.origin_thread_id) {
      return { channel: null, project: task.project, notice: buildThreadOriginTaskNotice(task, kind) };
    }
    return { channel: task.origin_channel!, project: task.project, notice: buildTaskOriginNotice(task, kind) };
  });
  if (!delivery) return;
  if (delivery.channel) {
    const wake = deps.wake ?? ((ch, n) => wakeSession(ch, n, `task_${taskId}`));
    await wake(delivery.channel, delivery.notice);
  } else {
    const post = deps.postNotice ?? ((p, n) => postProjectNoticeTo(p, 'task-origin', n));
    await post(delivery.project, delivery.notice);
  }
}

/** Sweep one waiting thread's waitingOnTasks against disk state: deliver already-done and
 *  already-blocked children, drop missing ones, keep open ones. Closes the race window
 *  where a child task turns terminal between the suspension snapshot and the waiting
 *  persist (its event fired before anyone was listening). Also the recovery path for task
 *  children — unlike thread children, open tasks survive restarts and stay awaited. */
export async function reconcileWaitingTasks(threadId: string, deps: { resume?: ResumeFn } = {}): Promise<void> {
  const thread = threadStore.get(threadId);
  if (!thread || thread.status !== 'waiting') return;
  const ids = [...(thread.metadata?.waitingOnTasks ?? [])];
  if (!ids.length) {
    await maybeResumeParent(threadId, deps.resume);
    return;
  }
  const project = thread.metadata?.taskProject || thread.projectId;
  for (const taskId of ids) {
    const task = readTaskFromDisk(project, taskId);
    if (!task) {
      await threadStore.mutate(threadId, (t) => {
        const m = t.metadata!;
        m.waitingOnTasks = (m.waitingOnTasks ?? []).filter((id) => id !== taskId);
        if (!Array.isArray(m.pendingMessages)) m.pendingMessages = [];
        m.pendingMessages.push(`[Subtask lost] #${taskId} is no longer in TASKS.yaml (likely archived or deleted); treating as failed.`);
      });
      log.warn(`reconcile: dropped missing task ${taskId} from waiting thread ${threadId}`);
    } else if (task.status === 'done') {
      await deliverTaskResult(threadId, task, 'completed', deps);
    } else if (task.blocked_by) {
      await deliverTaskResult(threadId, task, 'blocked', deps);
    }
    // open/pending and unblocked → keep waiting (tasks survive restarts).
  }
  await maybeResumeParent(threadId, deps.resume);
}

/** Periodic disk-driven backstop: reconcile EVERY suspended manager's task children against disk
 *  and resume any whose list has emptied. The two fast paths — the task.completed/task.blocked
 *  event (notifyTaskParentThreads) and closeResumedTaskLoop — can each miss a single delivery to a
 *  race: a resume-path settle that reads state a beat early, a loose event rejected before the disk
 *  flip with no re-publish, or a partial TASKS.yaml read mid-commit. Each miss strands a manager on
 *  a child that is ALREADY done/blocked on disk until the next restart (2026-06-29: even with
 *  closeResumedTaskLoop, manager 5afd's completion was never delivered to its parent e5be). This
 *  sweep is purely disk-driven and idempotent (deliveredChildResults dedupes), so it eventually
 *  wakes any such manager regardless of which fast path failed. Returns the number swept. */
export async function sweepWaitingManagers(deps: { resume?: ResumeFn } = {}): Promise<number> {
  let swept = 0;
  for (const t of threadStore.getAll()) {
    if (t.status !== 'waiting' || !hasTaskWaitState(t)) continue;
    swept++;
    await reconcileWaitingTasks(t.id, deps).catch((e) => log.error(`sweep reconcile ${t.id}: ${(e as Error).message}`));
  }
  return swept;
}

/** Schedule one sweep and re-arm only after it settles, using the latest cadence. */
function scheduleWaitingManagerSweep(intervalMs: number): void {
  const timer = setTimeout(async () => {
    await sweepWaitingManagers().catch((e) => log.error(`waiting-manager sweep: ${(e as Error).message}`));
    const nextIntervalMs = getSettings().waitingSweepMs;
    // Runtime zero stops re-arming until restart; startup zero never starts the loop.
    if (nextIntervalMs > 0) scheduleWaitingManagerSweep(nextIntervalMs);
  }, intervalMs);
  timer.unref?.();
}

/** Start the periodic waiting-manager sweep. No-op when the startup interval is disabled. */
export function startWaitingManagerSweep(): void {
  const intervalMs = getSettings().waitingSweepMs;
  if (intervalMs <= 0) return;
  scheduleWaitingManagerSweep(intervalMs);
}

/** Register the EventBus subscribers that wake suspended manager threads on child-task
 *  terminal events (DR-0014 §8). Call once at startup, before recoverWaitingThreads. */
export function registerTaskTreeSubscribers(bus: { subscribe: (type: any, fn: (e: any) => void) => unknown }): void {
  bus.subscribe('task.completed', (e: { taskId: string; dispatchGeneration?: string | null }) => {
    const ownership = Object.hasOwn(e, 'dispatchGeneration')
      ? { generation: e.dispatchGeneration ?? null }
      : undefined;
    void notifyTaskParentThreads(e.taskId, 'completed', {}, ownership)
      .catch((err) => log.error(`task.completed bridge: ${(err as Error).message}`));
    void notifyTaskOriginSession(e.taskId, 'completed', {}, ownership)
      .catch((err) => log.error(`task.completed origin-wake: ${(err as Error).message}`));
  });
  bus.subscribe('task.blocked', (e: { taskId: string; dispatchGeneration?: string | null }) => {
    const ownership = Object.hasOwn(e, 'dispatchGeneration')
      ? { generation: e.dispatchGeneration ?? null }
      : undefined;
    void notifyTaskParentThreads(e.taskId, 'blocked', {}, ownership)
      .catch((err) => log.error(`task.blocked bridge: ${(err as Error).message}`));
    void notifyTaskOriginSession(e.taskId, 'blocked', {}, ownership)
      .catch((err) => log.error(`task.blocked origin-wake: ${(err as Error).message}`));
  });
}

/** Startup recovery: re-deliver results that completed while the server was down.
 *  Idempotent — safe to call repeatedly. Thread children still marked waiting whose records
 *  are gone are treated as failed (the restart already failed all in-flight running threads,
 *  so every surviving child THREAD record is terminal by the time this runs). Task children
 *  are reconciled against disk — open ones stay awaited. Returns the number
 *  of suspended parents processed. */
export async function recoverWaitingThreads(deps: { resume?: ResumeFn } = {}): Promise<number> {
  let recovered = 0;
  for (const parent of threadStore.getAll()) {
    if (parent.status !== 'waiting') continue;
    const m = parent.metadata;
    const hasThreadWait = !!m?.waitingOn?.length || !!m?.childThreadIds?.length;
    if (!hasThreadWait && !hasTaskWaitState(parent)) continue; // legacy waiting — not ours
    recovered++;

    for (const childId of [...(m.waitingOn ?? [])]) {
      const child = threadStore.get(childId);
      if (!child) {
        await threadStore.mutate(parent.id, (t) => {
          const meta = t.metadata!;
          meta.waitingOn = (meta.waitingOn ?? []).filter((id) => id !== childId);
          if (!Array.isArray(meta.pendingMessages)) meta.pendingMessages = [];
          meta.pendingMessages.push(`[Child thread lost] the record for ${childId} no longer exists (likely cleaned up); treating as failed.`);
        });
        log.warn(`recover: dropped missing child ${childId} from waiting parent ${parent.id}`);
      } else if (isTerminalStatus(child.status)) {
        await notifyThreadParent(childId, deps);
      }
    }
    // Task children: reconcile against disk (already-done/blocked delivered, missing
    // dropped, open kept — tasks survive restarts). Ends with its own resume check, which
    // also covers the crash-after-last-delivery-before-resume window and the
    // missing-child branch above (neither resumes by itself).
    await reconcileWaitingTasks(parent.id, deps);
  }
  if (recovered > 0) log.info(`recovered ${recovered} suspended parent thread(s)`);
  return recovered;
}

/**
 * Fire the completion callback for an MCP-spawned thread once it is terminal.
 *  - Non-terminal statuses (e.g. a parent that suspended via thread_wait and returned
 *    from runThread in 'waiting') are ignored — suspension is not completion.
 *  - Interactive parent (no parentThreadId): wake the parent by routing a synthetic turn onto
 *    its channel via agentRunner.route.
 *  - Thread-agent parent (parentThreadId set): deliver into the parent thread's
 *    pendingMessages and resume it when its waitingOn empties (notifyThreadParent).
 * Threads not spawned via thread_start (no parentSessionId) are ignored.
 */
export async function fireThreadCallback(threadId: string): Promise<void> {
  const t = threadStore.get(threadId);
  if (!t) return;
  if (!isTerminalStatus(t.status)) {
    // Suspension is not completion — but it IS the moment to close the task-side race
    // window: a child task that turned terminal between the suspension snapshot and the
    // waiting persist fired its event before anyone was listening. Sweep disk state now.
    // (All detached run paths — webhook start, resume — settle through this callback.)
    if (t.status === 'waiting' && t.metadata?.waitingOnTasks?.length) {
      await reconcileWaitingTasks(threadId).catch((e) => log.error(`reconcile ${threadId}: ${(e as Error).message}`));
    }
    return;
  }
  const m = t.metadata;
  if (!m?.parentSessionId) return; // not agent-spawned → nobody to notify

  // Thread-agent parent → persistent-idempotent delivery into the parent thread.
  if (m.parentThreadId) {
    await notifyThreadParent(threadId);
    return;
  }

  // Interactive parent → wake its session (single-fire, in-memory guard).
  if (fired.has(threadId)) return;
  fired.add(threadId);
  const notice = buildNotice(threadId);

  if (m.parentChannel) {
    await wakeSession(m.parentChannel, notice, `thr_${threadId}`, 'thread-callback');
    return;
  }

  // No channel → durable notice to the project-report channel.
  await postProjectNotice(t, notice);
}
