import type { TaskInfo, TaskVerificationInfo } from '@cortex-agent/ui-contract';
import {
  buildTaskDetailFacts,
  type TaskDependencyFacts,
  type TaskDetailFacts,
  type TaskDetailStatusKind,
} from './task-detail-facts';
import { formatTaskTime } from './task-time';
import type { Lang } from '@/i18n';

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

// en keeps the task-store spellings (they double as the field keys agents write); zh translates them.
const TASK_MODAL_COPY = {
  en: {
    done: '✓ done', blocked: 'blocked', approvalNeeded: 'approval-needed', actionable: 'actionable',
    waiting: 'waiting on deps', inProgress: '● in-progress',
    fApprovalNeeded: 'approval-needed', fApprovedAt: 'approved-at', fPriority: 'priority', fStatus: 'status',
    fCompletedAt: 'completed-at', fTemplate: 'template', fGpu: 'gpu', fClaimedBy: 'claimed-by',
    yes: 'true', no: 'false', open: 'open', statusDone: 'done', high: 'high', medium: 'medium', low: 'low',
    upstream: 'upstream', upstreamDone: 'upstream · done', downstream: 'downstream',
    complete: 'Complete', completed: 'Completed',
  },
  zh: {
    done: '✓ 已完成', blocked: '已阻塞', approvalNeeded: '需要审批', actionable: '可执行',
    waiting: '等待依赖', inProgress: '● 进行中',
    fApprovalNeeded: '需要审批', fApprovedAt: '审批时间', fPriority: '优先级', fStatus: '状态',
    fCompletedAt: '完成时间', fTemplate: '模板', fGpu: 'GPU', fClaimedBy: '认领者',
    yes: '是', no: '否', open: '未完成', statusDone: '已完成', high: '高', medium: '中', low: '低',
    upstream: '上游', upstreamDone: '上游 · 已完成', downstream: '下游',
    complete: '完成', completed: '已完成',
  },
} as const;
type TaskModalCopy = (typeof TASK_MODAL_COPY)[Lang];

const STATIC_PILL_TONES: Record<Exclude<TaskDetailStatusKind, 'in-progress'>, [tone: string, word: keyof TaskModalCopy]> = {
  done: ['done', 'done'],
  blocked: ['failed', 'blocked'],
  'approval-needed': ['waiting', 'approvalNeeded'],
  actionable: ['running', 'actionable'],
  waiting: ['cancelled', 'waiting'],
};

function statusPill(facts: TaskDetailFacts, copy: TaskModalCopy): TaskModalPill {
  if (facts.statusKind !== 'in-progress') {
    const [tone, word] = STATIC_PILL_TONES[facts.statusKind];
    return { bg: `var(--pill-${tone}-bg)`, fg: `var(--pill-${tone}-fg)`, text: copy[word] };
  }
  const suffix = facts.claim.displayId ? ` · ${facts.claim.displayId}` : '';
  return { bg: 'var(--pill-running-bg)', fg: 'var(--pill-running-fg)', text: `${copy.inProgress}${suffix}` };
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

function approvalFields(task: TaskInfo, copy: TaskModalCopy): TaskModalField[] {
  const needed = task.approvalNeeded;
  return [
    {
      k: copy.fApprovalNeeded,
      v: needed == null ? '—' : needed ? copy.yes : copy.no,
      vColor: needed === true ? 'var(--pill-waiting-fg)' : 'var(--proto-ink)',
    },
    {
      k: copy.fApprovedAt,
      v: task.approvedAt ?? '—',
      vColor: task.approvedAt ? 'var(--state-done)' : 'var(--proto-muted)',
    },
  ];
}

function taskFields(task: TaskInfo, facts: TaskDetailFacts, copy: TaskModalCopy): TaskModalField[] {
  const claimId = facts.claim.displayId;
  // Verification evidence is authoritative; list data is the rolling-upgrade fallback.
  const completedAt = formatTaskTime(facts.completedAt);
  return [
    { k: copy.fPriority, v: copy[task.priority] ?? task.priority, vColor: task.priority === 'high' ? 'var(--state-fail)' : 'var(--proto-ink)' },
    { k: copy.fStatus, v: task.status === 'done' ? copy.statusDone : task.status === 'open' ? copy.open : task.status, vColor: 'var(--proto-ink)' },
    ...approvalFields(task, copy),
    { k: copy.fCompletedAt, v: completedAt ?? '—', vColor: completedAt ? 'var(--state-done)' : 'var(--proto-muted)' },
    { k: copy.fTemplate, v: task.template, vColor: 'var(--proto-ink)' },
    { k: copy.fGpu, v: '—', vColor: 'var(--proto-muted)' },
    { k: copy.fClaimedBy, v: claimId ?? '—', vColor: claimId ? 'var(--state-run)' : 'var(--proto-muted)' },
  ];
}

function taskDependency(dependency: TaskDependencyFacts, copy: TaskModalCopy): TaskModalDep {
  const done = dependency.statusKind === 'done';
  return {
    id: dependency.id,
    name: dependency.task?.text ?? '—',
    dotColor: depDot(dependency.task ?? undefined),
    idColor: 'var(--state-run)',
    label: dependency.relation === 'upstream' ? (done ? copy.upstreamDone : copy.upstream) : copy.downstream,
    bg: 'var(--proto-rail)',
    border: 'var(--proto-line-2)',
  };
}

export function buildTaskModalVm(
  task: TaskInfo,
  all: TaskInfo[],
  verification: TaskVerificationInfo | null = null,
  lang: Lang = 'en',
): TaskModalVm {
  const copy = TASK_MODAL_COPY[lang];
  const facts = buildTaskDetailFacts(task, all, verification);
  const dependencies = [...facts.upstream, ...facts.downstream].map((dep) => taskDependency(dep, copy));
  const completable = task.status !== 'done' && task.blockedBy == null;
  return {
    id: task.id,
    title: task.text,
    pill: statusPill(facts, copy),
    priColor: priorityColor(task.priority),
    fields: taskFields(task, facts, copy),
    deps: dependencies,
    hasDependencies: dependencies.length > 0,
    canUnblock: task.blockedBy != null,
    completable,
    completeBg: completable ? 'var(--proto-accent)' : 'var(--proto-faint)',
    completeLabel: task.status === 'done' ? copy.completed : copy.complete,
  };
}
