// input:  task DTO and project task list
// output: Approval-aware fields, claim-thread pill, deps, guards
// pos:    Pure view model for the desktop task modal
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Pure view-model for the task detail modal (screen 10a), rebuilt 1:1 from prototype.dc.html
// L1462-1540 + its VM builder (`let tm = …`, L2569-2624). Framework-free so the mapping from the
// real `TaskInfo` DTO → the prototype's exact values is unit-tested in isolation (TDD). Consumed by
// TaskModal.tsx.
//
// why / doneWhen are now real (`TaskInfo.why` / `TaskInfo.doneWhen`) and rendered directly by
// TaskModal (raw passthrough, not derived here); null → honest placeholder in TaskModal.
// DATA GAPS (the DTO exposes less than the mock — rendered structurally, flagged):
//   • done-when verification card — no evidence tRPC scope → placeholder card
//   • dispatch history card       — no per-task execution join → placeholder card
//   • gpu field                   — not on TaskInfo → "—" (matches the T-046 proto-shot)
// Real: id · title · status/approval pill · priority · template · claimed-by · approval fields ·
// completed-at · why · doneWhen · dependencies join.

import type { TaskInfo } from '@cortex-agent/ui-contract';
import { displayClaimId } from './task-claim';
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

type StatusKind = 'done' | 'blocked' | 'in-progress' | 'approval-needed' | 'actionable' | 'waiting';

const STATUS_RULES: ReadonlyArray<{ kind: StatusKind; matches: (task: TaskInfo) => boolean }> = [
  { kind: 'done', matches: (task) => task.status === 'done' },
  { kind: 'blocked', matches: (task) => task.blockedBy != null },
  { kind: 'in-progress', matches: (task) => task.claimedBy != null },
  { kind: 'approval-needed', matches: (task) => task.approvalNeeded === true },
  { kind: 'actionable', matches: (task) => task.actionable },
];

function statusKind(task: TaskInfo): StatusKind {
  return STATUS_RULES.find((rule) => rule.matches(task))?.kind ?? 'waiting';
}

const STATIC_PILLS: Record<Exclude<StatusKind, 'in-progress'>, TaskModalPill> = {
  done: { bg: '#E9F4EE', fg: '#23854F', text: '✓ done' },
  blocked: { bg: '#FBEDEB', fg: '#C03D33', text: 'blocked' },
  'approval-needed': { bg: '#FFF6E5', fg: '#9A6700', text: 'approval-needed' },
  actionable: { bg: '#EEF0FA', fg: '#4655D4', text: 'actionable' },
  waiting: { bg: '#F1F2F5', fg: '#8A93A2', text: 'waiting on deps' },
};

function statusPill(task: TaskInfo): TaskModalPill {
  const kind = statusKind(task);
  if (kind !== 'in-progress') return STATIC_PILLS[kind];
  const claimId = displayClaimId(task);
  const suffix = claimId ? ` · ${claimId}` : '';
  return { bg: '#EEF0FA', fg: '#4655D4', text: `● in-progress${suffix}` };
}

// priority → dot / value color (prototype L2606).
function priorityColor(priority: TaskInfo['priority']): string {
  if (priority === 'high') return '#C03D33';
  if (priority === 'medium') return '#C99A2E';
  return '#B6BDC9';
}

// A dependency's dot color by its own state (prototype depsMap dot logic).
function depDot(dep: TaskInfo | undefined): string {
  if (!dep) return '#B6BDC9';
  if (dep.status === 'done') return '#23854F';
  if (dep.blockedBy != null) return '#C03D33';
  return '#4655D4';
}

function approvalFields(task: TaskInfo): TaskModalField[] {
  const needed = task.approvalNeeded;
  return [
    {
      k: 'approval-needed',
      v: needed == null ? '—' : String(needed),
      vColor: needed === true ? '#9A6700' : 'var(--proto-ink)',
    },
    {
      k: 'approved-at',
      v: task.approvedAt ?? '—',
      vColor: task.approvedAt ? '#23854F' : '#B6BDC9',
    },
  ];
}

function taskFields(task: TaskInfo): TaskModalField[] {
  const claimId = displayClaimId(task);
  // Real `completed-at` from the task store, in the viewer's local wall clock; '—' when never done.
  const completedAt = formatTaskTime(task.completedAt);
  return [
    { k: 'priority', v: task.priority, vColor: task.priority === 'high' ? '#C03D33' : '#191C22' },
    { k: 'status', v: task.status, vColor: 'var(--proto-ink)' },
    ...approvalFields(task),
    { k: 'completed-at', v: completedAt ?? '—', vColor: completedAt ? '#23854F' : '#B6BDC9' },
    { k: 'template', v: task.template, vColor: 'var(--proto-ink)' },
    { k: 'gpu', v: '—', vColor: '#B6BDC9' },
    { k: 'claimed-by', v: claimId ?? '—', vColor: claimId ? '#4655D4' : '#B6BDC9' },
  ];
}

function taskDependencies(task: TaskInfo, all: TaskInfo[]): TaskModalDep[] {
  const byId = new Map(all.map((item) => [item.id, item]));
  const upstream = task.dependsOn.map((id): TaskModalDep => {
    const dependency = byId.get(id);
    return {
      id,
      name: dependency?.text ?? '—',
      dotColor: depDot(dependency),
      idColor: '#4655D4',
      label: dependency?.status === 'done' ? 'upstream · done' : 'upstream',
      bg: '#FBFBFC',
      border: '#EFF1F5',
    };
  });
  const downstream = all
    .filter((item) => item.id !== task.id && item.dependsOn.includes(task.id))
    .map((item): TaskModalDep => ({
      id: item.id, name: item.text, dotColor: depDot(item), idColor: '#4655D4',
      label: 'downstream', bg: '#FBFBFC', border: '#EFF1F5',
    }));
  return [...upstream, ...downstream];
}

export function buildTaskModalVm(task: TaskInfo, all: TaskInfo[]): TaskModalVm {
  const dependencies = taskDependencies(task, all);
  const completable = task.status !== 'done' && task.blockedBy == null;
  return {
    id: task.id,
    title: task.text,
    pill: statusPill(task),
    priColor: priorityColor(task.priority),
    fields: taskFields(task),
    deps: dependencies,
    hasDependencies: dependencies.length > 0,
    canUnblock: task.blockedBy != null,
    completable,
    completeBg: completable ? '#4655D4' : '#B6BDC9',
    completeLabel: task.status === 'done' ? 'Completed' : 'Complete',
  };
}
