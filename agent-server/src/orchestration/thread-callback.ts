// input:  thread store, task generations, runner, outbound queue
// output: fenced callbacks, resumes, rotation, waiting sweeps
// pos:    Delivers child results and resumes suspended parents
// >>> If I am updated, update my header comment and parent CORTEX.md <<<

import { threadStore } from '@store/thread-repo.js';
import { agentRunner } from './agent-runner.js';
import { getOutboundQueue, durablePost } from '@store/outbound-queue.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { resumeThread } from '@domain/threads/runner.js';
import { sealThreadStatus } from './status-helpers.js';
import { isTerminalStatus } from '@domain/threads/tree.js';
import { runThreadDetached } from './thread-executor.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import {
  scanAllTasks, type Task, type TaskGenerationExpectation,
} from '@core/task-parser.js';
import { recordDelivered, pendingDeliveries } from '@domain/tasks/acceptance-ledger.js';
import { withTaskFileMutationLockAsync } from '@domain/tasks/system/task-lifecycle-edit.js';
import { isTaskArtifactTemplate } from '@domain/threads/index.js';
import type { ThreadRecord, RunThreadOptions } from '@core/types/thread-types.js';
import type { PlatformAdapter } from '@platform/index.js';
import type { IncomingMessage, Destination } from '@platform/index.js';
import { SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';

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

/** Compose a short, agent-actionable completion notice from the final thread record. */
function buildNotice(threadId: string): string {
  const t = threadStore.get(threadId)!;
  const cost = `$${(t.totalCostUsd || 0).toFixed(4)}`;
  const last = t.steps.length ? t.steps[t.steps.length - 1].output : null;
  const tail = t.abortReason || t.error || last || '(no output)';
  const summary = tail.length > 200 ? tail.slice(0, 200) + '…' : tail;
  const label = t.templateName || t.activeAgent || 'thread';
  return `[Background thread done] Your thread ${threadId} (${label}) status=${t.status} | ${cost}\nSummary: ${summary}\nCall thread_result("${threadId}") to see the full output.`;
}

/** Child-result notice delivered into a suspended parent's pendingMessages. Echoes the
 *  delegation contract and demands acceptance verification before the result is trusted
 *  (DR-0014 L1 纠偏: verify the deliverable, never the child's self-report). */
export function buildChildResultNotice(child: ThreadRecord): string {
  const cost = `$${(child.totalCostUsd || 0).toFixed(4)}`;
  const label = child.templateName || child.activeAgent || 'thread';
  const contract = child.metadata?.contract;
  const lines = [
    `[Child thread done] ${child.id} (${label}) status=${child.status} | ${cost}`,
  ];
  if (child.abortReason) lines.push(`Child escalation/abort reason: ${child.abortReason}`);
  if (child.error) lines.push(`Child error: ${child.error}`);
  if (contract) {
    lines.push(`Contract: ${contract.goal}`);
    if (contract.doneWhen) lines.push(`Done when: ${contract.doneWhen}`);
    if (contract.deliverablePath) lines.push(`Deliverable: ${contract.deliverablePath}`);
  }
  lines.push(`Full output: thread_result("${child.id}")${child.artifactPath ? `; artifact: ${child.artifactPath}` : ''}`);
  lines.push('');
  lines.push('Acceptance (mandatory — do NOT trust the child\'s self-reported summary):');
  lines.push('1. Read the actual deliverable; check it against done_when item by item; for code, run the tests.');
  lines.push('2. Passes → distill the key conclusions into your artifact and continue your plan.');
  lines.push('3. Fails → write out the expected/actual gap and your failure hypothesis; if CORTEX_TASK_ID is set, use the Write tool to stage child JSON at a per-task unique path, run cortex-task spawn --task-file <path>, and call thread_wait; otherwise call thread_abort.');
  lines.push('4. Cannot judge, or a directional question → call the thread_abort tool (with a one-line diagnosis) to escalate to your manager.');
  return lines.join('\n');
}

/** Durable degraded-path notice to the project-report channel. */
async function postProjectNotice(t: ThreadRecord, text: string): Promise<void> {
  const adapter = jobCtx.adapter;
  if (!adapter) { log.error(`no adapter; cannot post notice for ${t.id}`); return; }
  const dest: Destination = { type: 'project-report', projectId: t.projectId, trigger: 'mcp-thread', sessionId: '' };
  const queue = getOutboundQueue();
  if (queue) {
    await durablePost(queue, adapter, dest, { text });
  } else {
    await adapter.postMessage(dest, { text });
  }
}

/** Rebuild run options for a suspended or provider-paused thread.
 *  Restore the persisted status message so resumed updates target the original message.
 *  Lifecycle hooks are resolved by the HookBus from the thread's persisted metadata. */
export function buildResumeOptions(parent: ThreadRecord): RunThreadOptions | null {
  const adapter = jobCtx.adapter;
  if (!adapter) return null;
  const m = parent.metadata;
  const dest: Destination = m?.resumeDest === 'interactive-reply'
    ? { type: 'interactive-reply', conduit: parent.channel, sessionId: '' }
    : { type: 'project-report', projectId: parent.projectId, trigger: m?.trigger || 'mcp-thread', sessionId: '' };
  return {
    adapter,
    channel: parent.channel,
    destination: dest,
    threadAnchorId: parent.platformThreadId ?? null,
    statusMsg: m?.statusMsgRef ?? null,
    startTime: Date.now(),
    onProgress: null,
    onToolUse: null,
  };
}

/** Refresh the status message persisted at suspension (metadata.statusMsgRef): a resumed
 *  thread's terminal summary, or the new suspension count if it suspended again. Without
 *  this, the dispatch/webhook status message reads "suspended — waiting on children"
 *  forever after the thread has finished (2026-06-11 verification finding). */
export async function sealSuspendedStatusMsg(threadId: string, adapter?: PlatformAdapter | null): Promise<void> {
  const t = threadStore.get(threadId);
  const ref = t?.metadata?.statusMsgRef;
  if (!t || !ref) return;
  const a = adapter ?? jobCtx.adapter;
  if (!a) return;
  const totalNumTurns = t.steps.reduce((acc, st) => acc + (st.numTurns || 0), 0);
  // Background seal: buildThreadSummary text, no interactive action blocks (no live user to click).
  await sealThreadStatus(a, ref, { thread: t, totalCostUsd: t.totalCostUsd, totalNumTurns, finalOutput: null, lastAgentResult: null, executionId: null })
    .catch((e) => log.warn(`seal status msg ${threadId}: ${(e as Error).message}`));
}

export type ResumeFn = (parentThreadId: string) => void;

const defaultResume: ResumeFn = (parentId) => {
  const parent = threadStore.get(parentId);
  if (!parent) { resuming.delete(parentId); return; }
  const opts = buildResumeOptions(parent);
  if (!opts) {
    resuming.delete(parentId);
    log.error(`cannot resume suspended parent ${parentId}: no adapter`);
    return;
  }
  log.info(`resuming suspended parent ${parentId} (all awaited children terminal)`);
  runThreadDetached(parentId, opts, {
    run: (tid, o) => resumeThread(tid, o),
    onSettled: async (tid) => {
      resuming.delete(tid);
      // Refresh the suspension-era status message (terminal summary or new wait count).
      await sealSuspendedStatusMsg(tid).catch(() => {});
      // Cascade: when the resumed parent itself terminates (or suspends again and later
      // terminates), its own parent gets notified through the same callback chain.
      await fireThreadCallback(tid).catch((e) => log.error(`cascade callback ${tid}: ${(e as Error).message}`));
      // A resumed manager IS itself a dispatched task; its completion must publish task.completed
      // so ITS parent (the grandparent waiting on this task) wakes — the dispatch cycle that would
      // have published it is bypassed on the resume path.
      await closeResumedTaskLoop(tid).catch((e) => log.error(`close task loop ${tid}: ${(e as Error).message}`));
    },
  });
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

/** Configured steps per manager session before rotation. */
function rotateStepsThreshold(): number {
  return getSettings().managerRotateSteps;
}

/** Rehydration notice for a freshly rotated manager incarnation: durable artifact first,
 *  tree reconcile second, ledger-pending acceptances third. Mirrors the disaster-join
 *  path — rotation IS a deliberate kill test (DR-0017 D1/D2). */
export function buildRehydrationNotice(parent: ThreadRecord, stepsSinceRotation: number): string {
  const m = parent.metadata;
  const project = m?.taskProject || parent.projectId;
  const lines = [
    `[Manager rotation — DR-0017] You are a FRESH incarnation of this composite task node's manager. Your predecessor's session was retired after ${stepsSinceRotation} steps (context hygiene). No work is lost — the durable state lives on the task node:`,
    `1. Read your artifact FIRST — it holds the predecessor's checkpoint (seam map, delegations & acceptance criteria, decisions made, remaining plan, assumptions): ${parent.artifactPath}`,
    m?.taskId
      ? `2. Reconcile the tree: cortex-task tree --task-id ${m.taskId} (cross-check child states against the checkpoint).`
      : '2. Reconcile your child tasks against the checkpoint.',
  ];
  if (m?.taskId && project) {
    try {
      const pend = pendingDeliveries(project, m.taskId);
      if (pend.length > 0) {
        lines.push(`3. Deliveries still awaiting YOUR acceptance verdict (acceptance ledger): ${pend.map((e) => `#${e.child} (${e.kind}${e.rework_round ? `, rework round ${e.rework_round}` : ''})`).join(', ')} — verify each against its done_when before trusting it.`);
      }
    } catch { /* ledger unreadable — the tree reconcile above covers it */ }
  }
  lines.push('Do NOT redo completed work and do NOT re-litigate decisions recorded in the artifact — continue from the remaining plan.');
  return lines.join('\n');
}

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

/** Pure: decide whether EVERY remaining awaited task is stuck behind a blocked dependency.
 *  A task is stuck iff some transitive depends_on chain reaches a currently blocked task
 *  (deps are AND-ed: one blocked dependency pins the task forever until someone acts).
 *  Returns null — no deadlock — as soon as any awaited task has a way forward: it is
 *  done/blocked itself (delivery owns it), claimed or pending (in flight), missing
 *  (reconcile owns it), or has no blocked dependency (dispatchable eventually).
 *  The key identifies the stall for the once-per-distinct-stall wake dedup. */
export function computeStuckWaitSet(tasks: Task[], waitingIds: string[]): { stuck: string[]; blockers: string[]; key: string } | null {
  if (!waitingIds.length) return null;
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const blockers = new Set<string>();

  const blockedBehind = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false; // dependency cycle — no blocked task found on this path
    seen.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      const d = byId.get(dep);
      if (!d || d.status === 'done') continue; // missing dep out of scope; done dep is met
      if (d.blocked_by) { blockers.add(dep); return true; }
      if (blockedBehind(dep, seen)) return true;
    }
    return false;
  };

  const stuck: string[] = [];
  for (const id of waitingIds) {
    const task = byId.get(id);
    if (!task) return null;                                   // missing → reconcile owns it
    if (task.status === 'done' || task.blocked_by) return null; // terminal → delivery imminent
    if (task.claimed_by || task.status === 'pending') return null; // in flight → progress possible
    if (!blockedBehind(id, new Set())) return null;           // has a live path forward
    stuck.push(id);
  }
  const stuckSorted = [...stuck].sort();
  const blockersSorted = [...blockers].sort();
  return { stuck: stuckSorted, blockers: blockersSorted, key: `stuck=${stuckSorted.join(',')}|blockers=${blockersSorted.join(',')}` };
}

/** Deadlock notice delivered into the woken manager's pendingMessages: names the stuck
 *  tasks and their blockers, and demands action (mirrors the blocked-escalation notice). */
export function buildDeadlockNotice(stuck: string[], blockers: string[]): string {
  return [
    `[Wait-set deadlocked] Your remaining awaited subtask(s) ${stuck.map((s) => `#${s}`).join(', ')} can never start: they depend (directly or transitively) on blocked task(s) ${blockers.map((b) => `#${b}`).join(', ')}.`,
    '',
    'No event will ever wake you for these — you must act:',
    '1. Diagnose the blocked task(s): read their blocked_by and outputs (cortex-task show / tree).',
    '2. Fixable → cortex-task unblock and revise, or rebuild the subtasks (decompose --keep-parent), then call thread_wait.',
    '3. Beyond your authority or a directional question → call the thread_abort tool (with a one-line diagnosis) to escalate.',
  ].join('\n');
}

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

const SAFE_TASK_CHILD_CREATION = 'For verifier or replacement children, use the Write tool to stage JSON at a per-task unique path, then run cortex-task spawn --task-file <path>; never place task prose in shell arguments.';

/** Child-task result notice delivered into a suspended manager's pendingMessages.
 *  completed → acceptance instructions (verify the deliverable, never the report);
 *  blocked → escalation instructions (the child cannot finish on its own). */
export function buildTaskResultNotice(task: Task, kind: 'completed' | 'blocked'): string {
  const lines: string[] = [];
  if (kind === 'completed') {
    lines.push(`[Subtask done] #${task.id} ${task.text}`);
    if (task.done_when) lines.push(`Done when: ${task.done_when}`);
    if (task.completed_note) lines.push(`Completion note: ${task.completed_note}`);
    lines.push('');
    lines.push('Acceptance (mandatory — do NOT trust the completion note at face value):');
    lines.push('1. Read the actual output (code/docs/experiment records); check it against done_when item by item; for code, run the tests.');
    lines.push('2. Passes → distill the key conclusions into your artifact and continue your plan.');
    lines.push(`3. Fails → cortex-task uncomplete then revise the task, or add a revision subtask with decompose --keep-parent, then call thread_wait.`);
    lines.push('4. Directional question → call the thread_abort tool (with a one-line diagnosis) to escalate.');
  } else {
    lines.push(`[Subtask blocked — escalation signal] #${task.id} ${task.text}`);
    lines.push(`Blocked by: ${task.blocked_by || '(unrecorded)'}`);
    lines.push('');
    lines.push('This is the subtask escalating: it cannot finish on its own. You must handle it:');
    lines.push('1. Diagnose the cause (read its output/logs; a too-big cause = your original decomposition needs revising).');
    lines.push('2. Fixable → cortex-task unblock and revise the task description/done_when, or rebuild a revised subtask (decompose --keep-parent), then call thread_wait.');
    lines.push('3. Beyond your authority or a directional question → call the thread_abort tool (with a one-line diagnosis) to escalate upward.');
  }
  lines.push('', SAFE_TASK_CHILD_CREATION);
  return lines.join('\n');
}

/** Disk-fresh read of one task (zero-dependency core parser — consistent with the
 *  suspension snapshot, immune to taskStore cache staleness). */
function readTaskFromDisk(project: string, taskId: string): Task | null {
  try {
    return scanAllTasks(project).find((t) => t.id === taskId) ?? null;
  } catch {
    return null;
  }
}

function matchesTaskGeneration(
  task: Task, ownership: TaskGenerationExpectation | undefined,
): boolean {
  return !ownership || task.dispatch_generation === ownership.generation
    || (task.status === 'done' && task.dispatch_generation === null);
}

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
    const deliverable = await recordDelivered(parentProject, parentTaskId, task.id, kind)
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

/** Wake (or create) the session on a channel by routing a synthetic user message — the same
 *  mechanism the interactive thread-parent path uses. Shared by thread completion (fireThreadCallback),
 *  task completion (notifyTaskOriginSession), and top-of-tree ask_manager escalation (manager-qa).
 *  agentRunner.route find-or-creates the channel's session, so this works whether or not a live
 *  session still exists. */
/** Message shape wakeSession routes. Exported so the guard side (agent-runner's human-backstop
 *  skip) and tests can stay in sync with the exact synthetic shape by construction. */
export function buildSyntheticWakeMessage(channel: string, notice: string, tag: string): IncomingMessage {
  return {
    ref: { conduit: channel, messageId: `cb_${tag}_${Date.now()}` },
    text: notice,
    senderId: SYNTHETIC_CALLBACK_SENDER,
    isBot: false,
    kind: 'user',
    raw: { source: 'task-callback', tag },
  };
}

export async function wakeSession(channel: string, notice: string, tag: string): Promise<void> {
  const adapter = jobCtx.adapter;
  if (!adapter) { log.error(`no adapter; cannot wake session on ${channel} (${tag})`); return; }
  const message = buildSyntheticWakeMessage(channel, notice, tag);
  log.info(`waking session on ${channel} for ${tag}`);
  await agentRunner.route({
    message, channel, adapter, threadAnchorId: null, hasFiles: false, userMessage: notice, agentMessage: notice,
  });
}

/** Origin-session notice: a task created by an interactive session/agent finished — concise,
 *  no manager-style verification ceremony (the recipient is the requester, not a join node). */
function buildTaskOriginNotice(task: Task, kind: 'completed' | 'blocked'): string {
  if (kind === 'completed') {
    const note = task.completed_note ? `\nNote: ${task.completed_note}` : '';
    return `<system-reminder>\n[Task done] The task you dispatched #${task.id} (${task.project}) "${task.text}" is complete.${note}\nRun cortex-task show --task-id ${task.id} for details.\n</system-reminder>`;
  }
  return `[Task blocked] The task you dispatched #${task.id} (${task.project}) "${task.text}" is blocked.\nBlocked by: ${task.blocked_by || '(unrecorded)'}\nRun cortex-task show --task-id ${task.id} for details; once handled, cortex-task unblock.`;
}

/** Session→task wake (Problem 1): when a task created by an interactive session/agent turns
 *  terminal, route a notice back to its origin channel. Default-on, no fallback — if origin_channel
 *  is set we always wake it. Mutually exclusive with the thread-parent path: if any thread is
 *  currently waiting on this task (waitingOnTasks), that path owns the result and we defer.
 *  `wake` is injectable for testing (mirrors the `resume` injection on notifyTaskParentThreads). */
export async function notifyTaskOriginSession(
  taskId: string, kind: 'completed' | 'blocked', deps: { wake?: WakeFn } = {},
  ownership?: TaskGenerationExpectation,
): Promise<void> {
  for (const t of threadStore.getAll()) {
    if (t.status === 'waiting' && t.metadata?.waitingOnTasks?.includes(taskId)) return;
  }
  const key = `task_${taskId}_${kind}`;
  if (fired.has(key)) return;
  const located = scanAllTasks().find((task) => task.id === taskId);
  if (!located?.origin_channel) return;
  const delivery = await withTaskFileMutationLockAsync(located.project, async () => {
    const task = readTaskFromDisk(located.project, taskId);
    if (!task?.origin_channel) return null;
    if (kind === 'completed' && task.status !== 'done') return null;
    if (kind === 'completed' && !matchesTaskGeneration(task, ownership)) return null;
    if (kind === 'blocked' && !task.blocked_by) return null;
    if (kind === 'blocked' && !matchesTaskGeneration(task, ownership)) return null;
    fired.add(key);
    return { channel: task.origin_channel, notice: buildTaskOriginNotice(task, kind) };
  });
  if (!delivery) return;
  const wake = deps.wake ?? ((ch, n) => wakeSession(ch, n, `task_${taskId}`));
  await wake(delivery.channel, delivery.notice);
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
  const publish = deps.publish ?? ((e) => jobCtx.bus?.publish(e));
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
    if (t.status !== 'waiting' || !t.metadata?.waitingOnTasks?.length) continue;
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
    if (!m?.waitingOn?.length && !m?.childThreadIds?.length && !m?.waitingOnTasks?.length) continue; // legacy waiting — not ours
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
    await wakeSession(m.parentChannel, notice, `thr_${threadId}`);
    return;
  }

  // No channel → durable notice to the project-report channel.
  await postProjectNotice(t, notice);
}
