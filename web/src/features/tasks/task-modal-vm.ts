// input:  task DTO, project task list, optional verification, and canonical detail facts
// output: Desktop approval fields, themed lifecycle/dependencies, and action guards
// pos:    Desktop-only projection over shared task detail semantics
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Framework-free desktop projection for the task detail modal. Shared facts own lifecycle,
// safe claim fallback, completion source precedence, dependency joins and verification ordering;
// this module retains only desktop labels, theme values and complete/unblock guards.
// `why` / `doneWhen` remain raw TaskInfo fields rendered by TaskModal. The sole prototype data gap
// here is gpu, which is absent from TaskInfo and therefore remains an honest "—".

import type { TaskInfo, TaskVerificationInfo } from '@cortex-agent/ui-contract';
import {
  buildTaskDetailFacts,
  type TaskDependencyFacts,
  type TaskDetailFacts,
  type TaskDetailStatusKind,
} from './task-detail-facts';
import { formatTaskTime } from './task-time';

export interface TaskModalPill {
  bg: string;
  fg: string;
  text: string;
}

export interface TaskModalField {
  k: string;
  v: string;
  vColor: string;
}

export interface TaskModalDep {
  id: string;
  name: string;
  dotColor: string;
  idColor: string;
  label: string;
  bg: string;
  border: string;
}

export interface TaskModalVm {
  id: string;
  title: string;
  pill: TaskModalPill;
  priColor: string;
  fields: TaskModalField[];
  deps: TaskModalDep[];
  hasDependencies: boolean;
  canUnblock: boolean;
  completable: boolean;
  completeBg: string;
  completeLabel: string;
}

const STATIC_PILLS: Record<Exclude<TaskDetailStatusKind, 'in-progress'>, TaskModalPill> = {
  done: { bg: 'var(--pill-done-bg)', fg: 'var(--pill-done-fg)', text: '✓ done' },
  blocked: { bg: 'var(--pill-failed-bg)', fg: 'var(--pill-failed-fg)', text: 'blocked' },
  'approval-needed': { bg: 'var(--pill-waiting-bg)', fg: 'var(--pill-waiting-fg)', text: 'approval-needed' },
  actionable: { bg: 'var(--pill-running-bg)', fg: 'var(--pill-running-fg)', text: 'actionable' },
  waiting: { bg: 'var(--pill-cancelled-bg)', fg: 'var(--pill-cancelled-fg)', text: 'waiting on deps' },
};

function statusPill(facts: TaskDetailFacts): TaskModalPill {
  if (facts.statusKind !== 'in-progress') return STATIC_PILLS[facts.statusKind];
  const suffix = facts.claim.displayId ? ` · ${facts.claim.displayId}` : '';
  return { bg: 'var(--pill-running-bg)', fg: 'var(--pill-running-fg)', text: `● in-progress${suffix}` };
}

// priority → dot / value color (prototype L2606).
function priorityColor(priority: TaskInfo['priority']): string {
  if (priority === 'high') return 'var(--state-fail)';
  if (priority === 'medium') return 'var(--proto-amber)';
  return 'var(--proto-faint)';
}

// A dependency's dot color by its own state (prototype depsMap dot logic).
function depDot(dep: TaskInfo | undefined): string {
  if (!dep) return 'var(--proto-faint)';
  if (dep.status === 'done') return 'var(--state-done)';
  if (dep.blockedBy != null) return 'var(--state-fail)';
  return 'var(--state-run)';
}

function approvalFields(task: TaskInfo): TaskModalField[] {
  const needed = task.approvalNeeded;
  return [
    {
      k: 'approval-needed',
      v: needed == null ? '—' : String(needed),
      vColor: needed === true ? 'var(--pill-waiting-fg)' : 'var(--proto-ink)',
    },
    {
      k: 'approved-at',
      v: task.approvedAt ?? '—',
      vColor: task.approvedAt ? 'var(--state-done)' : 'var(--proto-faint)',
    },
  ];
}

function taskFields(task: TaskInfo, facts: TaskDetailFacts): TaskModalField[] {
  const claimId = facts.claim.displayId;
  // Verification evidence is authoritative; list data is the rolling-upgrade fallback.
  const completedAt = formatTaskTime(facts.completedAt);
  return [
    { k: 'priority', v: task.priority, vColor: task.priority === 'high' ? 'var(--state-fail)' : 'var(--proto-ink)' },
    { k: 'status', v: task.status, vColor: 'var(--proto-ink)' },
    ...approvalFields(task),
    { k: 'completed-at', v: completedAt ?? '—', vColor: completedAt ? 'var(--state-done)' : 'var(--proto-faint)' },
    { k: 'template', v: task.template, vColor: 'var(--proto-ink)' },
    { k: 'gpu', v: '—', vColor: 'var(--proto-faint)' },
    { k: 'claimed-by', v: claimId ?? '—', vColor: claimId ? 'var(--state-run)' : 'var(--proto-faint)' },
  ];
}

function taskDependency(dependency: TaskDependencyFacts): TaskModalDep {
  const done = dependency.statusKind === 'done';
  return {
    id: dependency.id,
    name: dependency.task?.text ?? '—',
    dotColor: depDot(dependency.task ?? undefined),
    idColor: 'var(--state-run)',
    label: dependency.relation === 'upstream' && done ? 'upstream · done' : dependency.relation,
    bg: 'var(--proto-rail)',
    border: 'var(--proto-line-2)',
  };
}

export function buildTaskModalVm(
  task: TaskInfo,
  all: TaskInfo[],
  verification: TaskVerificationInfo | null = null,
): TaskModalVm {
  const facts = buildTaskDetailFacts(task, all, verification);
  const dependencies = [...facts.upstream, ...facts.downstream].map(taskDependency);
  const completable = task.status !== 'done' && task.blockedBy == null;
  return {
    id: task.id,
    title: task.text,
    pill: statusPill(facts),
    priColor: priorityColor(task.priority),
    fields: taskFields(task, facts),
    deps: dependencies,
    hasDependencies: dependencies.length > 0,
    canUnblock: task.blockedBy != null,
    completable,
    completeBg: completable ? 'var(--proto-accent)' : 'var(--proto-faint)',
    completeLabel: task.status === 'done' ? 'Completed' : 'Complete',
  };
}
