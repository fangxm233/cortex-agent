// input:  palette parameters and accent preferences
// output: Named palette presets and the active-preset matcher
// pos:    Preset table for the appearance settings
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { DEFAULT_PALETTE, PALETTE_KEYS, type Palette } from './palette';
import { DEFAULT_ACCENT_INTENSITY, type AccentHue, type AccentIntensity } from './theme';

export interface PalettePreset {
  id: string;
  palette: Palette;
  /** `null` selects the built-in indigo rather than a derived hue. */
  accentHue: AccentHue;
  accentIntensity: AccentIntensity;
}

/** A preset writes the whole colour state at once; touching any slider afterwards makes it custom. */
export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: 'default',
    palette: DEFAULT_PALETTE,
    accentHue: null,
    accentIntensity: DEFAULT_ACCENT_INTENSITY,
  },
  {
    // Pure neutral: chroma pulled out of the surfaces entirely, text barely tinted.
    id: 'graphite',
    palette: { bgHue: 264, bgChroma: 0, bgLight: 0, inkHue: 263, inkChroma: 0.3, inkContrast: 0 },
    accentHue: 264,
    accentIntensity: 'soft',
  },
  {
    id: 'sepia',
    palette: { bgHue: 75, bgChroma: 2.4, bgLight: 0, inkHue: 62, inkChroma: 1.8, inkContrast: 0 },
    accentHue: 45,
    accentIntensity: 'normal',
  },
  {
    id: 'indigo',
    palette: { bgHue: 275, bgChroma: 2.2, bgLight: 0, inkHue: 272, inkChroma: 1.5, inkContrast: 0 },
    accentHue: 275,
    accentIntensity: 'normal',
  },
  {
    id: 'forest',
    palette: { bgHue: 150, bgChroma: 2, bgLight: 0, inkHue: 158, inkChroma: 1.3, inkContrast: 0 },
    accentHue: 155,
    accentIntensity: 'normal',
  },
  {
    id: 'rose',
    palette: { bgHue: 10, bgChroma: 2, bgLight: 0, inkHue: 8, inkChroma: 1.3, inkContrast: 0 },
    accentHue: 10,
    accentIntensity: 'normal',
  },
  {
    // Ground pushed down: a high-separation light theme, and true black on OLED in dark mode.
    id: 'deep',
    palette: { bgHue: 264, bgChroma: 1, bgLight: -0.2, inkHue: 263, inkChroma: 1, inkContrast: 0.02 },
    accentHue: 264,
    accentIntensity: 'normal',
  },
];

/** The preset id matching the current colour state exactly, else `null` for a custom palette. */
export function matchPreset(
  palette: Palette,
  accentHue: AccentHue,
  accentIntensity: AccentIntensity,
): string | null {
  const found = PALETTE_PRESETS.find(
    (preset) =>
      preset.accentHue === accentHue &&
      preset.accentIntensity === accentIntensity &&
      PALETTE_KEYS.every((key) => preset.palette[key] === palette[key]),
  );
  return found?.id ?? null;
}
