// Pure view-model for the task modal's "Dispatch history" (Card C), consuming the real
// `tasks.verification` scope. Framework-free so the DTO→render mapping is testable in isolation.
// Consumed by TaskModal.tsx.
//
// Discipline: only REAL fields are surfaced. Where the scope returns [] (never dispatched), the VM
// exposes an explicit flag so the component renders an honest placeholder — never fabricated rows.

import type { TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import { formatUsd } from '@/lib/format';
import { formatSpanPrecise, type TimeLang } from '@/lib/time-format';
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

/** `12.3s` / `3m 20s` · `12.3秒` / `3分20秒`; `—` when unknown. */
export function formatDuration(ms: number | null, lang: TimeLang): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}${lang === 'zh' ? '秒' : 's'}`;
  return formatSpanPrecise(Math.round(ms / 1000) * 1000, lang);
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
  statusColor: string;
  machine: string;
  when: string;
  duration: string;
  cost: string;
  /** True for the execution the scope identified as the one that completed the task. */
  isCompleting: boolean;
}

export interface TaskVerificationVm {
  dispatches: DispatchRowVm[];
  hasDispatches: boolean;
}

export function buildTaskVerificationVm(info: TaskVerificationInfo, lang: TimeLang): TaskVerificationVm {
  const facts = buildTaskVerificationFacts(info);
  const dispatches: DispatchRowVm[] = facts.dispatches.map(({ dispatch: d, isCompleting }) => ({
    executionId: d.executionId,
    statusColor: statusColor(d.status),
    machine: d.machine ?? '—',
    when: formatWhen(d.startedAt),
    duration: formatDuration(d.durationMs, lang),
    cost: formatCost(d.cost),
    isCompleting,
  }));
  return {
    dispatches,
    hasDispatches: dispatches.length > 0,
  };
}
