import type { MediaItem } from './MediaViewer';
import type { DocItem } from './DocViewer';

// Pure logic for the PINNED (docked) preview mode — the second way to preview a file on the desktop
// workbench. Default mode is the full-screen modal (MediaViewer / DocViewer); pinning docks the
// preview as a pane to the RIGHT of the chat, splitting the center region into chat | preview, and
// every subsequent preview click swaps the docked pane's content instead of raising a modal.
// Type-only imports here (erased at build time) — no runtime dependency on the viewer components,
// so the providers can import this module without a cycle.

export type PreviewItem = MediaItem | DocItem;

/** localStorage keys — mirrors the `cortex.*` UI-pref convention (theme / lang / railProjectsH). */
export const PREVIEW_PINNED_KEY = 'cortex.previewPinned';
export const PREVIEW_SPLIT_KEY = 'cortex.previewSplit';

/** The preview pane's share of the center region (chat + preview). 0.5 = an even split. */
export const PREVIEW_SPLIT_DEFAULT = 0.5;
export const PREVIEW_SPLIT_MIN = 0.25;
export const PREVIEW_SPLIT_MAX = 0.75;

/** Keep a split ratio inside the band; non-finite input falls back to the even split. */
export function clampPreviewSplit(v: number): number {
  if (!Number.isFinite(v)) return PREVIEW_SPLIT_DEFAULT;
  return Math.min(PREVIEW_SPLIT_MAX, Math.max(PREVIEW_SPLIT_MIN, v));
}

/** Stored split ratio → a usable ratio (default on missing / unparseable, clamped otherwise). */
export function parsePreviewSplit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return PREVIEW_SPLIT_DEFAULT;
  return clampPreviewSplit(Number(raw));
}

/** Stored pinned flag → boolean. Only the explicit '1' restores the docked mode. */
export function parsePreviewPinned(raw: string | null): boolean {
  return raw === '1';
}

/** Pixel floors — a drag must leave BOTH panes usable. The ratio band alone is not enough: at 0.75
 *  of a 860px region the chat collapses to ~215px and its composer wraps. */
export const PREVIEW_MIN_PX = 260;
export const CHAT_MIN_PX = 380;

/** Divider drag → the preview pane's new share. The divider is the pane's LEFT edge, so the share
 *  is the distance from the pointer to the region's right edge. Clamped by the ratio band AND by
 *  both pixel floors (the floors are dropped when the region is too narrow to honour them, so the
 *  clamp never inverts); unmeasurable region → default. */
export function splitFromDrag(regionLeft: number, regionWidth: number, clientX: number): number {
  if (!(regionWidth > 0)) return PREVIEW_SPLIT_DEFAULT;
  const raw = (regionLeft + regionWidth - clientX) / regionWidth;
  let lo = PREVIEW_SPLIT_MIN;
  let hi = PREVIEW_SPLIT_MAX;
  if (regionWidth >= PREVIEW_MIN_PX + CHAT_MIN_PX) {
    lo = Math.max(lo, PREVIEW_MIN_PX / regionWidth);
    hi = Math.min(hi, 1 - CHAT_MIN_PX / regionWidth);
    if (lo > hi) [lo, hi] = [PREVIEW_SPLIT_MIN, PREVIEW_SPLIT_MAX];
  }
  if (!Number.isFinite(raw)) return PREVIEW_SPLIT_DEFAULT;
  return Math.min(hi, Math.max(lo, raw));
}

/** pdf/text render through the DocViewer bodies; image/video render as media. */
export function isDocPreviewItem(item: PreviewItem): item is DocItem {
  return item.kind === 'pdf' || item.kind === 'text';
}

/** The workspace path a docked preview can download, or null for a local composer object URL
 *  (staged file with no workspace path yet) — the pane hides its download action then. */
export function previewDownloadPath(item: PreviewItem): string | null {
  return item.path ?? null;
}
