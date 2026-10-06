import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { LangSource } from '@/i18n';

vi.mock('@/i18n', async (importOriginal) => {
  const { en } = await import('@/i18n/vocab');
  return { ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en, useVocabOptional: () => en };
});

import { en } from '@/i18n/vocab';
import { DEFAULT_PALETTE } from '@/theme/palette';
import { MAppearanceView } from './MAppearanceView';

function mount(langSource: LangSource): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  const noop = vi.fn();
  act(() => {
    renderer = create(<MAppearanceView lang="en" langSource={langSource} onSetLang={noop}
      theme="system" onSetTheme={noop} palette={DEFAULT_PALETTE} onSetPaletteValue={noop}
      activePreset={null} onPickPreset={noop} onResetPalette={noop}
      accentHue={null} onSetAccentHue={noop} accentIntensity="normal" onSetAccentIntensity={noop}
      glass="subtle" onSetGlass={noop} motionMode="system" onSetMotionMode={noop} onBack={noop} />);
  });
  return renderer;
}

function languageHint(renderer: ReactTestRenderer): string {
  return renderer.root.findAllByProps({ 'data-choice-hint': true })[0].children.join('');
}

describe('mobile Appearance language row', () => {
  it('keeps the usual hint and appends the CORTEX_LANG pin, as on desktop', () => {
    expect(languageHint(mount('env'))).toBe(`${en.stLangHint} ${en.stLangEnvPinned}`);
    expect(languageHint(mount('file'))).toBe(en.stLangHint);
  });

  it('labels the choices from the shared vocab', () => {
    const text = JSON.stringify(mount('file').toJSON());
    expect(text).toContain(en.stLangEnglish);
    expect(text).toContain(en.stLangChinese);
  });
});
