// input:  ui-contract interaction status
// output: Plan-reading progress, status, metadata, action sub-label
// pos:    Shared desktop/mobile plan-reading view model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';

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
export function planStatusLabel(status: TranscriptInteractionDetail['status'], lang: 'zh' | 'en'): string {
  const zh = lang === 'zh';
  switch (status) {
    case 'pending': return zh ? '待批' : 'pending';
    case 'approved': return zh ? '已批准' : 'approved';
    case 'rejected': return zh ? '已驳回' : 'rejected';
    case 'cancelled': return zh ? '已取消' : 'cancelled';
    default: return zh ? '已过期' : 'expired';
  }
}

/** `plans/x.md · 128 行 · 待批` (6b header sub-line). A missing path is dropped, never faked. */
export function planMetaLine(filePath: string | null, lineCount: number, statusLabel: string, lang: 'zh' | 'en'): string {
  const lines = lang === 'zh' ? `${lineCount} 行` : `${lineCount} lines`;
  return [filePath, lines, statusLabel].filter(Boolean).join(' · ');
}

/** Approval stays text-only; reading progress is shown by the progress bar. */
export function approveSubLabel(_pct: number, _lang: 'zh' | 'en'): null {
  return null;
}
