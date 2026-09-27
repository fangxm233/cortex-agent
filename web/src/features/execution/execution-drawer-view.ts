import type { ExecutionDetailInfo } from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';

// Pure derivations for the execution drawer (design 09-exec-logs, prototype.dc.html L1542–1562).
// Framework-free → unit-tested; the drawer component stays declarative. These helpers cover the
// header (pill / meta) + the trailing live-clock line.

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

const EXEC_STATUS_WORDS = {
  en: { running: 'running', completed: 'done', failed: 'failed', cancelled: 'cancelled', stale: 'stale' },
  zh: { running: '运行中', completed: '完成', failed: '失败', cancelled: '已取消', stale: '陈旧' },
} as const;

type KnownExecStatus = keyof (typeof EXEC_STATUS_WORDS)['en'];

function isKnownExecStatus(status: string): status is KnownExecStatus {
  return Object.prototype.hasOwnProperty.call(EXEC_STATUS_WORDS.en, status);
}

// Execution status word in the UI language; unknown statuses pass through as-is.
export function execStatusWord(status: string, lang: Lang): string {
  return isKnownExecStatus(status) ? EXEC_STATUS_WORDS[lang][status] : status;
}

const EXEC_GLYPH: Record<KnownExecStatus, string> = {
  running: '●', completed: '✓', failed: '✕', cancelled: '✕', stale: '◦',
};

// Header pill: prototype glyph+label per execution status (L1547/L2665).
export function execPill(status: string, lang: Lang): string {
  return isKnownExecStatus(status) ? `${EXEC_GLYPH[status]} ${execStatusWord(status, lang)}` : status;
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
export function execMeta(detail: ExecutionDetailInfo, lang: Lang): string {
  const endedAt = detail.runtime.endedAt;
  const finished = lang === 'zh' ? `${execClock(endedAt)} 结束` : `finished ${execClock(endedAt)}`;
  const segments = [
    detail.dispatch?.machine ?? null,
    detail.dispatch?.taskId ?? null,
    endedAt ? finished : execStatusWord('running', lang),
  ].filter((s): s is string => s != null && s !== '');
  return segments.join(' · ');
}

// Only a running execution can be Killed (executions.cancel). Terminal states no-op with a toast.
export function isStoppable(status: string): boolean {
  return status === 'running';
}
