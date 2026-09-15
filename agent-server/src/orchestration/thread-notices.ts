// input:  a thread record / task row, plus settings and the acceptance ledger — never a mutation
// output: the exact notice text a waiting manager, parent or origin session will read, plus the
//         read-only predicates and disk reads the wake protocol asks its questions with
// pos:    orchestration leaf, below thread-delivery and thread-callback. Everything here is pure
//         text construction or a read (settings / TASKS.yaml / ledger): no store writes, no
//         delivery. It must not import thread-callback — the wake/settle protocol is one strongly
//         connected component, so T3.1 split it by LAYER (peel the leaves off) rather than by
//         theme (which would close a cycle). Callers: thread-callback, thread-delivery.

import { threadStore } from '@store/thread-repo.js';
import { getSettings } from '@core/settings.js';
import {
  scanAllTasks, type Task, type TaskGenerationExpectation,
} from '@core/task-parser.js';
import { pendingDeliveries } from '@domain/tasks/acceptance-ledger.js';
import type { ThreadRecord } from '@core/types/thread-types.js';

/** Compose a short, agent-actionable completion notice from the final thread record. */
export function buildNotice(threadId: string): string {
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
  lines.push('4. Cannot judge, or a directional question → thread_abort.');
  return lines.join('\n');
}

/** Configured steps per manager session before rotation. */
export function rotateStepsThreshold(): number {
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
    '3. Beyond your authority or a directional question → thread_abort.',
  ].join('\n');
}

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
    lines.push('4. Directional question → thread_abort.');
  } else {
    lines.push(`[Subtask blocked — escalation signal] #${task.id} ${task.text}`);
    lines.push(`Blocked by: ${task.blocked_by || '(unrecorded)'}`);
    lines.push('');
    lines.push('This is the subtask escalating: it cannot finish on its own. You must handle it:');
    lines.push('1. Diagnose the cause (read its output/logs; a too-big cause = your original decomposition needs revising).');
    lines.push('2. Fixable → cortex-task unblock and revise the task description/done_when, or rebuild a revised subtask (decompose --keep-parent), then call thread_wait.');
    lines.push('3. Beyond your authority or a directional question → thread_abort.');
  }
  lines.push('', SAFE_TASK_CHILD_CREATION);
  return lines.join('\n');
}

/** Disk-fresh read of one task (zero-dependency core parser — consistent with the
 *  suspension snapshot, immune to taskStore cache staleness). */
export function readTaskFromDisk(project: string, taskId: string): Task | null {
  try {
    return scanAllTasks(project).find((t) => t.id === taskId) ?? null;
  } catch {
    return null;
  }
}

export function matchesTaskGeneration(
  task: Task, ownership: TaskGenerationExpectation | undefined,
): boolean {
  return !ownership || task.dispatch_generation === ownership.generation
    || (task.status === 'done' && task.dispatch_generation === null);
}

/** Origin-session notice: a task created by an interactive session/agent finished — concise,
 *  no manager-style verification ceremony (the recipient is the requester, not a join node). */
export function buildTaskOriginNotice(task: Task, kind: 'completed' | 'blocked'): string {
  if (kind === 'completed') {
    const note = task.completed_note ? `\nNote: ${task.completed_note}` : '';
    return `<system-reminder>\n[Task done] The task you dispatched #${task.id} (${task.project}) "${task.text}" is complete.${note}\nRun cortex-task show --task-id ${task.id} for details.\n</system-reminder>`;
  }
  return `[Task blocked] The task you dispatched #${task.id} (${task.project}) "${task.text}" is blocked.\nBlocked by: ${task.blocked_by || '(unrecorded)'}\nRun cortex-task show --task-id ${task.id} for details; once handled, cortex-task unblock.`;
}

/** Human-facing project-channel notice for a fire-and-forget task queued from inside a thread:
 *  the thread has (most likely) ended and never consumes the result, so nobody is woken —
 *  the outcome just surfaces in the project's report stream. */
export function buildThreadOriginTaskNotice(task: Task, kind: 'completed' | 'blocked'): string {
  const origin = `queued by thread ${task.origin_thread_id}`;
  if (kind === 'completed') {
    const note = task.completed_note ? `\nNote: ${task.completed_note}` : '';
    return `[Task done] #${task.id} (${task.project}) "${task.text}" — ${origin}.${note}\nRun cortex-task show --task-id ${task.id} for details.`;
  }
  return `[Task blocked] #${task.id} (${task.project}) "${task.text}" — ${origin}.\nBlocked by: ${task.blocked_by || '(unrecorded)'}\nRun cortex-task show --task-id ${task.id} for details; once handled, cortex-task unblock.`;
}

export function hasTaskWaitState(thread: ThreadRecord): boolean {
  const metadata = thread.metadata;
  return !!metadata?.taskId && Array.isArray(metadata.waitingOnTasks);
}
