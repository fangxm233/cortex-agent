import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';

/**
 * Reading progress as a whole percentage 0..100 — the bottom edge of the viewport over the full
 * scroll height (scheme 6b progress bar + `已读 62%`). Content that does not overflow counts as
 * fully read.
 */
export function readProgressPct(scrollTop: number, clientHeight: number, scrollHeight: number): number {
  if (scrollHeight <= clientHeight) return 100;
  const pct = Math.round(((scrollTop + clientHeight) / scrollHeight) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Short status label for the 6b header meta line + pill. */
export function planStatusLabel(
  status: TranscriptInteractionDetail['status'],
  L: Pick<Vocab, 'ixStatusPending' | 'ixStatusApproved' | 'ixStatusRejected' | 'ixStatusCancelled' | 'ixStatusExpired'>,
): string {
  switch (status) {
    case 'pending': return L.ixStatusPending;
    case 'approved': return L.ixStatusApproved;
    case 'rejected': return L.ixStatusRejected;
    case 'cancelled': return L.ixStatusCancelled;
    default: return L.ixStatusExpired;
  }
}

/** `plans/x.md · 128 行 · 待批` (6b header sub-line). A missing path is dropped, never faked. */
export function planMetaLine(filePath: string | null, lineCount: number, statusLabel: string, L: Pick<Vocab, 'cmLines'>): string {
  const lines = fmt(L.cmLines, { n: lineCount });
  return [filePath, lines, statusLabel].filter(Boolean).join(' · ');
}
