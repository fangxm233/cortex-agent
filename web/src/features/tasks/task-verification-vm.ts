// input:  task verification DTO, canonical facts, and shared desktop formatters
// output: Desktop evidence copy slots and themed dispatch rows
// pos:    Desktop-only verification projection over shared task detail semantics
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Pure view-model for the task modal's "Done-when verification" (Card B) + "Dispatch history"
// (Card C), consuming the real `tasks.verification` scope. Framework-free so the DTO→render mapping
// — including every honest-placeholder branch — is unit-tested in isolation. Consumed by TaskModal.tsx.
//
// Discipline: only REAL fields are surfaced. Where the scope returns null / [] (task not completed,
// no completion note, no completing execution, never dispatched), the VM exposes explicit flags so
// the component renders an honest placeholder — never fabricated evidence.

import type { TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import { formatUsd } from '@/lib/format';
import { buildTaskVerificationFacts } from './task-detail-facts';

// dispatch/execution status → dot color (mirrors the modal's palette in task-modal-vm.ts).
function statusColor(status: TaskDispatchRecord['status']): string {
  switch (status) {
    case 'completed':
      return 'var(--state-done)';
    case 'failed':
      return 'var(--state-fail)';
    case 'running':
      return 'var(--state-run)';
    case 'stale':
      return 'var(--proto-amber)';
    default:
      return 'var(--proto-muted-2)'; // cancelled
  }
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function formatCost(cost: number | null): string {
  if (cost == null || !Number.isFinite(cost)) return '—';
  return formatUsd(cost);
}

export function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface DispatchRowVm {
  executionId: string;
  type: 'local' | 'dispatch';
  status: TaskDispatchRecord['status'];
  statusColor: string;
  machine: string;
  threadId: string | null;
  when: string;
  duration: string;
  cost: string;
  /** True for the execution the scope identified as the one that completed the task. */
  isCompleting: boolean;
}

export interface TaskVerificationVm {
  completed: boolean;
  doneWhen: string | null;
  completedAt: string | null;
  completedNote: string | null;
  completingExecutionId: string | null;
  completingOutput: string | null;
  /** True when there is at least one real piece of achievement evidence to show. */
  hasEvidence: boolean;
  dispatches: DispatchRowVm[];
  hasDispatches: boolean;
}

export function buildTaskVerificationVm(info: TaskVerificationInfo): TaskVerificationVm {
  const facts = buildTaskVerificationFacts(info);
  const e = facts.evidence;
  const dispatches: DispatchRowVm[] = facts.dispatches.map(({ dispatch: d, isCompleting }) => ({
    executionId: d.executionId,
    type: d.type,
    status: d.status,
    statusColor: statusColor(d.status),
    machine: d.machine ?? '—',
    threadId: d.threadId,
    when: formatWhen(d.startedAt),
    duration: formatDuration(d.durationMs),
    cost: formatCost(d.cost),
    isCompleting,
  }));
  return {
    completed: e.completed,
    doneWhen: e.doneWhen,
    completedAt: e.completedAt,
    completedNote: e.completedNote,
    completingExecutionId: e.completingExecutionId,
    completingOutput: e.completingOutput,
    hasEvidence: facts.hasEvidence,
    dispatches,
    hasDispatches: dispatches.length > 0,
  };
}
