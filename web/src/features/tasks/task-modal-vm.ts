// input:  task DTO and project task list
// output: Theme-aware fields, runtime pill, deps, action guards
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
// Real: id · title · status pill · priority color · template · claimed-by · why · doneWhen ·
// dependencies join.

import type { TaskInfo } from '@cortex-agent/ui-contract';

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

type StatusKind = 'done' | 'blocked' | 'in-progress' | 'actionable' | 'waiting';

// Derive the prototype's status vocabulary from the real TaskInfo shape (status/actionable/
// claimedBy/blockedBy), in precedence order (prototype L2574-2579).
function statusKind(t: TaskInfo): StatusKind {
  if (t.status === 'done') return 'done';
  if (t.blockedBy != null) return 'blocked';
  if (t.claimedBy != null) return 'in-progress';
  if (t.actionable) return 'actionable';
  return 'waiting';
}

function statusPill(t: TaskInfo): TaskModalPill {
  switch (statusKind(t)) {
    case 'done':
      return { bg: '#E9F4EE', fg: '#23854F', text: '✓ done' };
    case 'blocked':
      return { bg: '#FBEDEB', fg: '#C03D33', text: 'blocked' };
    case 'in-progress':
      return { bg: '#EEF0FA', fg: '#4655D4', text: `● in-progress · ${t.claimedBy}` };
    case 'actionable':
      return { bg: '#EEF0FA', fg: '#4655D4', text: 'actionable' };
    default:
      return { bg: '#F1F2F5', fg: '#8A93A2', text: 'waiting on deps' };
  }
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

export function buildTaskModalVm(task: TaskInfo, all: TaskInfo[]): TaskModalVm {
  const byId = new Map(all.map((t) => [t.id, t]));

  const fields: TaskModalField[] = [
    {
      k: 'priority',
      v: task.priority,
      vColor: task.priority === 'high' ? '#C03D33' : '#191C22',
    },
    { k: 'status', v: task.status, vColor: 'var(--proto-ink)' },
    { k: 'template', v: task.template, vColor: 'var(--proto-ink)' },
    { k: 'gpu', v: '—', vColor: '#B6BDC9' },
    {
      k: 'claimed-by',
      v: task.claimedBy ?? '—',
      vColor: task.claimedBy != null ? '#4655D4' : '#B6BDC9',
    },
  ];
  const upstream: TaskModalDep[] = task.dependsOn.map((id) => {
    const dep = byId.get(id);
    const done = dep?.status === 'done';
    return {
      id,
      name: dep?.text ?? '—',
      dotColor: depDot(dep),
      idColor: '#4655D4',
      label: done ? 'upstream · done' : 'upstream',
      bg: '#FBFBFC',
      border: '#EFF1F5',
    };
  });
  const downstream: TaskModalDep[] = all
    .filter((t) => t.id !== task.id && t.dependsOn.includes(task.id))
    .map((t) => ({
      id: t.id,
      name: t.text,
      dotColor: depDot(t),
      idColor: '#4655D4',
      label: 'downstream',
      bg: '#FBFBFC',
      border: '#EFF1F5',
    }));

  const completable = task.status !== 'done' && task.blockedBy == null;

  return {
    id: task.id,
    title: task.text,
    pill: statusPill(task),
    priColor: priorityColor(task.priority),
    fields,
    deps: [...upstream, ...downstream],
    hasDependencies: upstream.length + downstream.length > 0,
    canUnblock: task.blockedBy != null,
    completable,
    completeBg: completable ? '#4655D4' : '#B6BDC9',
    completeLabel: task.status === 'done' ? 'Completed' : 'Complete',
  };
}
