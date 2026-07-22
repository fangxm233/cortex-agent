import { describe, it, expect } from 'vitest';
import { wheelShouldZoom, anchoredZoom, anchoredPinch } from './useZoom';

describe('wheelShouldZoom', () => {
  it('css-zoom (PDF): plain wheel scrolls, does NOT zoom', () => {
    expect(wheelShouldZoom('css-zoom', { ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('css-zoom (PDF): zooms only while Ctrl or ⌘ is held (also matches trackpad pinch)', () => {
    expect(wheelShouldZoom('css-zoom', { ctrlKey: true, metaKey: false })).toBe(true);
    expect(wheelShouldZoom('css-zoom', { ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('transform (image lightbox, no scroll container): wheel always zooms', () => {
    expect(wheelShouldZoom('transform', { ctrlKey: false, metaKey: false })).toBe(true);
    expect(wheelShouldZoom('transform', { ctrlKey: true, metaKey: false })).toBe(true);
  });
});

// The transform-mode content point under the anchor (cursor / pinch midpoint) must stay
// pinned on screen across a scale change. `origin`/`startTopLeft` is the content element's
// on-screen top-left (its transform-origin '0 0'), from getBoundingClientRect() — NOT the
// container's, because the content is centered in the container. Passing the container corner
// (ignoring the centering offset) is the "zoom not centered on cursor" bug.

/** Screen position of a content-local point `p` (unscaled px from the content top-left),
 * given the content on-screen top-left `topLeft` and current scale (transform-origin 0 0). */
function project(topLeft: { x: number; y: number }, scale: number, p: { x: number; y: number }) {
  return { x: topLeft.x + scale * p.x, y: topLeft.y + scale * p.y };
}

describe('anchoredZoom (wheel / double-tap)', () => {
  it('keeps translate unchanged when the cursor sits on the content origin', () => {
    const next = anchoredZoom({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: 100 }, { x: 100, y: 100 });
    expect(next).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it('pins the point under the cursor when the content is offset from the container (the bug)', () => {
    // Content top-left is at (150, 80) on screen — i.e. centered, not at the container corner.
    const prev = { scale: 1, x: 0, y: 0 };
    const origin = { x: 150, y: 80 };
    const cursor = { x: 300, y: 240 };
    // The content-local point currently under the cursor.
    const pLocal = { x: (cursor.x - origin.x) / prev.scale, y: (cursor.y - origin.y) / prev.scale };

    const next = anchoredZoom(prev, 3, cursor, origin);

    // After zoom, the SAME local point must still project to the cursor. Content top-left
    // moved by the translate delta (scale is around origin 0 0, so top-left = origin + Δtranslate).
    const newTopLeft = { x: origin.x + (next.x - prev.x), y: origin.y + (next.y - prev.y) };
    const projected = project(newTopLeft, next.scale, pLocal);
    expect(projected.x).toBeCloseTo(cursor.x, 6);
    expect(projected.y).toBeCloseTo(cursor.y, 6);
  });

  it('resets translation when zooming back to (or below) 1x', () => {
    expect(anchoredZoom({ scale: 1.2, x: -40, y: 30 }, 1, { x: 200, y: 150 }, { x: 100, y: 100 }))
      .toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('anchoredPinch (two-finger)', () => {
  it('does not jump at gesture start (no scale/mid change)', () => {
    const next = anchoredPinch(2, { x: 10, y: 20 }, { x: 100, y: 100 }, { x: 100, y: 100 }, 2, { x: 50, y: 50 });
    expect(next.x).toBeCloseTo(10, 6);
    expect(next.y).toBeCloseTo(20, 6);
  });

  it('pans by the midpoint delta at constant scale', () => {
    const next = anchoredPinch(2, { x: 10, y: 20 }, { x: 100, y: 100 }, { x: 130, y: 90 }, 2, { x: 50, y: 50 });
    expect(next.x).toBeCloseTo(40, 6); // 10 + 30
    expect(next.y).toBeCloseTo(10, 6); // 20 - 10
  });

  it('pins the point under the pinch midpoint through a scale change (centered content)', () => {
    const initialScale = 2;
    const initialTranslate = { x: 0, y: 0 };
    const mid = { x: 260, y: 180 };
    const startTopLeft = { x: 60, y: 40 }; // content on-screen top-left at gesture start
    const pLocal = { x: (mid.x - startTopLeft.x) / initialScale, y: (mid.y - startTopLeft.y) / initialScale };

    const next = anchoredPinch(initialScale, initialTranslate, mid, mid, 4, startTopLeft);

    // startTopLeft = origin(N) + initialTranslate; new top-left = N + next.translate.
    const N = { x: startTopLeft.x - initialTranslate.x, y: startTopLeft.y - initialTranslate.y };
    const newTopLeft = { x: N.x + next.x, y: N.y + next.y };
    const projected = project(newTopLeft, next.scale, pLocal);
    expect(projected.x).toBeCloseTo(mid.x, 6);
    expect(projected.y).toBeCloseTo(mid.y, 6);
  });
});
