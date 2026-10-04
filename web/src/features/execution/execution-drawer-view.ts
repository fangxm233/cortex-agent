import type { ExecutionDetailInfo } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';

// Pure derivations for the execution drawer (design 09-exec-logs, prototype.dc.html L1542–1562).
// Framework-free → unit-tested; the drawer component stays declarative. These helpers cover the
// header (pill / meta) + the trailing live-clock line.

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

const EXEC_STATUS_KEY = {
  running: 'execStatusRunning',
  completed: 'execStatusCompleted',
  failed: 'execStatusFailed',
  cancelled: 'execStatusCancelled',
  stale: 'execStatusStale',
} as const;

type KnownExecStatus = keyof typeof EXEC_STATUS_KEY;

function isKnownExecStatus(status: string): status is KnownExecStatus {
  return Object.prototype.hasOwnProperty.call(EXEC_STATUS_KEY, status);
}

// Execution status word in the UI language; unknown statuses pass through as-is.
export function execStatusWord(status: string, L: Vocab): string {
  return isKnownExecStatus(status) ? L[EXEC_STATUS_KEY[status]] : status;
}

const EXEC_GLYPH: Record<KnownExecStatus, string> = {
  running: '●', completed: '✓', failed: '✕', cancelled: '✕', stale: '◦',
};

// Header pill: prototype glyph+label per execution status (L1547/L2665).
export function execPill(status: string, L: Vocab): string {
  return isKnownExecStatus(status) ? `${EXEC_GLYPH[status]} ${execStatusWord(status, L)}` : status;
}

// UTC HH:MM of an ISO timestamp (empty for null). UTC keeps it timezone-stable and matches how
// server-side log/execution timestamps are recorded.
export function execClock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// UTC HH:MM:SS for the trailing cursor line (endedAt if finished, else the last update).
export function execNow(detail: ExecutionDetailInfo): string {
  const iso = detail.runtime.endedAt ?? detail.runtime.updatedAt;
  const d = new Date(iso);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// Header meta line: prototype `gpu-01 · T-041 · finished 07:49` (L1548/L2645). Real substitution:
// machine · taskId · (finished <HH:MM> when ended, else running). Null segments are dropped.
export function execMeta(detail: ExecutionDetailInfo, L: Vocab): string {
  const endedAt = detail.runtime.endedAt;
  const finished = fmt(L.execFinishedAt, { time: execClock(endedAt) });
  const segments = [
    detail.dispatch?.machine ?? null,
    detail.dispatch?.taskId ?? null,
    endedAt ? finished : execStatusWord('running', L),
  ].filter((s): s is string => s != null && s !== '');
  return segments.join(' · ');
}

// Only a running execution can be Killed (executions.cancel). Terminal states no-op with a toast.
export function isStoppable(status: string): boolean {
  return status === 'running';
}
