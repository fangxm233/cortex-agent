// input:  palette clamping, preset table, and localized preset copy
// output: Regression coverage for palette parameters and presets
// pos:    Unit tests for the palette model
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import { en, zh } from '@/i18n/vocab';
import {
  DEFAULT_PALETTE,
  PALETTE_KEYS,
  PALETTE_RANGES,
  applyPalette,
  clampPalette,
  isDefaultPalette,
  parseStoredPalette,
  readStoredPalette,
  storePalette,
} from './palette';
import { PALETTE_PRESETS, matchPreset } from './palette-presets';

describe('clampPalette', () => {
  it('fills missing fields and forces every value into range', () => {
    const clamped = clampPalette({ bgHue: 999, bgChroma: -5, inkContrast: 'x' });

    expect(clamped.bgHue).toBe(PALETTE_RANGES.bgHue.max);
    expect(clamped.bgChroma).toBe(PALETTE_RANGES.bgChroma.min);
    expect(clamped.inkContrast).toBe(DEFAULT_PALETTE.inkContrast);
    expect(Object.keys(clamped).sort()).toEqual([...PALETTE_KEYS].sort());
  });

  // Snapping to the step reintroduces float noise; a stored 0.15000000000000002 would never again
  // compare equal to a preset and the UI would read "custom" forever.
  it('snaps to the step without float dust', () => {
    expect(clampPalette({ ...DEFAULT_PALETTE, bgChroma: 2.4300001 }).bgChroma).toBe(2.45);
    expect(clampPalette({ ...DEFAULT_PALETTE, bgLight: -0.1234 }).bgLight).toBe(-0.125);
  });

  it('treats unparseable storage as the default palette', () => {
    expect(parseStoredPalette(null)).toEqual(DEFAULT_PALETTE);
    expect(parseStoredPalette('{oops')).toEqual(DEFAULT_PALETTE);
    expect(isDefaultPalette(parseStoredPalette('{}'))).toBe(true);
  });
});

describe('palette persistence', () => {
  it('drops the entry when the palette is back at the default', () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal('window', {
      localStorage: { getItem: vi.fn(() => '{"bgHue":150}'), setItem, removeItem },
    });

    expect(readStoredPalette().bgHue).toBe(150);
    storePalette({ ...DEFAULT_PALETTE, bgHue: 150 });
    storePalette(DEFAULT_PALETTE);

    expect(setItem).toHaveBeenCalledWith('cortex.palette', expect.stringContaining('150'));
    expect(removeItem).toHaveBeenCalledWith('cortex.palette');
    vi.unstubAllGlobals();
  });

  it('writes only the parameters that differ from the stylesheet default', () => {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty, removeProperty }, appendChild: vi.fn() },
      querySelector: vi.fn(() => null),
    });

    applyPalette({ ...DEFAULT_PALETTE, bgHue: 150 });

    expect(setProperty).toHaveBeenCalledWith('--bg-hue', '150');
    expect(removeProperty).toHaveBeenCalledWith('--bg-chroma');
    expect(setProperty).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('palette presets', () => {
  it('matches a preset exactly and reports custom otherwise', () => {
    const preset = PALETTE_PRESETS.find((entry) => entry.id === 'sepia')!;

    expect(matchPreset(preset.palette, preset.accentHue, preset.accentIntensity)).toBe('sepia');
    expect(matchPreset({ ...preset.palette, bgHue: 1 }, preset.accentHue, preset.accentIntensity))
      .toBeNull();
  });

  it('treats the shipped default state as the default preset', () => {
    expect(matchPreset(DEFAULT_PALETTE, null, 'normal')).toBe('default');
  });

  it('stores every preset value already in range', () => {
    for (const preset of PALETTE_PRESETS) {
      expect(clampPalette(preset.palette)).toEqual(preset.palette);
    }
  });

  // A preset with no copy renders its raw id in the settings UI.
  it('has a localized name in both languages for every preset', () => {
    for (const preset of PALETTE_PRESETS) {
      const key = `stPreset${preset.id[0].toUpperCase()}${preset.id.slice(1)}` as keyof typeof en;
      expect(en[key], `missing en copy for preset ${preset.id}`).toBeTruthy();
      expect(zh[key], `missing zh copy for preset ${preset.id}`).toBeTruthy();
    }
  });
});
