// input:  stored dock/split values and divider drag geometry
// output: bounded split/dock parsing and drag-to-share arithmetic
// pos:    pure dock geometry; pane-size constants stay presentation-internal
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// The DOCK is the workbench's fourth pane: it splits the center region into chat | dock and holds
// one tab strip of file previews and live web pages (see `dock-tabs.ts`). This module is only its
// geometry — how wide it is, and how a divider drag maps to that width.

/** localStorage keys — `cortex.*` UI-pref convention. The names predate the dock rename and are
 *  kept verbatim so an existing user's docked/width preference survives the upgrade. */
export const DOCK_OPEN_KEY = 'cortex.previewPinned';
export const DOCK_SPLIT_KEY = 'cortex.previewSplit';

/** The dock's share of the center region (chat + dock). 0.5 = an even split. */
export const DOCK_SPLIT_DEFAULT = 0.5;
export const DOCK_SPLIT_MIN = 0.25;
export const DOCK_SPLIT_MAX = 0.75;

/** Keep a split ratio inside the band; non-finite input falls back to the even split. */
export function clampDockSplit(v: number): number {
  if (!Number.isFinite(v)) return DOCK_SPLIT_DEFAULT;
  return Math.min(DOCK_SPLIT_MAX, Math.max(DOCK_SPLIT_MIN, v));
}

/** Stored split ratio → a usable ratio (default on missing / unparseable, clamped otherwise). */
export function parseDockSplit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DOCK_SPLIT_DEFAULT;
  return clampDockSplit(Number(raw));
}

/** Stored dock flag → boolean. Only the explicit '1' restores the docked mode. */
export function parseDockOpen(raw: string | null): boolean {
  return raw === '1';
}

/** Pixel floors — a drag must leave BOTH panes usable. The ratio band alone is not enough: at 0.75
 *  of a 860px region the chat collapses to ~215px and its composer wraps. */
const DOCK_MIN_PX = 260;
const CHAT_MIN_PX = 380;

/** Divider drag → the dock pane's new share. The divider is the pane's LEFT edge, so the share
 *  is the distance from the pointer to the region's right edge. Clamped by the ratio band AND by
 *  both pixel floors (the floors are dropped when the region is too narrow to honour them, so the
 *  clamp never inverts); unmeasurable region → default. */
export function splitFromDrag(regionLeft: number, regionWidth: number, clientX: number): number {
  if (!(regionWidth > 0)) return DOCK_SPLIT_DEFAULT;
  const raw = (regionLeft + regionWidth - clientX) / regionWidth;
  let lo = DOCK_SPLIT_MIN;
  let hi = DOCK_SPLIT_MAX;
  if (regionWidth >= DOCK_MIN_PX + CHAT_MIN_PX) {
    lo = Math.max(lo, DOCK_MIN_PX / regionWidth);
    hi = Math.min(hi, 1 - CHAT_MIN_PX / regionWidth);
    if (lo > hi) [lo, hi] = [DOCK_SPLIT_MIN, DOCK_SPLIT_MAX];
  }
  if (!Number.isFinite(raw)) return DOCK_SPLIT_DEFAULT;
  return Math.min(hi, Math.max(lo, raw));
}
