import type { JSX } from 'react';

// The ＋ mark as line art, for every "add / attach / new" affordance. The text glyph (U+FF0B) hangs
// about 1px below the optical centre of its em box and renders hairline-thin at button sizes, so
// buttons draw the two strokes themselves: geometrically centred, weight independent of the font.
// Inherits `currentColor`, so the caller keeps owning the color and its hover state.

export interface PlusGlyphProps {
  /** Rendered box in px — roughly 0.45x the diameter of the button that holds it. */
  size?: number;
  strokeWidth?: number;
}

export function PlusGlyph({ size = 13, strokeWidth = 1.7 }: PlusGlyphProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <path d="M8 2.4v11.2M2.4 8h11.2" />
    </svg>
  );
}
