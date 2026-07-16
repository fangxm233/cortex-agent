// Pure view-model for the 1h 任务详情 screen (scheme-mobile.dc.html 1h L440-484). Maps the REAL
// `tasks.list` (found by id, scoped to the current project) + `tasks.verification` (done-when evidence
// + per-task dispatch history) into the drill page's structured, language-neutral shape. The View
// (MTaskDetailView) localizes the enum kinds; this module stays framework- and copy-free so the
// DTO→render mapping — including every honest-placeholder branch — is unit-tested in isolation.
//
// Discipline (守则11 / honest gaps): only REAL fields are surfaced. 来源 会话 (source session) has no
// DTO field → not modeled. 步骤 N/M (step fraction) has no source → not modeled. The scheme's
// T-041/thr_8f2c/T-038 are MOCKS. Where a source is null/[], the flag/null is exposed so the View
// renders an honest placeholder, never fabricated data.
import type { TaskInfo, TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import { fmtMoney } from '@/mobile/ui/format';

export type MTaskStatusKind = 'in-progress' | 'actionable' | 'blocked' | 'done' | 'waiting';

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

// Derive the status vocabulary from the real TaskInfo shape, precedence top→down (mirrors the desktop
// task-modal-vm statusKind + the mobile classifier). done → blocked → in-progress → actionable → waiting.
export function taskStatusKind(t: TaskInfo): MTaskStatusKind {
  if (t.status === 'done') return 'done';
  if (t.blockedBy != null) return 'blocked';
  if (t.claimedBy != null) return 'in-progress';
  if (t.actionable) return 'actionable';
  return 'waiting';
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
  /** Newest dispatch thread id (for `打开 ›` → /m/thread/:id); null when no dispatch carries one. */
  threadId: string | null;
  /** Raw claimer id (task store claimed-by) — the label fallback when there is no thread id. */
  claimedBy: string;
  /** `<elapsed> · <cost>` from the newest dispatch; parts with no source omitted; null when neither. */
  meta: string | null;
}

export interface MTaskDetailVm {
  found: boolean;
  /** `T-<id>` — real task id. */
  displayId: string;
  /** Real TaskInfo.text. */
  text: string;
  statusKind: MTaskStatusKind;
  priority: TaskInfo['priority'];
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
  statusKind: 'waiting',
  priority: 'medium',
  doneWhen: null,
  claim: null,
  deps: [],
  history: [],
};

export function buildTaskDetailVm(
  taskId: string,
  tasks: TaskInfo[],
  verification: TaskVerificationInfo | null,
  _now: number = Date.now(),
): MTaskDetailVm {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const task = byId.get(taskId);
  if (!task) return NOT_FOUND;

  const dispatches = verification?.dispatches ?? [];
  const completingId = verification?.evidence.completingExecutionId ?? null;

  // Claim-thread card — shown only when claimed. Thread id + meta come from the REAL dispatch join.
  let claim: MTaskClaimVm | null = null;
  if (task.claimedBy != null) {
    const newest = dispatches[0] ?? null; // dispatches are newest-first
    const threadId = dispatches.find((d) => d.threadId != null)?.threadId ?? null;
    const parts: string[] = [];
    const elapsed = formatElapsed(newest?.durationMs ?? null);
    if (elapsed) parts.push(elapsed);
    if (newest?.cost != null) parts.push(fmtMoney(newest.cost));
    claim = {
      template: task.template,
      threadId,
      claimedBy: task.claimedBy,
      meta: parts.length ? parts.join(' · ') : null,
    };
  }

  const deps: MTaskDepVm[] = task.dependsOn.map((id) => {
    const dep = byId.get(id);
    return {
      id,
      displayId: `T-${id}`,
      statusKind: dep ? taskStatusKind(dep) : 'waiting',
      known: dep != null,
    };
  });

  const history: MTaskHistoryRowVm[] = dispatches.map((d) => ({
    startedAt: d.startedAt,
    type: d.type,
    status: d.status,
    isCompleting: completingId != null && d.executionId === completingId,
  }));

  return {
    found: true,
    displayId: `T-${task.id}`,
    text: task.text,
    statusKind: taskStatusKind(task),
    priority: task.priority,
    doneWhen: task.doneWhen,
    claim,
    deps,
    history,
  };
}
