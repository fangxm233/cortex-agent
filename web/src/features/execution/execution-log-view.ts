import type { ExecutionDetailInfo } from '@cortex-agent/ui-contract';

// Pure derivations for the execution drawer (design 09-exec-logs, prototype.dc.html L1542–1562).
// Framework-free → unit-tested; the drawer component stays declarative. These helpers cover the
// header (pill / meta) + the trailing live-clock line.

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

// Header pill: prototype glyph+label per execution status (L1547/L2665).
export function execPill(status: string): string {
  switch (status) {
    case 'running':
      return '● running';
    case 'completed':
      return '✓ done';
    case 'failed':
      return '✕ failed';
    case 'cancelled':
      return '✕ cancelled';
    case 'stale':
      return '◦ stale';
    default:
      return status;
  }
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
export function execMeta(detail: ExecutionDetailInfo): string {
  const endedAt = detail.runtime.endedAt;
  const segments = [
    detail.dispatch?.machine ?? null,
    detail.dispatch?.taskId ?? null,
    endedAt ? `finished ${execClock(endedAt)}` : 'running',
  ].filter((s): s is string => s != null && s !== '');
  return segments.join(' · ');
}

// Only a running execution can be Killed (executions.cancel). Terminal states no-op with a toast.
export function isStoppable(status: string): boolean {
  return status === 'running';
}
