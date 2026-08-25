// input:  Mobile appearance copy and preference callbacks
// output: Mobile appearance control wiring regression coverage
// pos:    Interaction test for mobile appearance settings
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PALETTE } from '@/theme';
import { MAppearanceView, type MAppearanceCopy } from './MAppearanceView';

const copy: MAppearanceCopy = {
  title: 'Appearance', language: 'Language',
  theme: 'Theme', themeLight: 'Light', themeDark: 'Dark', themeSystem: 'System',
  palette: {
    presets: 'Presets', custom: 'Custom', reset: 'Reset',
    background: 'Background', foreground: 'Foreground',
    hue: 'Hue', tint: 'Tint', lightness: 'Light', contrast: 'Contrast',
    presetNames: {
      default: 'Default', graphite: 'Graphite', sepia: 'Sepia', indigo: 'Indigo',
      forest: 'Forest', rose: 'Rose', deep: 'Deep',
    },
  },
  accent: 'Accent', accentDefault: 'Default', accentBlue: 'Blue', accentTeal: 'Teal',
  accentViolet: 'Violet', accentRose: 'Rose', accentOrange: 'Orange',
  accentCustom: 'Custom hue', accentReset: 'Reset',
  accentIntensity: 'Intensity', accentIntensitySoft: 'Soft',
  accentIntensityNormal: 'Normal', accentIntensityVivid: 'Vivid',
  motion: 'Motion', motionSystem: 'System', motionFull: 'Full', motionReduced: 'Reduced',
};

function renderAppearance(overrides: Partial<Parameters<typeof MAppearanceView>[0]> = {}) {
  return create(
    <MAppearanceView
      copy={copy} lang="en" onSetLang={() => {}} theme="system" onSetTheme={() => {}}
      palette={DEFAULT_PALETTE} onSetPaletteValue={() => {}}
      activePreset="default" onPickPreset={() => {}} onResetPalette={() => {}}
      accentHue={null} onSetAccentHue={() => {}}
      accentIntensity="normal" onSetAccentIntensity={() => {}}
      motionMode="system" onSetMotionMode={() => {}}
      onBack={() => {}}
      {...overrides}
    />,
  );
}

/** The segmented rows carry no data attribute, so options are located by their visible label. */
function clickOption(renderer: ReturnType<typeof create>, label: string) {
  const button = renderer.root.findAll(
    (node) => node.type === 'button' && node.children.includes(label),
  )[0];
  act(() => button.props.onClick());
}

describe('MAppearanceView', () => {
  it('routes accent preset selections', () => {
    const onSetAccentHue = vi.fn();
    const renderer = renderAppearance({ onSetAccentHue });

    act(() => renderer.root.findByProps({ 'data-accent-preset': 'rose' }).props.onClick());

    expect(onSetAccentHue).toHaveBeenCalledWith(10);
  });

  it('routes palette preset selections', () => {
    const onPickPreset = vi.fn();
    const renderer = renderAppearance({ onPickPreset });

    act(() => renderer.root.findByProps({ 'data-palette-preset': 'deep' }).props.onClick());

    expect(onPickPreset).toHaveBeenCalledWith('deep');
  });

  it('routes accent intensity selections', () => {
    const onSetAccentIntensity = vi.fn();
    clickOption(renderAppearance({ onSetAccentIntensity }), 'Vivid');

    expect(onSetAccentIntensity).toHaveBeenCalledWith('vivid');
  });

  it('routes motion selections', () => {
    const onSetMotionMode = vi.fn();
    clickOption(renderAppearance({ onSetMotionMode }), 'Reduced');

    expect(onSetMotionMode).toHaveBeenCalledWith('reduced');
  });
});
