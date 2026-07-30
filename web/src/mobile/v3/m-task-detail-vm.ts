// input:  TaskInfo list and task verification evidence
// output: Task approval, claim-thread, deps, and history model
// pos:    Pure view model for the mobile task detail screen
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Maps tasks.list plus tasks.verification into a language-neutral detail model. Only fields backed
// by the DTO are surfaced; missing evidence remains null or empty for an honest view placeholder.
import type { TaskInfo, TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import { displayClaimId } from '@/features/tasks/task-claim';
import { fmtMoney } from '@/mobile/ui/format';

export type MTaskStatusKind = 'in-progress' | 'approval-needed' | 'actionable' | 'blocked' | 'done' | 'waiting';

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

const STATUS_RULES: ReadonlyArray<{ kind: MTaskStatusKind; matches: (task: TaskInfo) => boolean }> = [
  { kind: 'done', matches: (task) => task.status === 'done' },
  { kind: 'blocked', matches: (task) => task.blockedBy != null },
  { kind: 'in-progress', matches: (task) => task.claimedBy != null },
  { kind: 'approval-needed', matches: (task) => task.approvalNeeded === true },
  { kind: 'actionable', matches: (task) => task.actionable },
];

export function taskStatusKind(task: TaskInfo): MTaskStatusKind {
  return STATUS_RULES.find((rule) => rule.matches(task))?.kind ?? 'waiting';
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
  /** Owning task thread id; falls back to dispatch history for an older server. */
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
  /** Real TaskInfo.doneWhen; null → honest gap in the View. */
  doneWhen: string | null;
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
  doneWhen: null,
  claim: null,
  deps: [],
  history: [],
};

function buildClaim(task: TaskInfo, dispatches: TaskDispatchRecord[]): MTaskClaimVm | null {
  if (task.claimedBy == null) return null;
  const newest = dispatches[0] ?? null;
  const parts: string[] = [];
  const elapsed = formatElapsed(newest?.durationMs ?? null);
  if (elapsed) parts.push(elapsed);
  if (newest?.cost != null) parts.push(fmtMoney(newest.cost));
  return {
    template: task.template,
    threadId: displayClaimId(task),
    claimedBy: null,
    meta: parts.length > 0 ? parts.join(' · ') : null,
  };
}

function buildDependencies(task: TaskInfo, byId: ReadonlyMap<string, TaskInfo>): MTaskDepVm[] {
  return task.dependsOn.map((id) => {
    const dependency = byId.get(id);
    return {
      id,
      displayId: `T-${id}`,
      statusKind: dependency ? taskStatusKind(dependency) : 'waiting',
      known: dependency != null,
    };
  });
}

function buildHistory(dispatches: TaskDispatchRecord[], completingId: string | null): MTaskHistoryRowVm[] {
  return dispatches.map((dispatch) => ({
    startedAt: dispatch.startedAt,
    type: dispatch.type,
    status: dispatch.status,
    isCompleting: completingId != null && dispatch.executionId === completingId,
  }));
}

export function buildTaskDetailVm(
  taskId: string,
  tasks: TaskInfo[],
  verification: TaskVerificationInfo | null,
  _now: number = Date.now(),
): MTaskDetailVm {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const task = byId.get(taskId);
  if (!task) return NOT_FOUND;
  const dispatches = verification?.dispatches ?? [];
  const completingId = verification?.evidence.completingExecutionId ?? null;
  return {
    found: true,
    displayId: `T-${task.id}`,
    text: task.text,
    status: task.status,
    template: task.template,
    statusKind: taskStatusKind(task),
    priority: task.priority,
    approvalNeeded: task.approvalNeeded ?? null,
    approvedAt: task.approvedAt ?? null,
    doneWhen: task.doneWhen,
    claim: buildClaim(task, dispatches),
    deps: buildDependencies(task, byId),
    history: buildHistory(dispatches, completingId),
  };
}
