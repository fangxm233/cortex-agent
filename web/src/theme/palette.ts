// input:  localStorage, document root custom properties, chrome-colour sync
// output: Background/foreground palette parameters with parse, persist, apply
// pos:    Device-local palette parameter model
// >>> If I am updated, update my header comment and CORTEX.md <<<

// The six numbers that drive every surface and text colour in public/theme.css. Each token keeps its
// own lightness and chroma from the original palette; these parameters rotate the hue, scale the
// chroma, and offset the lightness of the whole family at once.

import { refreshBrowserThemeColor } from './theme';

export interface Palette {
  /** Hue of every surface, card, rail and divider. */
  bgHue: number;
  /** Multiplier on the (very low) chroma of the background family. 0 is a pure neutral grey. */
  bgChroma: number;
  /** Lightness offset for the background family — full weight on the ground, 0.45 on the surfaces. */
  bgLight: number;
  /** Hue of the text ramp, independent of the background. */
  inkHue: number;
  /** Multiplier on the chroma of the text ramp. */
  inkChroma: number;
  /** Lightness offset that pushes text away from the background (positive = more contrast). */
  inkContrast: number;
}

export type PaletteKey = keyof Palette;

export const PALETTE_STORAGE_KEY = 'cortex.palette';

// Defaults reproduce the shipped palette: the background family collapses onto a single hue at a
// measured worst-case oklab dE of 0.014 (the warm paper ground), every other token within 0.004.
export const DEFAULT_PALETTE: Palette = {
  bgHue: 264,
  bgChroma: 1,
  bgLight: 0,
  inkHue: 263,
  inkChroma: 1,
  inkContrast: 0,
};

export interface PaletteRange {
  min: number;
  max: number;
  step: number;
}

export const PALETTE_RANGES: Record<PaletteKey, PaletteRange> = {
  bgHue: { min: 0, max: 359, step: 1 },
  bgChroma: { min: 0, max: 4, step: 0.05 },
  bgLight: { min: -0.2, max: 0.05, step: 0.005 },
  inkHue: { min: 0, max: 359, step: 1 },
  inkChroma: { min: 0, max: 4, step: 0.05 },
  inkContrast: { min: -0.04, max: 0.06, step: 0.005 },
};

/** CSS custom property backing each parameter. */
const PALETTE_PROPS: Record<PaletteKey, string> = {
  bgHue: '--bg-hue',
  bgChroma: '--bg-chroma',
  bgLight: '--bg-light',
  inkHue: '--ink-hue',
  inkChroma: '--ink-chroma',
  inkContrast: '--ink-contrast',
};

export const PALETTE_KEYS = Object.keys(DEFAULT_PALETTE) as PaletteKey[];

function clampValue(key: PaletteKey, value: unknown): number {
  const { min, max, step } = PALETTE_RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PALETTE[key];
  const snapped = Math.round(value / step) * step;
  // Snapping reintroduces float noise (0.15000000000000002); round to the step's precision.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
}

/** Coerces arbitrary parsed JSON into a complete, in-range palette. */
export function clampPalette(raw: unknown): Palette {
  const source = (raw ?? {}) as Partial<Record<PaletteKey, unknown>>;
  const result = {} as Palette;
  for (const key of PALETTE_KEYS) result[key] = clampValue(key, source[key]);
  return result;
}

export function parseStoredPalette(stored: string | null): Palette {
  if (!stored) return { ...DEFAULT_PALETTE };
  try {
    return clampPalette(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_PALETTE };
  }
}

export function isDefaultPalette(palette: Palette): boolean {
  return PALETTE_KEYS.every((key) => palette[key] === DEFAULT_PALETTE[key]);
}

export function readStoredPalette(): Palette {
  if (typeof window === 'undefined') return { ...DEFAULT_PALETTE };
  try {
    return parseStoredPalette(window.localStorage.getItem(PALETTE_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PALETTE };
  }
}

export function storePalette(palette: Palette): void {
  if (typeof window === 'undefined') return;
  try {
    if (isDefaultPalette(palette)) window.localStorage.removeItem(PALETTE_STORAGE_KEY);
    else window.localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palette));
  } catch {
    /* private mode */
  }
}

/** Writes the non-default parameters onto the root, clearing the ones back at their CSS default. */
export function applyPalette(palette: Palette): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const key of PALETTE_KEYS) {
    const prop = PALETTE_PROPS[key];
    if (palette[key] === DEFAULT_PALETTE[key]) root.style.removeProperty(prop);
    else root.style.setProperty(prop, String(palette[key]));
  }
  // The dark chrome colour tracks --surface-base, which every one of these parameters can move.
  refreshBrowserThemeColor();
}
