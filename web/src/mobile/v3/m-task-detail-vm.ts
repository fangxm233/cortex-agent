// input:  task/list DTOs, verification DTO, and canonical task detail facts
// output: Mobile read-only blocker, claim, dependency, field, and history projection
// pos:    Mobile-only projection over shared task detail semantics
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Maps tasks.list plus tasks.verification into a language-neutral detail model. Only fields backed
// by the DTO are surfaced; missing evidence remains null or empty for an honest view placeholder.
import type { TaskInfo, TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import {
  buildTaskDetailFacts,
  type TaskClaimFacts,
  type TaskDependencyFacts,
  type TaskDetailStatusKind,
  type TaskVerificationFacts,
} from '@/features/tasks/task-detail-facts';
import { fmtMoney } from '@/mobile/ui/format';

export type MTaskStatusKind = TaskDetailStatusKind;

/** Elapsed label from a real durationMs (language-neutral s/m/h units); null when no source. */
export function formatElapsed(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export interface MTaskDepVm {
  /** Real dependency task id. */
  id: string;
  /** `T-<id>` display form. */
  displayId: string;
  /** The dep's own derived status (from a tasks.list lookup); 'waiting' fallback when unknown. */
  statusKind: MTaskStatusKind;
  /** False when the dep id is absent from the list (cross-project / archived) — GAP, status unproven. */
  known: boolean;
}

export interface MTaskHistoryRowVm {
  /** Real dispatch start (raw ISO) — the View formats the relative label. */
  startedAt: string;
  type: TaskDispatchRecord['type'];
  status: TaskDispatchRecord['status'];
  /** True for the execution the evidence identified as the one that completed the task. */
  isCompleting: boolean;
}

export interface MTaskClaimVm {
  /** Real TaskInfo.template. */
  template: string;
  /** Owning task thread id, including the legacy thread-shaped claim-id fallback. */
  threadId: string | null;
  /** Safe non-dispatcher claim owner fallback when no owning thread is available. */
  claimedBy: string | null;
  /** `<elapsed> · <cost>` from the newest dispatch; parts with no source omitted; null when neither. */
  meta: string | null;
}

export interface MTaskDetailVm {
  found: boolean;
  /** `T-<id>` — real task id. */
  displayId: string;
  /** Real TaskInfo.text. */
  text: string;
  /** Persisted task status from TASKS.yaml. */
  status: TaskInfo['status'];
  /** Exact task template from TASKS.yaml. */
  template: string;
  statusKind: MTaskStatusKind;
  priority: TaskInfo['priority'];
  /** Approval gate; null when an older server omitted the field. */
  approvalNeeded: boolean | null;
  /** Recorded approval date; null when absent or omitted. */
  approvedAt: string | null;
  /** Raw `completed-at` ISO instant (the View formats it); null when never completed / omitted. */
  completedAt: string | null;
  /** Real TaskInfo.doneWhen; null → honest gap in the View. */
  doneWhen: string | null;
  /** Full blocker reason; null when the task is not blocked. */
  blockedBy: string | null;
  /** The claim-thread card model; null when the task is not claimed. */
  claim: MTaskClaimVm | null;
  /** dependsOn joined against the list; [] when none. */
  deps: MTaskDepVm[];
  /** Real dispatch history, newest first; [] when never dispatched. */
  history: MTaskHistoryRowVm[];
}

const NOT_FOUND: MTaskDetailVm = {
  found: false,
  displayId: '',
  text: '',
  status: 'open',
  template: '',
  statusKind: 'waiting',
  priority: 'medium',
  approvalNeeded: null,
  approvedAt: null,
  completedAt: null,
  doneWhen: null,
  blockedBy: null,
  claim: null,
  deps: [],
  history: [],
};

function buildClaim(
  task: TaskInfo,
  claim: TaskClaimFacts,
  verification: TaskVerificationFacts | null,
): MTaskClaimVm | null {
  if (!claim.claimed) return null;
  const newest = verification?.newestDispatch?.dispatch ?? null;
  const parts: string[] = [];
  const elapsed = formatElapsed(newest?.durationMs ?? null);
  if (elapsed) parts.push(elapsed);
  if (newest?.cost != null) parts.push(fmtMoney(newest.cost));
  return {
    template: task.template, threadId: claim.threadId, claimedBy: claim.id,
    meta: parts.length > 0 ? parts.join(' · ') : null,
  };
}

function buildDependencies(dependencies: TaskDependencyFacts[]): MTaskDepVm[] {
  return dependencies.map((dependency) => ({
    id: dependency.id,
    displayId: `T-${dependency.id}`,
    statusKind: dependency.statusKind ?? 'waiting',
    known: dependency.known,
  }));
}

function buildHistory(verification: TaskVerificationFacts | null): MTaskHistoryRowVm[] {
  return verification?.dispatches.map(({ dispatch, isCompleting }) => ({
    startedAt: dispatch.startedAt, type: dispatch.type, status: dispatch.status, isCompleting,
  })) ?? [];
}

export function buildTaskDetailVm(
  taskId: string,
  tasks: TaskInfo[],
  verification: TaskVerificationInfo | null,
  _now: number = Date.now(),
): MTaskDetailVm {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return NOT_FOUND;
  const facts = buildTaskDetailFacts(task, tasks, verification);
  return {
    found: true,
    displayId: `T-${task.id}`,
    text: task.text,
    status: task.status,
    template: task.template,
    statusKind: facts.statusKind,
    priority: task.priority,
    approvalNeeded: task.approvalNeeded ?? null,
    approvedAt: task.approvedAt ?? null,
    completedAt: facts.completedAt,
    doneWhen: task.doneWhen,
    blockedBy: task.blockedBy ?? null,
    claim: buildClaim(task, facts.claim, facts.verification),
    deps: buildDependencies(facts.upstream),
    history: buildHistory(facts.verification),
  };
}
