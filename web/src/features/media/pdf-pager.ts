// Pure page-math helpers for the DocViewer PDF pager (page counter + jump-to-page + prev/next).
// Kept side-effect-free so the paging logic is unit-tested in isolation (the canvas render + scroll
// wiring lives in DocViewer.PdfBody). See doc-kind.ts for the same Pure-(TDD) pattern.

/** A rendered page's vertical box within the scroll content (both in px). */
export interface PageBox {
  top: number;
  height: number;
}

/** Clamp an arbitrary (possibly NaN/float/out-of-range) page number into [1, total]. */
export function clampPage(n: number, total: number): number {
  if (total <= 0) return 1;
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.floor(n)), total);
}

/**
 * Given each page's box and the current scroll position, return the 1-based page occupying the
 * vertical center of the viewport — the page the reader is actually looking at. Pages are assumed
 * in document order (ascending `top`).
 */
export function pageAtScroll(pages: PageBox[], scrollTop: number, viewportHeight: number): number {
  if (pages.length === 0) return 1;
  const mid = scrollTop + viewportHeight / 2;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (mid < p.top + p.height) return i + 1;
  }
  return pages.length;
}

/** Parse a user-typed jump value into a valid page, or null when it isn't a usable number. */
export function parseJump(raw: string, total: number): number | null {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return clampPage(n, total);
}
