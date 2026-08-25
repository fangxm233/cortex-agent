// input:  Desktop appearance panel with mocked preference providers
// output: Theme, palette, preset, accent, and motion wiring coverage
// pos:    Interaction test for desktop appearance settings
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { DEFAULT_PALETTE } from '@/theme';
import { AppearancePanel } from './AppearancePanel';

const setTheme = vi.fn();
const setAccentHue = vi.fn();
const setAccentIntensity = vi.fn();
const setPaletteValue = vi.fn();
const applyPreset = vi.fn();
const resetPalette = vi.fn();
const setMotionMode = vi.fn();

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>();
  return { ...actual, useVocab: () => en, useLang: () => 'en', useSetLang: () => vi.fn() };
});

vi.mock('@/theme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/theme')>();
  return {
    ...actual,
    useTheme: () => 'light',
    useSetTheme: () => setTheme,
    useAccentHue: () => null,
    useSetAccentHue: () => setAccentHue,
    useAccentIntensity: () => 'normal',
    useSetAccentIntensity: () => setAccentIntensity,
    usePalette: () => actual.DEFAULT_PALETTE,
    useSetPaletteValue: () => setPaletteValue,
    useActivePreset: () => 'default',
    useApplyPreset: () => applyPreset,
    useResetPalette: () => resetPalette,
    useMotionMode: () => 'system',
    useSetMotionMode: () => setMotionMode,
  };
});

describe('AppearancePanel', () => {
  it('exposes system theme and routes accent selections', () => {
    const renderer = create(<AppearancePanel />);

    act(() => renderer.root.findByProps({ 'data-theme-option': 'system' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-accent-preset': 'teal' }).props.onClick());

    expect(setTheme).toHaveBeenCalledWith('system');
    expect(setAccentHue).toHaveBeenCalledWith(190);
  });

  it('routes palette presets, sliders, and reset', () => {
    const renderer = create(<AppearancePanel />);

    act(() => renderer.root.findByProps({ 'data-palette-preset': 'sepia' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-palette-slider': 'bgHue' })
      .props.onChange({ target: { value: '150' } }));
    act(() => renderer.root.findByProps({ 'data-palette-reset': true }).props.onClick());

    expect(applyPreset).toHaveBeenCalledWith('sepia');
    expect(setPaletteValue).toHaveBeenCalledWith('bgHue', 150);
    expect(resetPalette).toHaveBeenCalled();
  });

  // Every parameter needs a slider, or part of the palette becomes unreachable from the UI.
  it('exposes a slider for every palette parameter', () => {
    const renderer = create(<AppearancePanel />);

    for (const key of Object.keys(DEFAULT_PALETTE)) {
      expect(renderer.root.findAllByProps({ 'data-palette-slider': key })).not.toHaveLength(0);
    }
  });

  it('routes intensity and motion selections', () => {
    const renderer = create(<AppearancePanel />);

    act(() => renderer.root.findByProps({ 'data-accent-intensity-option': 'vivid' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-motion-option': 'reduced' }).props.onClick());

    expect(setAccentIntensity).toHaveBeenCalledWith('vivid');
    expect(setMotionMode).toHaveBeenCalledWith('reduced');
  });
});
