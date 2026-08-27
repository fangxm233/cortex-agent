// input:  TaskInfo list and optional task verification DTO
// output: locale- and CSS-free lifecycle, claim, completion, dependency, and dispatch facts
// pos:    Canonical desktop/mobile task detail semantics
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type {
  TaskDispatchRecord,
  TaskInfo,
  TaskVerificationInfo,
} from '@cortex-agent/ui-contract';
import { displayClaimId } from './task-claim';

export type TaskDetailStatusKind =
  | 'done'
  | 'blocked'
  | 'in-progress'
  | 'approval-needed'
  | 'actionable'
  | 'waiting';

export interface TaskClaimFacts {
  claimed: boolean;
  /** Persisted owner, except the internal dispatcher sentinel. */
  id: string | null;
  /** Current owning thread, including the legacy thread-shaped owner fallback. */
  threadId: string | null;
  /** Thread first, then a safe direct owner. */
  displayId: string | null;
}

export interface TaskDependencyFacts {
  relation: 'upstream' | 'downstream';
  id: string;
  known: boolean;
  task: TaskInfo | null;
  statusKind: TaskDetailStatusKind | null;
}

export interface TaskDispatchFacts {
  dispatch: TaskDispatchRecord;
  isCompleting: boolean;
}

export interface TaskVerificationFacts {
  evidence: TaskVerificationInfo['evidence'];
  hasEvidence: boolean;
  dispatches: TaskDispatchFacts[];
  newestDispatch: TaskDispatchFacts | null;
  completingExecution: TaskDispatchFacts | null;
}

export interface TaskDetailFacts {
  task: TaskInfo;
  statusKind: TaskDetailStatusKind;
  claim: TaskClaimFacts;
  completedAt: string | null;
  upstream: TaskDependencyFacts[];
  downstream: TaskDependencyFacts[];
  verification: TaskVerificationFacts | null;
}

export function taskDetailStatusKind(task: TaskInfo): TaskDetailStatusKind {
  if (task.status === 'done') return 'done';
  if (task.blockedBy != null) return 'blocked';
  if (task.claimedBy != null) return 'in-progress';
  if (task.approvalNeeded === true) return 'approval-needed';
  return task.actionable ? 'actionable' : 'waiting';
}

function taskClaimFacts(task: TaskInfo): TaskClaimFacts {
  const claimed = task.claimedBy != null;
  const id = claimed && task.claimedBy !== 'task-dispatcher' ? task.claimedBy : null;
  const threadId = claimed ? displayClaimId(task) : null;
  return { claimed, id, threadId, displayId: threadId ?? id };
}

function dispatchInstant(dispatch: TaskDispatchRecord): number {
  const parsed = Date.parse(dispatch.startedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function sortedDispatches(dispatches: TaskDispatchRecord[]): TaskDispatchRecord[] {
  return dispatches
    .map((dispatch, index) => ({ dispatch, index }))
    .sort((a, b) => dispatchInstant(b.dispatch) - dispatchInstant(a.dispatch) || a.index - b.index)
    .map(({ dispatch }) => dispatch);
}

export function buildTaskVerificationFacts(info: TaskVerificationInfo): TaskVerificationFacts {
  const completingId = info.evidence.completingExecutionId;
  const dispatches = sortedDispatches(info.dispatches).map((dispatch) => ({
    dispatch,
    isCompleting: completingId != null && dispatch.executionId === completingId,
  }));
  const evidence = info.evidence;
  return {
    evidence,
    hasEvidence: evidence.completed && (
      evidence.completedNote != null || evidence.completingOutput != null || evidence.completedAt != null
    ),
    dispatches,
    newestDispatch: dispatches[0] ?? null,
    completingExecution: dispatches.find((item) => item.isCompleting) ?? null,
  };
}

function dependencyFacts(
  relation: TaskDependencyFacts['relation'],
  id: string,
  dependency: TaskInfo | undefined,
): TaskDependencyFacts {
  return {
    relation, id, known: dependency != null, task: dependency ?? null,
    statusKind: dependency ? taskDetailStatusKind(dependency) : null,
  };
}

function taskDependencies(task: TaskInfo, all: TaskInfo[]): {
  upstream: TaskDependencyFacts[];
  downstream: TaskDependencyFacts[];
} {
  const byId = new Map(all.map((item) => [item.id, item]));
  const upstream = task.dependsOn.map((id) => dependencyFacts('upstream', id, byId.get(id)));
  const downstream = all
    .filter((item) => item.id !== task.id && item.dependsOn.includes(task.id))
    .map((item) => dependencyFacts('downstream', item.id, item));
  return { upstream, downstream };
}

export function buildTaskDetailFacts(
  task: TaskInfo,
  all: TaskInfo[],
  verification: TaskVerificationInfo | null,
): TaskDetailFacts {
  const verificationFacts = verification ? buildTaskVerificationFacts(verification) : null;
  const dependencies = taskDependencies(task, all);
  return {
    task,
    statusKind: taskDetailStatusKind(task),
    claim: taskClaimFacts(task),
    completedAt: verificationFacts?.evidence.completedAt ?? task.completedAt ?? null,
    ...dependencies,
    verification: verificationFacts,
  };
}
