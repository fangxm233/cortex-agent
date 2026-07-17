// Pure view-model for the plan full-text reading surface — mobile 6b page (scheme-mobile sec-6)
// and the desktop reading overlay (13c 阅读). The surface renders the REAL plan snapshot as
// markdown; this module owns the scroll-progress math, status labels and meta/gate copy. The
// views own every px/hex.

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

/** Sub-label under 批准并执行 while not fully read (6b) — null at 100%. */
export function approveSubLabel(pct: number, lang: 'zh' | 'en'): string | null {
  if (pct >= 100) return null;
  return lang === 'zh' ? `已读 ${pct}% · 下滑读完或直接批准` : `read ${pct}% · scroll to finish or approve now`;
}
