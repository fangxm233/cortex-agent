// input:  Desktop appearance panel with mocked preference providers
// output: Theme-system and accent-control wiring regression coverage
// pos:    Interaction test for desktop appearance settings
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { AppearancePanel } from './AppearancePanel';

const setTheme = vi.fn();
const setAccentHue = vi.fn();

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
});
