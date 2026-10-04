import type { CSSProperties } from 'react';
import type { AttachmentMeta, ViewWidth } from '@/features/attachments/types';

const ORDER: readonly ViewWidth[] = ['narrow', 'wide', 'full'];

/** Ceiling of the `wide` tier: about one and a half prose columns of text width. */
export const VIEW_WIDE_MAX_PX = 1040;

/** The widest tier any view in the group asked for, or null when the group holds no view. */
export function widestViewWidth(attachments: Pick<AttachmentMeta, 'type' | 'viewWidth'>[]): ViewWidth | null {
  let best = -1;
  for (const a of attachments) {
    if (a.type !== 'view') continue;
    best = Math.max(best, Math.max(0, ORDER.indexOf(a.viewWidth ?? 'narrow')));
  }
  return best < 0 ? null : ORDER[best];
}

/**
 * Box of an attachment group that carries a view. `narrow` stays inside the prose column; the wider
 * tiers break out of it onto the pane width the transcript publishes as `--chat-bleed-w` (same
 * mechanism as ChatMarkdown's wide tables), centred by pulling back half the overflow. Without the
 * variable — a host that does not publish it — they fall back to the column width.
 */
export function viewGroupBox(width: ViewWidth): CSSProperties {
  if (width === 'narrow') return { width: '92%', maxWidth: '92%', marginInline: 'auto' };
  const w = width === 'wide'
    ? `min(var(--chat-bleed-w, 100%), ${VIEW_WIDE_MAX_PX}px)`
    : 'var(--chat-bleed-w, 100%)';
  return { width: w, maxWidth: 'none', marginLeft: `calc((100% - ${w}) / 2)` };
}
